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
  writeFile(
    workspaceId: string,
    path: string,
    content: string,
    expectedContent: string,
  ): Promise<void>;
  gitStatus(workspaceId: string): Promise<GitStatus>;
  agentSessionCreate(workspaceId: string): Promise<AgentSessionInfo>;
  listAgentSessions(workspaceId: string): Promise<AgentSessionSummary[]>;
  resumeAgentSession(
    workspaceId: string,
    persistedSessionId: string,
  ): Promise<AgentSessionInfo>;
  agentPrompt(sessionId: string, text: string): Promise<{ accepted: boolean; exportText?: string }>;
  agentAbort(sessionId: string): Promise<void>;
  agentSessionRename(sessionId: string, title: string): Promise<void>;
  agentSessionThinking(sessionId: string, level: string): Promise<{ thinkingLevel: string; supportedThinkingLevels: string[] }>;
  agentSessionDispose(sessionId: string): Promise<void>;
  agentFiles(sessionId: string, query: string): Promise<{ path: string; isDirectory: boolean }[]>;
  agentDiff(sessionId: string, turnId: string, path: string): Promise<string>;
  agentApprovalRespond(requestId: string, approved: boolean, scope?: "once" | "always" | "directory"): Promise<void>;
  agentConfigure(
    provider: string,
    model: string,
    apiKey: string,
    options?: { baseUrl?: string; api?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number },
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
