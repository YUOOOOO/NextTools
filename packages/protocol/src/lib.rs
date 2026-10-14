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
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub theme: String,
    pub mode: String,
    pub workbench_view: String,
    pub active_workspace_id: Option<String>,
    pub sidebar_collapsed: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            mode: "workbench".into(),
            workbench_view: "home".into(),
            active_workspace_id: None,
            sidebar_collapsed: false,
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
pub struct GitChange {
    pub index_status: String,
    pub worktree_status: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub changes: Vec<GitChange>,
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

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub session_id: String,
    pub workspace_id: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentProviderInfo {
    pub id: String,
    pub has_api_key: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub reasoning: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub file_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub connected: bool,
    pub error: Option<String>,
    pub tools: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsSnapshot {
    pub provider: String,
    pub model: String,
    pub providers: Vec<AgentProviderInfo>,
    pub models: Vec<AgentModelInfo>,
    pub skills: Vec<AgentSkillConfig>,
    pub mcp_servers: Vec<McpServerConfig>,
}
