#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSnapshot {
    pub server: String,
    pub email: Option<String>,
    pub device_id: String,
    pub connected: bool,
    pub error: Option<String>,
    pub authorization_url: Option<String>,
    pub pairing_code: Option<String>,
    pub devices: Vec<RemoteDevice>,
    pub pairings: Vec<RemotePairing>,
    pub workspaces: Vec<RemoteWorkspace>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub signing_key: String,
    pub exchange_key: String,
    pub revoked: bool,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
pub struct RemotePairing {
    pub id: String,
    pub source: Option<String>,
    pub target: String,
    pub status: String,
    pub workspaces: Vec<String>,
    pub operations: Vec<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspace {
    pub device_id: String,
    pub id: String,
    pub name: String,
    pub sessions: Vec<AgentSessionSummary>,
}
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
    pub original_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub changes: Vec<GitChange>,
    pub state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GitQuery {
    Diff { path: String, staged: bool },
    Log,
    Branches,
    Stashes,
    Compare { left: String, right: String },
    Show { commit: String },
    Outgoing,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GitAction {
    Stage { paths: Vec<String> },
    Unstage { paths: Vec<String> },
    Discard { paths: Vec<String> },
    Commit { message: String },
    Switch { branch: String },
    CreateBranch { branch: String },
    Fetch,
    Pull,
    Push { remote: Option<String> },
    StashSave { message: String },
    StashApply { reference: String },
    StashDrop { reference: String },
    SwitchRemote { branch: String },
    Merge { branch: String },
    MergeContinue,
    Abort,
    Reset { commit: String, hard: bool },
    ResolveConflict { path: String, theirs: bool },
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitApproval {
    pub request_id: String,
    pub action: GitAction,
    pub expires_in_seconds: u32,
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
#[serde(rename_all = "lowercase")]
pub enum FileChangeKind {
    Write,
    Create,
    Delete,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChange {
    pub kind: FileChangeKind,
    pub path: String,
    pub content: Option<String>,
    pub expected_content: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeApproval {
    pub request_id: String,
    pub change: FileChange,
    pub diff: String,
    pub expires_in_seconds: u32,
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub provider: String,
    pub model: String,
    pub system_prompt: String,
    pub skill_ids: Vec<String>,
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
    pub profiles: Vec<AgentProfile>,
    pub active_profile_id: Option<String>,
}
