import { app, BrowserWindow, desktopCapturer, dialog, safeStorage } from "electron";
import { join } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { REMOTE_ACTIONS, remoteSummary, runRemoteAction } from "../conversation-sync-actions.mjs";
import { createConversationSync } from "../conversation-sync-client.mjs";
import { createConversationAutoSync } from "../conversation-auto-sync.mjs";
import { loadOrCreateSyncDeviceId } from "../conversation-sync-device-id.mjs";
import { createConversationTaskBridge, type InternalInvoke, type TaskCallContext, type TaskSidecar } from "../conversation-task-bridge.mjs";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerConversationSyncIpc({
  registrar,
  getHost,
  getSidecar,
  invoke,
  onSessionsChanged,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => ({ call(method: string, params: unknown): Promise<unknown> } & TaskSidecar) | null;
  /** Reuse the registered Agent handlers, including local approvals and durable turns. */
  invoke: InternalInvoke;
  onSessionsChanged: () => void;
}): void {
  const tasks = createConversationTaskBridge({
    getHost, getSidecar,
    prompt: (request) => invoke(IPC.invoke.agentPrompt, [request]),
    abort: (request) => invoke(IPC.invoke.agentAbort, [request]),
  });
  const sync = createConversationSync({
    filePath: join(app.getPath("userData"), "conversation-sync.json"),
    encrypt: (plain: string) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (encoded: string) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    listSessions: () => loadSessions(getHost),
    onCall: (action: string, args: Record<string, unknown>, context: TaskCallContext) => {
      if (action === "task") {
        return tasks.task(args, context).finally(() => {
          onSessionsChanged();
          automatic.request();
        });
      }
      if (action === "stop") return tasks.stop(args, context);
      return runCall(getHost, getSidecar, action, args, invoke);
    },
    deviceId: loadOrCreateSyncDeviceId(join(app.getPath("userData"), "conversation-sync-device-id")),
  });
  const automatic = createConversationAutoSync({
    sync,
    onError: (error: unknown) => {
      // Only a stable code goes to the log; no token, chat text or server body.
      const code = (error as { code?: unknown })?.code;
      console.warn("[conversation-sync] automatic upload failed", typeof code === "string" ? code : "sync_failed");
    },
  });
  automatic.start();
  app.once("before-quit", () => automatic.dispose());
  registrar.handle(IPC.invoke.conversationSyncGetState, () => sync.getState());
  registrar.handle(IPC.invoke.conversationSyncSignIn, async (input: unknown) => { const state = await sync.signIn(input); automatic.request(); return state; });
  registrar.handle(IPC.invoke.conversationSyncRegister, async (input: unknown) => { const state = await sync.register(input); automatic.request(); return state; });
  registrar.handle(IPC.invoke.conversationSyncSignOut, () => sync.signOut());
  registrar.handle(IPC.invoke.conversationSyncPush, () => sync.push());
}

async function runCall(
  getHost: () => HostProcess | null,
  getSidecar: () => { call(method: string, params: unknown): Promise<unknown> } | null,
  action: string,
  args: Record<string, unknown>,
  invoke?: InternalInvoke,
): Promise<unknown> {
  if (action === "info") return { name: "Pilot", kind: "computer" };
  if (REMOTE_ACTIONS.includes(action)) {
    const allowed = await confirmRemote(action, args);
    if (!allowed) throw new Error("local_denied");
    return runRemoteAction(action, args, {
      capture: captureScreen,
      open: async (path: string) => {
        const { shell } = await import("electron");
        return shell.openPath(path);
      },
    });
  }
  const host = getHost();
  if (!host) throw new Error("host unavailable");
  if (action === "sessions.list") {
    const listed = await host.call("session.list", {}) as { sessions?: Array<{ id?: string; title?: string }> };
    return { sessions: (listed.sessions ?? []).map((session) => ({ id: session.id ?? "", title: session.title ?? "" })) };
  }
  if (action !== "chat.send") throw new Error(`unknown action ${action}`);
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("text required");
  let sessionId = String(args.sessionId ?? "");
  if (!sessionId) {
    const listed = await host.call("session.list", {}) as { sessions?: Array<{ id?: string }> };
    sessionId = String(listed.sessions?.find((session) => session.id)?.id ?? "");
  }
  if (!sessionId) {
    const created = await host.call("session.create", { title: "Web" }) as { session?: { id?: string } };
    sessionId = String(created.session?.id ?? "");
  }
  if (!sessionId) throw new Error("no session");
  const sidecar = getSidecar();
  if (!sidecar) throw new Error("agent unavailable");
  if (!invoke) throw new Error("agent_unavailable");
  const result = await invoke(IPC.invoke.agentPrompt, [{ sessionId, content: text }]);
  return { sessionId, result };
}

async function confirmRemote(action: string, args: Record<string, unknown>): Promise<boolean> {
  const strings = catalogs[resolveLocale(app.getLocale())].remoteActionConsent;
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((item) => !item.isDestroyed()) ?? null;
  const options = {
    type: "warning" as const,
    title: strings.title,
    message: strings.message.replace("{action}", action),
    detail: strings.detail.replace("{summary}", remoteSummary(action, args)),
    buttons: [strings.deny, strings.allow],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function captureScreen(): Promise<{ encoding: "base64"; content: string; mime: string }> {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1280, height: 720 } });
  const source = sources[0];
  if (!source) throw new Error("screen_unavailable");
  return { encoding: "base64", content: source.thumbnail.toPNG().toString("base64"), mime: "image/png" };
}

async function loadSessions(getHost: () => HostProcess | null): Promise<unknown[]> {
  const host = getHost();
  if (!host) throw new Error("host unavailable");
  const listed = await host.call("session.list", {}) as { sessions?: Array<{ id?: string }> };
  const sessions = [];
  for (const summary of listed.sessions ?? []) {
    if (!summary?.id) continue;
    const loaded = await host.call("session.get", { id: summary.id }) as { session?: unknown };
    sessions.push(loaded.session ?? loaded);
  }
  return sessions;
}
