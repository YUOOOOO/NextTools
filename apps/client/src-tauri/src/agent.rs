use crate::{agent_mcp, agent_settings, with_host, HostState};
use nexttools_protocol::{AgentSessionInfo, AgentSessionSummary};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

type Reply = Result<Value, String>;
fn rpc_error_message(error: &Value) -> String {
    error
        .as_str()
        .or_else(|| error.get("message").and_then(Value::as_str))
        .unwrap_or("Runner error")
        .to_owned()
}
struct Runner {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
}
impl Runner {
    fn send(&self, value: Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        writeln!(input, "{value}")
            .and_then(|_| input.flush())
            .map_err(|e| e.to_string())
    }
    fn request(&self, method: &str, params: Value) -> Reply {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), tx);
        let result = self
            .send(json!({"version":1,"id":id,"method":method,"params":params}))
            .and_then(|_| {
                rx.recv_timeout(Duration::from_secs(30))
                    .map_err(|_| format!("Runner 请求超时：{method}"))?
            });
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
        result
    }
}
impl Drop for Runner {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
struct Approval {
    session: String,
    expires: Instant,
    sender: mpsc::Sender<bool>,
}
#[derive(Clone)]
struct Session {
    workspace: String,
    persisted: Option<String>,
    cancelled: Arc<AtomicBool>,
}
#[derive(Default)]
pub(crate) struct AgentState {
    runner: Mutex<Option<Arc<Runner>>>,
    sessions: Mutex<HashMap<String, Session>>,
    approvals: Mutex<HashMap<String, Approval>>,
}
fn runner(app: &tauri::AppHandle) -> Result<Arc<Runner>, String> {
    let state = app.state::<AgentState>();
    let mut slot = state.runner.lock().map_err(|e| e.to_string())?;
    if let Some(runner) = slot.as_ref() {
        if runner
            .child
            .lock()
            .map_err(|e| e.to_string())?
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(runner.clone());
        }
    }
    let (node, entry) = if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let node = if cfg!(target_os = "windows")
            && PathBuf::from("C:/Program Files/nodejs/node.exe").exists()
        {
            PathBuf::from("C:/Program Files/nodejs/node.exe")
        } else {
            PathBuf::from("node")
        };
        (node, root.join("plugins/pi-agent/runner/dist/runner.mjs"))
    } else {
        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("agent-runtime");
        (
            resources.join(if cfg!(target_os = "windows") {
                "node.exe"
            } else {
                "node"
            }),
            resources.join("runner.mjs"),
        )
    };
    #[cfg(target_os = "windows")]
    let node = strip_windows_verbatim_prefix(node);
    #[cfg(target_os = "windows")]
    let entry = strip_windows_verbatim_prefix(entry);
    let mut command = Command::new(node);
    command
        .arg(entry)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Pi Runner：{e}"))?;
    let input = child.stdin.take().ok_or("Runner stdin 不可用")?;
    let output = child.stdout.take().ok_or("Runner stdout 不可用")?;
    let runner = Arc::new(Runner {
        child: Mutex::new(child),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
    });
    let weak = Arc::downgrade(&runner);
    let handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(runner) = weak.upgrade() else { break };
            if value["version"] != 1 {
                continue;
            }
            if let Some(id) = value["id"].as_str() {
                if value.get("method").is_none() {
                    if let Ok(mut pending) = runner.pending.lock() {
                        if let Some(tx) = pending.remove(id) {
                            let _ = tx.send(if let Some(error) = value.get("error") {
                                Err(rpc_error_message(error))
                            } else {
                                Ok(value["result"].clone())
                            });
                        }
                    }
                } else if value["method"] == "tool.invoke" {
                    let handle = handle.clone();
                    let id = id.to_owned();
                    let params = value["params"].clone();
                    thread::spawn(move || {
                        let result = invoke_tool(&handle, &params);
                        let _ = runner.send(match result {
                            Ok(result) => json!({"version":1,"id":id,"result":result}),
                            Err(error) => json!({"version":1,"id":id,"error":error}),
                        });
                    });
                }
            } else if value["method"] == "agent.event" {
                let _ = handle.emit("agent:event", &value["params"]);
                if let Some(id) = value["params"]["sessionId"].as_str() {
                    let workspace = handle
                        .state::<AgentState>()
                        .sessions
                        .lock()
                        .ok()
                        .and_then(|s| s.get(id).map(|s| s.workspace.clone()));
                    if let Some(workspace) = workspace {
                        crate::remote::forward_event(&handle, &workspace, &value["params"]);
                    }
                }
            }
        }
        let state = handle.state::<AgentState>();
        if let Some(runner) = weak.upgrade() {
            if let Ok(mut pending) = runner.pending.lock() {
                for (_, tx) in pending.drain() {
                    let _ = tx.send(Err("Pi Runner 已退出".into()));
                }
            }
        }
        let current = state
            .runner
            .lock()
            .ok()
            .and_then(|slot| {
                weak.upgrade().map(|exited| {
                    slot.as_ref()
                        .is_some_and(|active| Arc::ptr_eq(active, &exited))
                })
            })
            .unwrap_or(false);
        if current {
            if let Ok(mut approvals) = state.approvals.lock() {
                approvals.clear();
            }
            if let Ok(mut sessions) = state.sessions.lock() {
                for session in sessions.values() {
                    session.cancelled.store(true, Ordering::Release);
                }
                sessions.clear();
            }
            let _ = handle.emit("agent:error", "Pi Runner 已退出，请重新打开会话");
        }
    });
    *slot = Some(runner.clone());
    drop(slot);
    if let Err(error) = runner.request("runner.health", json!({})) {
        let mut slot = state.runner.lock().map_err(|e| e.to_string())?;
        if slot
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &runner))
        {
            *slot = None;
        }
        return Err(error);
    }
    Ok(runner)
}

#[cfg(target_os = "windows")]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\")
        .map(PathBuf::from)
        .unwrap_or(path)
}
fn invoke_tool(app: &tauri::AppHandle, params: &Value) -> Reply {
    let session = params["sessionId"]
        .as_str()
        .ok_or("工具请求缺少 sessionId")?;
    let tool = params["toolName"].as_str().ok_or("工具请求缺少 toolName")?;
    let input = &params["input"];
    let state = app.state::<AgentState>();
    let live = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(session)
        .cloned()
        .ok_or("未知会话")?;
    let workspace = &live.workspace;
    if live.cancelled.load(Ordering::Acquire) {
        return Err("会话已取消".into());
    }
    with_host(&app.state::<HostState>(), |h| h.authorize_agent(workspace))?;
    let capability = if tool == "skill_read" {
        "agent.skill.read"
    } else if tool.starts_with("mcp__") {
        "mcp.invoke"
    } else {
        host_core::tool_capability(tool).map_err(|e| e.to_string())?
    };
    let needs_approval = capability != "workspace.read" && capability != "agent.skill.read";
    if needs_approval {
        let request = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        state.approvals.lock().map_err(|e| e.to_string())?.insert(
            request.clone(),
            Approval {
                session: session.into(),
                expires: Instant::now() + Duration::from_secs(90),
                sender: tx,
            },
        );
        crate::remote::forward_event(
            app,
            workspace,
            &json!({"sessionId":session,"event":{"type":"remote_approval","requestId":request,"toolName":tool}}),
        );
        let decision = app
            .emit(
                "agent:approval",
                json!({"requestId":request,"sessionId":session,"toolName":tool,"input":input}),
            )
            .map_err(|e| e.to_string())
            .and_then(|_| {
                rx.recv_timeout(Duration::from_secs(90))
                    .map_err(|_| "审批已过期或取消".to_string())
            });
        state
            .approvals
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&request);
        let _ = app.emit(
            "agent:approval-resolved",
            json!({"requestId":request,"sessionId":session}),
        );
        crate::remote::forward_event(
            app,
            workspace,
            &json!({"sessionId":session,"event":{"type":"remote_approval_resolved","requestId":request}}),
        );
        if !decision.unwrap_or(false) {
            with_host(&app.state::<HostState>(), |h| {
                h.store
                    .audit(Some(workspace), host_core::AGENT_PLUGIN, tool, "denied")?;
                Ok(())
            })?;
            return Err("用户拒绝或审批已过期".into());
        }
    }
    if live.cancelled.load(Ordering::Acquire) {
        return Err("会话已取消".into());
    }
    if tool == "skill_read" {
        let result = agent_settings::read_skill(app, input);
        with_host(&app.state::<HostState>(), |h| {
            h.store.audit(
                Some(workspace),
                host_core::AGENT_PLUGIN,
                tool,
                if result.is_ok() { "allowed" } else { "failed" },
            )?;
            Ok(())
        })?;
        return result;
    }
    if tool.starts_with("mcp__") {
        let result =
            agent_mcp::invoke(app, workspace, tool, input, needs_approval, &live.cancelled);
        with_host(&app.state::<HostState>(), |h| {
            h.store.audit(
                Some(workspace),
                host_core::AGENT_PLUGIN,
                tool,
                if result.is_ok() { "allowed" } else { "failed" },
            )?;
            Ok(())
        })?;
        return result;
    }
    with_host(&app.state::<HostState>(), |h| {
        h.agent_tool(workspace, tool, input, needs_approval, &live.cancelled)
    })
}
pub(crate) fn model_catalog(
    app: &tauri::AppHandle,
) -> Result<Vec<nexttools_protocol::AgentModelInfo>, String> {
    let value = runner(app)?.request("models.list", json!({}))?;
    serde_json::from_value(value).map_err(|e| e.to_string())
}
fn session_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pi-agent");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory)
}
fn open_session(
    app: &tauri::AppHandle,
    workspace_id: String,
    persisted: Option<String>,
) -> Result<AgentSessionInfo, String> {
    let workspace = with_host(&app.state::<HostState>(), |h| {
        h.authorize_agent(&workspace_id)
    })?;
    let (provider, model, api_key) = agent_settings::configuration(app)?;
    let resources = agent_settings::resources(app)?;
    let directory = session_directory(app)?;
    let runtime = runner(app)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    app.state::<AgentState>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            session_id.clone(),
            Session {
                workspace: workspace_id.clone(),
                persisted: None,
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        );
    let result = runtime.request(if persisted.is_some() {"session.resume"} else {"session.create"},json!({"sessionId":session_id,"persistedSessionId":persisted,"cwd":workspace.root,"agentDir":directory,"sessionDir":directory.join("sessions").join(&workspace_id),"provider":provider,"model":model,"apiKey":api_key,"resources":resources}));
    match result {
        Ok(value) => {
            if let Some(live) = app
                .state::<AgentState>()
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .get_mut(&session_id)
            {
                live.persisted = value["persistedSessionId"].as_str().map(str::to_owned);
            }
            if persisted.is_some() {
                app.emit("agent:event",json!({"sessionId":session_id,"event":{"type":"session_restored","messages":value["messages"]}})).map_err(|e|e.to_string())?;
                crate::remote::forward_event(
                    app,
                    &workspace_id,
                    &json!({"sessionId":session_id,"event":{"type":"session_restored","messages":value["messages"]}}),
                );
            }
            Ok(AgentSessionInfo {
                session_id,
                workspace_id,
                model: value["model"].as_str().map(str::to_owned),
            })
        }
        Err(error) => {
            app.state::<AgentState>()
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&session_id);
            Err(error)
        }
    }
}
#[tauri::command]
pub async fn agent_session_create(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<AgentSessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || open_session(&app, workspace_id, None))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_session_resume(
    app: tauri::AppHandle,
    workspace_id: String,
    persisted_session_id: String,
) -> Result<AgentSessionInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_session(&app, workspace_id, Some(persisted_session_id))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_sessions_list(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<Vec<AgentSessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = with_host(&app.state::<HostState>(),|h|h.authorize_agent(&workspace_id))?;
        let directory = session_directory(&app)?;
        let value = runner(&app)?.request("session.list",json!({"cwd":workspace.root,"agentDir":directory,"sessionDir":directory.join("sessions").join(workspace_id)}))?;
        serde_json::from_value(value).map_err(|e|e.to_string())
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn agent_prompt(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err("消息不能为空".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let live = app
            .state::<AgentState>()
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(&session_id)
            .cloned()
            .ok_or("未知会话")?;
        with_host(&app.state::<HostState>(), |h| {
            h.authorize_agent(&live.workspace)
        })?;
        live.cancelled.store(false, Ordering::Release);
        runner(&app)?.request(
            "session.prompt",
            json!({"sessionId":session_id,"text":text}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_abort(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AgentState>();
        let live = state
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(&session_id)
            .cloned()
            .ok_or("未知会话")?;
        live.cancelled.store(true, Ordering::Release);
        let mut approvals = state.approvals.lock().map_err(|e| e.to_string())?;
        let cancelled: Vec<_> = approvals
            .extract_if(|_, approval| approval.session == session_id)
            .map(|(_, approval)| approval)
            .collect();
        drop(approvals);
        for approval in cancelled {
            let _ = approval.sender.send(false);
        }
        runner(&app)?
            .request("session.abort", json!({"sessionId":session_id}))
            .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn agent_approval_respond(
    state: State<'_, AgentState>,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    let approval = state
        .approvals
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id)
        .ok_or("审批已处理或失效")?;
    if Instant::now() > approval.expires {
        return Err("审批已过期".into());
    }
    approval
        .sender
        .send(approved)
        .map_err(|_| "审批已取消".into())
}

fn authorized_session(app: &tauri::AppHandle, session_id: &str) -> Result<Session, String> {
    let live = app
        .state::<AgentState>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(session_id)
        .cloned()
        .ok_or("未知会话")?;
    with_host(&app.state::<HostState>(), |h| {
        h.authorize_agent(&live.workspace)
    })?;
    Ok(live)
}
#[tauri::command]
pub async fn agent_session_rename(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        authorized_session(&app, &session_id)?;
        runner(&app)?
            .request(
                "session.rename",
                json!({"sessionId":session_id,"title":title}),
            )
            .map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_session_thinking(
    app: tauri::AppHandle,
    session_id: String,
    level: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        authorized_session(&app, &session_id)?;
        runner(&app)?.request(
            "session.thinking",
            json!({"sessionId":session_id,"level":level}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_session_dispose(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AgentState>();
        let live = authorized_session(&app, &session_id)?;
        live.cancelled.store(true, Ordering::Release);
        let cancelled: Vec<_> = state
            .approvals
            .lock()
            .map_err(|e| e.to_string())?
            .extract_if(|_, approval| approval.session == session_id)
            .map(|(_, approval)| approval)
            .collect();
        for approval in cancelled {
            let _ = approval.sender.send(false);
        }
        runner(&app)?.request("session.dispose", json!({"sessionId":session_id}))?;
        state
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&session_id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn remote_snapshot(
    app: &tauri::AppHandle,
    workspace: &str,
    name: &str,
    device: &str,
) -> Result<nexttools_protocol::RemoteWorkspace, String> {
    let sessions =
        tauri::async_runtime::block_on(agent_sessions_list(app.clone(), workspace.into()))?;
    Ok(nexttools_protocol::RemoteWorkspace {
        device_id: device.into(),
        id: workspace.into(),
        name: name.into(),
        sessions,
    })
}
pub(crate) fn remote_execute(
    app: &tauri::AppHandle,
    workspace: &str,
    operation: &str,
    input: &Value,
) -> Reply {
    with_host(&app.state::<HostState>(), |h| h.authorize_agent(workspace))?;
    let session = input["sessionId"].as_str().ok_or("缺少会话 ID")?;
    if operation == "session.view" {
        let sessions =
            tauri::async_runtime::block_on(agent_sessions_list(app.clone(), workspace.into()))?;
        if !sessions.iter().any(|s| s.session_id == session) {
            return Err("会话不属于授权项目".into());
        }
        let existing = app
            .state::<AgentState>()
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .iter()
            .find(|(_, live)| {
                live.workspace == workspace && live.persisted.as_deref() == Some(session)
            })
            .map(|(id, _)| id.clone());
        if let Some(id) = existing {
            let value = runner(app)?.request("session.snapshot", json!({"sessionId":id}))?;
            crate::remote::forward_event(
                app,
                workspace,
                &json!({"sessionId":id,"event":{"type":"session_restored","messages":value["messages"]}}),
            );
            return serde_json::to_value(AgentSessionInfo {
                session_id: id,
                workspace_id: workspace.into(),
                model: value["model"].as_str().map(str::to_owned),
            })
            .map_err(|e| e.to_string());
        }
        let info = open_session(app, workspace.into(), Some(session.into()))?;
        return serde_json::to_value(info).map_err(|e| e.to_string());
    }
    let live = authorized_session(app, session)?;
    if live.workspace != workspace {
        return Err("会话不属于授权项目".into());
    }
    match operation {
        "session.prompt" => tauri::async_runtime::block_on(agent_prompt(
            app.clone(),
            session.into(),
            input["text"].as_str().ok_or("缺少消息")?.into(),
        )),
        "session.stop" => tauri::async_runtime::block_on(agent_abort(app.clone(), session.into()))
            .map(|_| json!({"stopped":true})),
        _ => Err("远程操作未获授权".into()),
    }
}
