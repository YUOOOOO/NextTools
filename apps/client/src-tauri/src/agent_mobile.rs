use nexttools_protocol::{AgentSessionInfo, AgentSessionSummary};

const DESKTOP_ONLY: &str = "本地 Pi Agent 仅支持桌面端；移动端必须通过已配对桌面远程控制";

#[tauri::command]
pub fn agent_session_create(workspace_id: String) -> Result<AgentSessionInfo, String> {
    let _ = workspace_id;
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_session_resume(
    workspace_id: String,
    persisted_session_id: String,
) -> Result<AgentSessionInfo, String> {
    let _ = (workspace_id, persisted_session_id);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_sessions_list(workspace_id: String) -> Result<Vec<AgentSessionSummary>, String> {
    let _ = workspace_id;
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_prompt(session_id: String, text: String) -> Result<serde_json::Value, String> {
    let _ = (session_id, text);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_abort(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_approval_respond(request_id: String, approved: bool) -> Result<(), String> {
    let _ = (request_id, approved);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_configure(provider: String, model: String, api_key: String) -> Result<(), String> {
    let _ = (provider, model, api_key);
    Err(DESKTOP_ONLY.into())
}

#[tauri::command]
pub fn agent_session_rename(session_id: String, title: String) -> Result<(), String> {
    let _ = (session_id, title);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_session_thinking(
    session_id: String,
    level: String,
) -> Result<serde_json::Value, String> {
    let _ = (session_id, level);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_session_dispose(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Err(DESKTOP_ONLY.into())
}
