import { app, BrowserWindow, desktopCapturer, dialog } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { REMOTE_ACTIONS, remoteSummary, runRemoteAction } from "../conversation-sync-actions.mjs";
import { desktopDeviceName, desktopOsLabel } from "../device-identity.mjs";
import type { HostProcess } from "../host-process";

export async function runCall(
  getHost: () => HostProcess | null,
  getSidecar: () => { call(method: string, params: unknown): Promise<unknown> } | null,
  action: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const initialHost = getHost();
  const initialSidecar = getSidecar();
  const check = () => {
    if (signal?.aborted) throw new Error("cancelled");
    if (getHost() !== initialHost || getSidecar() !== initialSidecar) throw new Error("agent_unavailable");
  };
  check();
  if (action === "info") return { name: desktopDeviceName(), kind: "computer", os: desktopOsLabel() };
  if (REMOTE_ACTIONS.includes(action)) {
    const allowed = await confirmRemote(action, args);
    check();
    if (!allowed) throw new Error("local_denied");
    const result = await runRemoteAction(action, args, {
      signal,
      capture: captureScreen,
      open: async (path: string) => {
        const { shell } = await import("electron");
        check();
        return shell.openPath(path);
      },
    });
    check();
    return result;
  }
  const host = getHost();
  if (!host) throw new Error("host unavailable");
  if (action === "sessions.list") {
    const listed = await host.call("session.list", {}) as { sessions?: Array<{ id?: string; title?: string }> };
    check();
    return { sessions: (listed.sessions ?? []).map((session) => ({ id: session.id ?? "", title: session.title ?? "" })) };
  }
  throw new Error(`unknown action ${action}`);
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

export async function loadSessions(getHost: () => HostProcess | null): Promise<unknown[]> {
  const host = getHost();
  if (!host) throw new Error("host unavailable");
  const listed = await host.call("session.list", {}) as { sessions?: Array<{ id?: string }> };
  if (getHost() !== host) throw new Error("host_changed");
  const sessions = [];
  for (const summary of listed.sessions ?? []) {
    if (!summary?.id) continue;
    const loaded = await host.call("session.get", { id: summary.id }) as { session?: unknown };
    if (getHost() !== host) throw new Error("host_changed");
    sessions.push(loaded.session ?? loaded);
  }
  return sessions;
}
