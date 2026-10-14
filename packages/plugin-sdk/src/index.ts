import type {
  CommandEvent,
  FileContent,
  FileEntry,
  GitStatus,
  HostSnapshot,
  Preferences,
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
}
