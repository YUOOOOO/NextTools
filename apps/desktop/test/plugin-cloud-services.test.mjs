import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

async function modules(t) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const vite = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  return { credentials: await vite.ssrLoadModule("/electron/main/plugin-credentials.ts"), remote: await vite.ssrLoadModule("/electron/main/plugin-remote-sessions.ts") };
}

function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    },
  };
}

test("credentials isolate owners, encrypt values and serialize replacement/removal", async (t) => {
  const { credentials } = await modules(t);
  const userData = await mkdtemp(join(tmpdir(), "plugin-credentials-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const crypto = encryption();
  const store = credentials.createPluginCredentials({ userData, encryption: crypto });
  await store.set("plugin.one", "account", "private-token");
  assert.equal(await store.get("plugin.two", "account"), null);
  const files = await readdir(join(userData, "plugin-credentials"));
  assert.equal((await readFile(join(userData, "plugin-credentials", files[0]))).includes(Buffer.from("private-token")), false);
  await Promise.all([store.set("plugin.one", "account", "replacement"), store.remove("plugin.one", "account")]);
  assert.equal(await store.get("plugin.one", "account"), null);
  await assert.rejects(store.set("../escape", "account", "secret"), /invalid_credential_key/);
  const locked = credentials.createPluginCredentials({ userData, encryption: { ...crypto, isEncryptionAvailable: () => false } });
  await assert.rejects(locked.get("plugin.one", "account"), /credential_encryption_unavailable/);
});

test("legacy account migrates without losing pending deletion or resurrecting signout", async (t) => {
  const { credentials } = await modules(t);
  const userData = await mkdtemp(join(tmpdir(), "plugin-migration-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const crypto = encryption();
  const source = JSON.stringify({ baseUrl: "https://sync.example", account: "alice", tokenEncrypted: crypto.encryptString("existing-token").toString("base64"), pendingDeletes: ["session-old"] });
  await writeFile(join(userData, "conversation-sync.json"), source);
  const store = credentials.createPluginCredentials({ userData, encryption: crypto });
  assert.equal(await store.get("other.plugin", "account"), null);
  assert.deepEqual(JSON.parse(await store.get("pi.cloud-sync", "account")), { baseUrl: "https://sync.example", account: "alice", token: "existing-token", pendingDeletes: ["session-old"] });
  assert.equal(await readFile(join(userData, "conversation-sync.json"), "utf8"), source);
  await store.remove("pi.cloud-sync", "account");
  assert.equal(await credentials.createPluginCredentials({ userData, encryption: crypto }).get("pi.cloud-sync", "account"), null);
});

test("remote cancellation, duplicate ids and unload are isolated to their owner", async (t) => {
  const { remote } = await modules(t);
  const running = [], events = [];
  const host = { async call() { return { session: null }; } };
  const service = remote.createPluginRemoteSessions({
    getHost: () => host, getSidecar: () => null, invoke: async () => { throw new Error("unexpected"); },
    currentTurn: () => null, getDevice: () => ({ id: "device", name: "Desktop", os: "Windows" }),
    listSessions: async () => [], onSessionsChanged() {}, redact: (value) => value,
    emit: (...event) => events.push(event),
    runCall: (_action, _args, _web, signal) => new Promise((resolve, reject) => {
      running.push({ signal, resolve });
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  });
  const request = { requestId: "request-1", scope: "account", caller: { id: "web-1", kind: "web" }, action: "info", args: {}, sharedSessionIds: [] };
  const first = service.invoke("plugin.one", request);
  const second = service.invoke("plugin.two", request);
  await assert.rejects(service.invoke("plugin.one", request), /duplicate_request/);
  service.cancel("plugin.two", "absent");
  assert.equal(running[0].signal.aborted, false);
  service.cancel("plugin.one", request.requestId);
  await assert.rejects(first, /cancelled/);
  assert.equal(running[1].signal.aborted, false);
  service.dispose("plugin.two");
  await assert.rejects(second, /cancelled/);
  assert.deepEqual(events, []);
});

test("remote snapshots and deletion checks reject a replaced Host", async (t) => {
  const { remote } = await modules(t);
  let host = { async call() { host = null; return { session: null }; } };
  const service = remote.createPluginRemoteSessions({
    getHost: () => host, getSidecar: () => null, invoke: async () => null, currentTurn: () => null,
    getDevice: () => ({ id: "device", name: "Desktop", os: "Windows" }),
    listSessions: async () => { host = null; return []; },
    runCall: async () => null, emit() {}, onSessionsChanged() {}, redact: (value) => value,
  });
  await assert.rejects(service.isDeleted("plugin.one", "session-1"), /host_changed/);
  host = { async call() { return {}; } };
  await assert.rejects(service.list("plugin.one"), /host_changed/);
});
