use crate::{Host, HostError, AGENT_PLUGIN};
use nexttools_protocol::Workspace;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Component, Path},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub fn tool_capability(tool: &str) -> Result<&'static str, HostError> {
    if tool.starts_with("mcp__") {
        return Ok("mcp.invoke");
    }
    match tool {
        "workspace_read" | "workspace_list" | "git_status" | "git_diff" | "git_log"
        | "git_branch" | "skill_read" => Ok("workspace.read"),
        "workspace_write" => Ok("workspace.write"),
        "shell_execute" => Ok("shell.execute"),
        "git_commit" => Ok("git.commit"),
        "git_push" => Ok("git.push"),
        _ => Err(HostError::Invalid("未知 Agent 工具".into())),
    }
}
fn string<'a>(input: &'a Value, name: &str) -> Result<&'a str, HostError> {
    input
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| HostError::Invalid(format!("缺少参数：{name}")))
}
pub(super) fn output(mut command: Command, cancelled: &AtomicBool) -> Result<Value, HostError> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| HostError::Invalid("无法读取 stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| HostError::Invalid("无法读取 stderr".into()))?;
    let collect = |mut stream: Box<dyn Read + Send>| -> Result<String, std::io::Error> {
        let mut result = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let n = stream.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            let remaining = 1_048_576usize.saturating_sub(result.len());
            result.extend_from_slice(&buffer[..n.min(remaining)]);
        }
        Ok(String::from_utf8_lossy(&result).into_owned())
    };
    let out = thread::spawn(move || collect(Box::new(stdout)));
    let err = thread::spawn(move || collect(Box::new(stderr)));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if cancelled.load(Ordering::Acquire) || start.elapsed() > Duration::from_secs(120) {
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(HostError::Invalid(
                if cancelled.load(Ordering::Acquire) {
                    "命令已取消"
                } else {
                    "命令执行超过 120 秒，已终止"
                }
                .into(),
            ));
        }
        thread::sleep(Duration::from_millis(30));
    };
    let stdout = out
        .join()
        .map_err(|_| HostError::Invalid("stdout 读取失败".into()))??;
    let stderr = err
        .join()
        .map_err(|_| HostError::Invalid("stderr 读取失败".into()))??;
    if !status.success() {
        return Err(HostError::Invalid(format!("命令失败 ({status})：{stderr}")));
    }
    Ok(json!({"stdout":stdout,"stderr":stderr,"exitCode":status.code()}))
}
impl Host {
    pub fn authorize_agent(&self, workspace: &str) -> Result<Workspace, HostError> {
        capability_broker::authorize(
            &self.agent_manifest,
            self.store.plugin_enabled(AGENT_PLUGIN)?,
            "agent.session",
        )?;
        self.workspace(workspace)
    }
    pub fn authorize_agent_tool(
        &self,
        workspace: &str,
        tool: &str,
        approved: bool,
    ) -> Result<Workspace, HostError> {
        let root = self.authorize_agent(workspace)?;
        capability_broker::authorize_approved(
            &self.agent_manifest,
            self.store.plugin_enabled(AGENT_PLUGIN)?,
            tool_capability(tool)?,
            approved,
        )?;
        Ok(root)
    }
    pub fn agent_tool(
        &self,
        workspace: &str,
        tool: &str,
        input: &Value,
        approved: bool,
        cancelled: &AtomicBool,
    ) -> Result<Value, HostError> {
        let result = (|| {
            if cancelled.load(Ordering::Acquire) {
                return Err(HostError::Invalid("会话已取消".into()));
            }
            let root = self.authorize_agent(workspace)?;
            let capability = tool_capability(tool)?;
            capability_broker::authorize_approved(
                &self.agent_manifest,
                self.store.plugin_enabled(AGENT_PLUGIN)?,
                capability,
                approved,
            )?;
            match tool {
                "workspace_read" => Ok(serde_json::to_value(
                    self.read_file(workspace, string(input, "path")?)?,
                )?),
                "workspace_list" => Ok(serde_json::to_value(self.list_files(
                    workspace,
                    input.get("path").and_then(Value::as_str).unwrap_or(""),
                )?)?),
                "workspace_write" => {
                    let relative = string(input, "path")?;
                    let text = input
                        .get("content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| HostError::Invalid("缺少 content".into()))?;
                    if text.len() > 1_048_576 {
                        return Err(HostError::Invalid("写入超过 1 MiB".into()));
                    }
                    let path = Path::new(relative);
                    if path
                        .components()
                        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
                    {
                        return Err(HostError::Invalid("路径越界".into()));
                    }
                    let parent = workspace_core::resolve(
                        Path::new(&root.root),
                        path.parent().and_then(Path::to_str).unwrap_or(""),
                    )?;
                    let target = parent.join(
                        path.file_name()
                            .ok_or_else(|| HostError::Invalid("无效文件路径".into()))?,
                    );
                    if target.exists() {
                        workspace_core::resolve(Path::new(&root.root), relative)?;
                    }
                    std::fs::write(target, text)?;
                    Ok(json!({"path":relative,"bytes":text.len()}))
                }
                "shell_execute" => {
                    let script = string(input, "command")?;
                    #[cfg(target_os = "windows")]
                    let mut command = {
                        let mut c = Command::new("powershell.exe");
                        c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
                        c
                    };
                    #[cfg(not(target_os = "windows"))]
                    let mut command = {
                        let mut c = Command::new("/bin/sh");
                        c.args(["-c", script]);
                        c
                    };
                    command.current_dir(&root.root);
                    output(command, cancelled)
                }
                _ => {
                    let mut command = Command::new("git");
                    command.args(["-C", &root.root]);
                    command.env("GIT_TERMINAL_PROMPT", "0");
                    match tool {
                        "git_status" => {
                            command.args(["status", "--short", "--branch"]);
                        }
                        "git_diff" => {
                            command.arg("diff");
                            if input
                                .get("staged")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                            {
                                command.arg("--cached");
                            }
                            command.arg("--");
                        }
                        "git_log" => {
                            let limit = input
                                .get("limit")
                                .and_then(Value::as_u64)
                                .unwrap_or(20)
                                .clamp(1, 100);
                            command.args(["log", "--oneline", "-n", &limit.to_string()]);
                        }
                        "git_branch" => {
                            command.args(["branch", "--all"]);
                        }
                        "git_commit" => {
                            command.args(["commit", "-m", string(input, "message")?]);
                        }
                        "git_push" => {
                            command.arg("push");
                            for name in ["remote", "branch"] {
                                if let Some(value) = input.get(name).and_then(Value::as_str) {
                                    if value.starts_with('-') || value.is_empty() {
                                        return Err(HostError::Invalid(
                                            "无效 Git push 参数".into(),
                                        ));
                                    }
                                    command.arg(value);
                                }
                            }
                        }
                        _ => return Err(HostError::Invalid("未知工具".into())),
                    }
                    output(command, cancelled)
                }
            }
        })();
        self.store.audit(
            Some(workspace),
            AGENT_PLUGIN,
            tool,
            if result.is_ok() { "allowed" } else { "failed" },
        )?;
        result
    }
}
