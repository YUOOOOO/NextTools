use crate::{with_host, HostState};
use nexttools_protocol::McpServerConfig;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_MESSAGE_BYTES: usize = 1_048_576;
#[derive(Clone)]
struct Tool {
    name: String,
    description: String,
    input_schema: Value,
}
struct ProcessConnection {
    child: Child,
    input: ChildStdin,
    responses: mpsc::Receiver<Result<Value, String>>,
    next_id: u64,
}
impl Drop for ProcessConnection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct HttpConnection {
    client: reqwest::blocking::Client,
    url: String,
    session: Option<String>,
    next_id: u64,
}
enum Connection {
    Stdio(ProcessConnection),
    Http(HttpConnection),
}
fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err("会话已取消".into())
    } else {
        Ok(())
    }
}
fn rpc_result(message: Value, id: u64) -> Result<Option<Value>, String> {
    if message.get("id").and_then(Value::as_u64) != Some(id) {
        return Ok(None);
    }
    if let Some(error) = message.get("error") {
        return Err(format!("MCP error: {error}"));
    }
    message
        .get("result")
        .cloned()
        .map(Some)
        .ok_or_else(|| "MCP 响应缺少 result".into())
}
impl ProcessConnection {
    fn send(&mut self, message: Value) -> Result<(), String> {
        writeln!(self.input, "{message}")
            .and_then(|_| self.input.flush())
            .map_err(|e| e.to_string())
    }
    fn request(
        &mut self,
        method: &str,
        params: Value,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let started = Instant::now();
        loop {
            if check_cancelled(cancelled).is_err() || started.elapsed() >= RPC_TIMEOUT {
                let _ = self.child.kill();
                return Err("MCP 调用超时或已取消".into());
            }
            match self.responses.recv_timeout(Duration::from_millis(30)) {
                Ok(Ok(message)) => {
                    if message.get("method").is_some() && message.get("id").is_some() {
                        self.send(json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"Client requests are not supported"}}))?;
                        continue;
                    }
                    if let Some(result) = rpc_result(message, id)? {
                        return Ok(result);
                    }
                }
                Ok(Err(error)) => return Err(error),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err("MCP server 已退出".into()),
            }
        }
    }
}
fn read_json_line(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    loop {
        let chunk = reader.fill_buf().map_err(|e| e.to_string())?;
        if chunk.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        let count = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |n| n + 1);
        if bytes.len() + count > MAX_MESSAGE_BYTES {
            return Err("MCP 响应超过 1 MiB".into());
        }
        let complete = chunk[count - 1] == b'\n';
        bytes.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if complete {
            break;
        }
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("MCP JSON 无效：{e}"))
}
impl HttpConnection {
    fn builder(&self, message: &Value) -> reqwest::blocking::RequestBuilder {
        let mut request = self
            .client
            .post(&self.url)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-03-26")
            .json(message);
        if let Some(session) = &self.session {
            request = request.header("mcp-session-id", session);
        }
        request
    }
    fn request(
        &mut self,
        method: &str,
        params: Value,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        check_cancelled(cancelled)?;
        let id = self.next_id;
        self.next_id += 1;
        let response = self
            .builder(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .send()
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("MCP HTTP {status}"));
        }
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session = Some(session.to_owned());
        }
        let sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if !sse {
            let mut bytes = Vec::new();
            response
                .take((MAX_MESSAGE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > MAX_MESSAGE_BYTES {
                return Err("MCP 响应超过 1 MiB".into());
            }
            check_cancelled(cancelled)?;
            return rpc_result(
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
                id,
            )?
            .ok_or_else(|| "MCP HTTP 响应 id 不匹配".into());
        }
        let mut reader = BufReader::new(response);
        let mut data = String::new();
        let start = Instant::now();
        loop {
            check_cancelled(cancelled)?;
            if start.elapsed() >= RPC_TIMEOUT {
                return Err("MCP SSE 请求超时".into());
            }
            let mut line = String::new();
            if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("MCP SSE 响应结束但无结果".into());
            }
            if line.len() + data.len() > MAX_MESSAGE_BYTES {
                return Err("MCP SSE 响应超过 1 MiB".into());
            }
            if line.trim().is_empty() {
                if !data.is_empty() {
                    let message: Value =
                        serde_json::from_str(data.trim()).map_err(|e| e.to_string())?;
                    data.clear();
                    if let Some(result) = rpc_result(message, id)? {
                        return Ok(result);
                    }
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.trim_start());
                data.push('\n');
            }
        }
    }
    fn notify(&self, method: &str) -> Result<(), String> {
        let response = self
            .builder(&json!({"jsonrpc":"2.0","method":method}))
            .send()
            .map_err(|e| e.to_string())?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("MCP HTTP {}", response.status()))
        }
    }
}
impl Connection {
    fn request(
        &mut self,
        method: &str,
        params: Value,
        cancelled: &AtomicBool,
    ) -> Result<Value, String> {
        match self {
            Self::Stdio(c) => c.request(method, params, cancelled),
            Self::Http(c) => c.request(method, params, cancelled),
        }
    }
    fn notify(&mut self, method: &str) -> Result<(), String> {
        match self {
            Self::Stdio(c) => c.send(json!({"jsonrpc":"2.0","method":method})),
            Self::Http(c) => c.notify(method),
        }
    }
}
#[derive(Default)]
pub struct McpState {
    servers: Mutex<HashMap<String, McpServerConfig>>,
    connections: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    tools: Mutex<HashMap<String, Vec<Tool>>>,
}
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mcp-servers.json"))
}
fn persist(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<McpState>();
    let servers = state.servers.lock().map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&servers.values().collect::<Vec<_>>())
        .map_err(|e| e.to_string())?;
    drop(servers);
    fs::write(config_path(app)?, text).map_err(|e| e.to_string())
}
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::read_to_string(path) {
        Ok(text) => {
            let list: Vec<McpServerConfig> =
                serde_json::from_str(&text).map_err(|e| e.to_string())?;
            *app.state::<McpState>()
                .servers
                .lock()
                .map_err(|e| e.to_string())? = list
                .into_iter()
                .map(|mut s| {
                    s.connected = false;
                    s.error = None;
                    s.tools.clear();
                    (s.id.clone(), s)
                })
                .collect();
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}
pub fn snapshot(app: &AppHandle) -> Result<Vec<McpServerConfig>, String> {
    let state = app.state::<McpState>();
    let mut values = state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    values.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(values)
}
pub fn resources(app: &AppHandle) -> Result<Vec<Value>, String> {
    let state = app.state::<McpState>();
    let servers = state.servers.lock().map_err(|e| e.to_string())?;
    let tools = state.tools.lock().map_err(|e| e.to_string())?;
    Ok(tools.iter().filter_map(|(id,list)|servers.get(id).filter(|s|s.enabled&&s.connected).map(|server|(id,list,server))).flat_map(|(id,list,server)|list.iter().map(move|tool|json!({"name":format!("mcp__{}__{}",id,tool.name),"label":format!("{}: {}",server.name,tool.name),"description":tool.description,"inputSchema":tool.input_schema}))).collect())
}
pub fn invoke(
    app: &AppHandle,
    workspace_id: &str,
    tool_name: &str,
    input: &Value,
    approved: bool,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    with_host(&app.state::<HostState>(), |host| {
        host.authorize_agent_tool(workspace_id, tool_name, approved)
    })?;
    check_cancelled(cancelled)?;
    let (id, tool) = tool_name
        .strip_prefix("mcp__")
        .and_then(|rest| rest.split_once("__"))
        .ok_or("非法 MCP 工具名")?;
    let state = app.state::<McpState>();
    if !state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .is_some_and(|s| s.enabled && s.connected)
    {
        return Err("MCP server 未连接或未启用".into());
    }
    if !state
        .tools
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .is_some_and(|items| items.iter().any(|item| item.name == tool))
    {
        return Err("MCP 工具未授权或已失效".into());
    }
    if !input.is_object() {
        return Err("MCP arguments 必须是对象".into());
    }
    let connection = state
        .connections
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("MCP server 未连接")?;
    let result = connection.lock().map_err(|e| e.to_string())?.request(
        "tools/call",
        json!({"name":tool,"arguments":input}),
        cancelled,
    );
    if let Err(error) = &result {
        if let Some(server) = state.servers.lock().map_err(|e| e.to_string())?.get_mut(id) {
            server.error = Some(error.clone());
        }
    }
    result
}
fn connect(server: &McpServerConfig) -> Result<(Connection, Vec<Tool>), String> {
    let mut connection = if server.transport == "stdio" {
        let command = server
            .command
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or("stdio MCP 缺少 command")?;
        let mut process = Command::new(command);
        process
            .args(&server.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x08000000);
        }
        let mut child = process.spawn().map_err(|e| format!("无法启动 MCP：{e}"))?;
        let input = child.stdin.take().ok_or("MCP stdin 不可用")?;
        let output = child.stdout.take().ok_or("MCP stdout 不可用")?;
        let (tx, rx) = mpsc::sync_channel(64);
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                match read_json_line(&mut reader) {
                    Ok(Some(message)) => {
                        if tx.send(Ok(message)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = tx.send(Err(error));
                        break;
                    }
                }
            }
        });
        Connection::Stdio(ProcessConnection {
            child,
            input,
            responses: rx,
            next_id: 1,
        })
    } else if server.transport == "http" {
        let url = server
            .url
            .clone()
            .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
            .ok_or("HTTP MCP URL 无效")?;
        Connection::Http(HttpConnection {
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?,
            url,
            session: None,
            next_id: 1,
        })
    } else {
        return Err("MCP transport 必须为 stdio 或 http".into());
    };
    let cancelled = AtomicBool::new(false);
    connection.request("initialize",json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"NextTools","version":env!("CARGO_PKG_VERSION")}}),&cancelled)?;
    connection.notify("notifications/initialized")?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let result = connection.request(
            "tools/list",
            cursor
                .as_ref()
                .map(|c| json!({"cursor":c}))
                .unwrap_or_else(|| json!({})),
            &cancelled,
        )?;
        for value in result
            .get("tools")
            .and_then(Value::as_array)
            .ok_or("MCP tools/list 响应无效")?
        {
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .ok_or("MCP tool 缺少 name")?;
            if name.is_empty()
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(format!("MCP 工具名无法安全映射：{name}"));
            }
            let schema = value
                .get("inputSchema")
                .cloned()
                .ok_or("MCP tool 缺少 inputSchema")?;
            if !schema.is_object() {
                return Err("MCP tool inputSchema 无效".into());
            }
            tools.push(Tool {
                name: name.into(),
                description: value
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("MCP tool")
                    .into(),
                input_schema: schema,
            });
        }
        if tools.len() > 4096 {
            return Err("MCP 工具超过 4096 项".into());
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok((connection, tools))
}
#[tauri::command]
pub fn agent_mcp_save(app: AppHandle, mut server: McpServerConfig) -> Result<(), String> {
    if server.id.is_empty()
        || server.id.contains("__")
        || !server
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("MCP server id 无效".into());
    }
    if server.transport != "stdio" && server.transport != "http" {
        return Err("MCP transport 无效".into());
    }
    agent_mcp_disconnect(app.clone(), server.id.clone())?;
    server.connected = false;
    server.error = None;
    server.tools.clear();
    app.state::<McpState>()
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server.id.clone(), server);
    persist(&app)
}
#[tauri::command]
pub async fn agent_mcp_connect(app: AppHandle, id: String, approved: bool) -> Result<(), String> {
    if !approved {
        return Err("连接 MCP 需要明确审批".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        agent_mcp_disconnect(app.clone(), id.clone())?;
        let state = app.state::<McpState>();
        let server = state
            .servers
            .lock()
            .map_err(|e| e.to_string())?
            .get(&id)
            .cloned()
            .ok_or("MCP server 不存在")?;
        if !server.enabled {
            return Err("MCP server 未启用".into());
        }
        let result = connect(&server);
        if let Err(error) = &result {
            if let Some(server) = state
                .servers
                .lock()
                .map_err(|e| e.to_string())?
                .get_mut(&id)
            {
                server.error = Some(error.clone());
            }
            return Err(error.clone());
        }
        let (connection, tools) = result?;
        state
            .connections
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), Arc::new(Mutex::new(connection)));
        state
            .tools
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), tools.clone());
        if let Some(server) = state
            .servers
            .lock()
            .map_err(|e| e.to_string())?
            .get_mut(&id)
        {
            server.connected = true;
            server.error = None;
            server.tools = tools.into_iter().map(|t| t.name).collect();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn agent_mcp_disconnect(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<McpState>();
    state
        .connections
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    state.tools.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(server) = state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(&id)
    {
        server.connected = false;
        server.tools.clear();
    }
    Ok(())
}
#[tauri::command]
pub fn agent_mcp_remove(app: AppHandle, id: String) -> Result<(), String> {
    agent_mcp_disconnect(app.clone(), id.clone())?;
    app.state::<McpState>()
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    persist(&app)
}
