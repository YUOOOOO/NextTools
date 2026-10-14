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
};
