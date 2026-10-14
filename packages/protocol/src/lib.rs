use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub id: String,
    pub title: String,
    pub execution: String,
    pub view_id: Option<String>,
    pub required_capabilities: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    pub views: Vec<String>,
    pub commands: Vec<PluginCommand>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub platforms: Vec<String>,
    pub mobile_mode: String,
    pub capabilities: Vec<String>,
    pub contributes: Contributions,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstall {
    pub manifest: PluginManifest,
    pub enabled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub mode: String,
    pub workbench_view: String,
    pub active_workspace_id: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            mode: "workbench".into(),
            workbench_view: "home".into(),
            active_workspace_id: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub plugin_id: String,
    pub command_id: String,
    pub accelerator: String,
    pub enabled: bool,
    pub status: String,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub protocol_version: u32,
    pub platform: String,
    pub database_path: String,
    pub workspaces: Vec<Workspace>,
    pub plugins: Vec<PluginInstall>,
    pub preferences: Preferences,
    pub shortcuts: Vec<ShortcutBinding>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommandEvent {
    pub plugin_id: String,
    pub command_id: String,
    pub view_id: Option<String>,
}
