import { app, BrowserWindow, desktopCapturer, dialog, safeStorage } from "electron";
import { join } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { REMOTE_ACTIONS, remoteSummary, runRemoteAction } from "../conversation-sync-actions.mjs";
import { createConversationSync } from "../conversation-sync-client.mjs";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerConversationSyncIpc({
  registrar,
  getHost,
  getSidecar,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => { call(method: string, params: unknown): Promise<unknown> } | null;
}): void {
  const sync = createConversationSync({
    filePath: join(app.getPath("userData"), "conversation-sync.json"),
    encrypt: (plain: string) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (encoded: string) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    listSessions: () => loadSessions(getHost),
    onCall: (action: string, args: Record<string, unknown>) => runCall(getHost, getSidecar, action, args),
    deviceId: "desktop-local",
  });
  registrar.handle(IPC.invoke.conversationSyncGetState, () => sync.getState());
  registrar.handle(IPC.invoke.conversationSyncSignIn, (input: unknown) => sync.signIn(input));
  registrar.handle(IPC.invoke.conversationSyncRegister, (input: unknown) => sync.register(input));
  registrar.handle(IPC.invoke.conversationSyncSignOut, () => sync.signOut());
  registrar.handle(IPC.invoke.conversationSyncPush, () => sync.push());
}

async function runCall(
  getHost: () => HostProcess | null,
  getSidecar: () => { call(method: string, params: unknown): Promise<unknown> } | null,
  action: string,
  args: Record<string, unknown>,
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
  const result = await sidecar.call("agent.prompt", { sessionId, content: text });
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
