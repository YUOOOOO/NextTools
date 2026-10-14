use serde_json::Value;
use std::sync::atomic::AtomicBool;
use tauri::AppHandle;

const DESKTOP_ONLY: &str = "MCP 仅支持桌面端本地连接";
#[derive(Default)]
pub struct McpState;
pub fn initialize(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
#[tauri::command]
pub fn agent_mcp_save(_app: AppHandle, server: Value) -> Result<(), String> {
    let _ = server;
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_mcp_connect(_app: AppHandle, id: String, approved: bool) -> Result<(), String> {
    let _ = (id, approved);
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_mcp_disconnect(_app: AppHandle, id: String) -> Result<(), String> {
    let _ = id;
    Err(DESKTOP_ONLY.into())
}
#[tauri::command]
pub fn agent_mcp_remove(_app: AppHandle, id: String) -> Result<(), String> {
    let _ = id;
    Err(DESKTOP_ONLY.into())
}
#[allow(dead_code)]
pub fn snapshot(_app: &AppHandle) -> Result<Vec<Value>, String> {
    Err(DESKTOP_ONLY.into())
}
#[allow(dead_code)]
pub fn resources(_app: &AppHandle) -> Result<Vec<Value>, String> {
    Err(DESKTOP_ONLY.into())
}
#[allow(dead_code)]
pub fn invoke(
    _app: &AppHandle,
    _workspace: &str,
    _tool: &str,
    _input: &Value,
    _approved: bool,
    _cancelled: &AtomicBool,
) -> Result<Value, String> {
    Err(DESKTOP_ONLY.into())
}
