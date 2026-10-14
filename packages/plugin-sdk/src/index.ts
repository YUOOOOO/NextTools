import type {
  AgentSessionInfo,
  AgentSessionSummary,
  AgentSettingsSnapshot,
  AgentSkillConfig,
  CommandEvent,
  FileContent,
  FileEntry,
  GitStatus,
  HostSnapshot,
  Preferences,
  McpServerConfig,
  Workspace,
} from "@nexttools/protocol";
/** Injected by the shell. Plugins do not import Tauri or native APIs. */
export interface HostClient {
  snapshot(): Promise<HostSnapshot>;
  chooseWorkspace(): Promise<Workspace | null>;
  setPreferences(preferences: Preferences): Promise<void>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;
  setShortcut(
    pluginId: string,
    commandId: string,
    accelerator: string | null,
  ): Promise<void>;
  executeCommand(pluginId: string, commandId: string): Promise<CommandEvent>;
  listFiles(workspaceId: string, path: string): Promise<FileEntry[]>;
  readFile(workspaceId: string, path: string): Promise<FileContent>;
  gitStatus(workspaceId: string): Promise<GitStatus>;
  agentSessionCreate(workspaceId: string): Promise<AgentSessionInfo>;
  listAgentSessions(workspaceId: string): Promise<AgentSessionSummary[]>;
  resumeAgentSession(
    workspaceId: string,
    persistedSessionId: string,
  ): Promise<AgentSessionInfo>;
  agentPrompt(sessionId: string, text: string): Promise<void>;
  agentAbort(sessionId: string): Promise<void>;
  agentApprovalRespond(requestId: string, approved: boolean): Promise<void>;
  agentConfigure(
    provider: string,
    model: string,
    apiKey: string,
  ): Promise<void>;
  agentSettingsSnapshot(): Promise<AgentSettingsSnapshot>;
  agentSkillImport(): Promise<AgentSkillConfig | null>;
  agentSkillSetEnabled(id: string, enabled: boolean): Promise<void>;
  agentSkillRemove(id: string): Promise<void>;
  agentMcpSave(server: McpServerConfig): Promise<void>;
  agentMcpConnect(id: string, approved: boolean): Promise<void>;
  agentMcpDisconnect(id: string): Promise<void>;
  agentMcpRemove(id: string): Promise<void>;
}
