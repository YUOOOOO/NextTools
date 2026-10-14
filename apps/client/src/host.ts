import { invoke, isTauri } from "@tauri-apps/api/core";
import type { HostClient } from "@nexttools/plugin-sdk";
export const nativeHostAvailable = isTauri();
export const host: HostClient = {
  snapshot: () => invoke("host_snapshot"),
  chooseWorkspace: () => invoke("workspace_choose"),
  setPreferences: (preferences) =>
    invoke("preferences_update", { preferences }),
  setPluginEnabled: (pluginId, enabled) =>
    invoke("plugin_set_enabled", { pluginId, enabled }),
  setShortcut: (pluginId, commandId, accelerator) =>
    invoke("shortcut_set", { pluginId, commandId, accelerator }),
  executeCommand: (pluginId, commandId) =>
    invoke("command_execute", { pluginId, commandId }),
  listFiles: (workspaceId, path) => invoke("files_list", { workspaceId, path }),
  readFile: (workspaceId, path) => invoke("files_read", { workspaceId, path }),
  gitStatus: (workspaceId) => invoke("git_status", { workspaceId }),
  agentSessionCreate: (workspaceId) =>
    invoke("agent_session_create", { workspaceId }),
  listAgentSessions: (workspaceId) =>
    invoke("agent_sessions_list", { workspaceId }),
  resumeAgentSession: (workspaceId, persistedSessionId) =>
    invoke("agent_session_resume", { workspaceId, persistedSessionId }),
  agentPrompt: (sessionId, text) => invoke("agent_prompt", { sessionId, text }),
  agentAbort: (sessionId) => invoke("agent_abort", { sessionId }),
  agentApprovalRespond: (requestId, approved) =>
    invoke("agent_approval_respond", { requestId, approved }),
  agentConfigure: (provider, model, apiKey) =>
    invoke("agent_configure", { provider, model, apiKey }),
  agentSettingsSnapshot: () => invoke("agent_settings_snapshot"),
  agentSkillImport: () => invoke("agent_skill_import"),
  agentSkillSetEnabled: (id, enabled) =>
    invoke("agent_skill_toggle", { id, enabled }),
  agentSkillRemove: (id) => invoke("agent_skill_remove", { id }),
  agentMcpSave: (server) => invoke("agent_mcp_save", { server }),
  agentMcpConnect: (id, approved) =>
    invoke("agent_mcp_connect", { id, approved }),
  agentMcpDisconnect: (id) => invoke("agent_mcp_disconnect", { id }),
  agentMcpRemove: (id) => invoke("agent_mcp_remove", { id }),
};
