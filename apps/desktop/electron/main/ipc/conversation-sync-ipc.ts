import { app, safeStorage } from "electron";
import { join } from "node:path";
import { IPC } from "@pi-desktop/shared";
import { createConversationSync } from "../conversation-sync-client.mjs";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerConversationSyncIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  const sync = createConversationSync({
    filePath: join(app.getPath("userData"), "conversation-sync.json"),
    encrypt: (plain: string) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (encoded: string) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    listSessions: () => loadSessions(getHost),
    deviceId: "desktop-local",
  });
  registrar.handle(IPC.invoke.conversationSyncGetState, () => sync.getState());
  registrar.handle(IPC.invoke.conversationSyncSignIn, (input: unknown) => sync.signIn(input));
  registrar.handle(IPC.invoke.conversationSyncRegister, (input: unknown) => sync.register(input));
  registrar.handle(IPC.invoke.conversationSyncSignOut, () => sync.signOut());
  registrar.handle(IPC.invoke.conversationSyncPush, () => sync.push());
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
