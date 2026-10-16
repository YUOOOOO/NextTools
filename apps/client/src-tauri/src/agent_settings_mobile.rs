use nexttools_protocol::{AgentSettingsSnapshot, AgentSkillConfig};
use serde_json::Value;
use tauri::AppHandle;

const DESKTOP_ONLY: &str = "Agent 设置仅支持已配对桌面端";

pub fn initialize(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
#[tauri::command]
pub fn agent_settings_snapshot(_app: AppHandle) -> Result<AgentSettingsSnapshot, String> {
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_configure(
    _app: AppHandle,
    provider: String,
    model: String,
    api_key: String,
) -> Result<(), String> {
    let _ = (provider, model, api_key);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub async fn agent_skill_import(_app: AppHandle) -> Result<Option<AgentSkillConfig>, String> {
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_skill_toggle(_app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let _ = (id, enabled);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_skill_remove(_app: AppHandle, id: String) -> Result<(), String> {
    let _ = id;
    Err(DESKTOP_ONLY.into())
}

#[allow(dead_code)]
pub fn resources(_app: &AppHandle) -> Result<Value, String> {
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_profile_save(profile: nexttools_protocol::AgentProfile) -> Result<(), String> {
    let _ = profile;
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_profile_select(id: Option<String>) -> Result<(), String> {
    let _ = id;
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_profile_remove(id: String) -> Result<(), String> {
    let _ = id;
    Err(DESKTOP_ONLY.into())
}
