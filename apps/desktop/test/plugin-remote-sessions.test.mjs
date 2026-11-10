import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "pi-remote-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const permissions = ["credentials.read", "credentials.write", "session.read.all", "remote.control"];
const request = { requestId: "req-1", scope: "device-1", caller: { id: "browser-1", kind: "web" }, action: "info", args: {}, sharedSessionIds: ["session-1"] };

function fixture(t, services = {}) {
  const children = [];
  const dirs = [];
  const runtime = new PluginRuntime({
    ...services,
    hostEntry: join(here, "../electron/main/plugin-host-process.mjs"),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const exited = new Promise((resolve) => child.on("exit", resolve));
      children.push({ child, exited });
      return {
        postMessage: (message) => child.connected && child.send(message),
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.disposeAll();
    await Promise.all(children.map(({ exited }) => exited));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  async function load(id, grants, body) {
    const dir = mkdtempSync(join(tmpdir(), "pi-remote-plugin-"));
    dirs.push(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, id, name: id, version: "0.0.1", main: "main.js", permissions: grants }));
    writeFileSync(join(dir, "main.js"), `module.exports = { async onLoad() { await pi.commands.register({id: ${JSON.stringify(id)}, title: "Exercise", run: async () => { ${body} }}); } };`);
    await runtime.loadFromPath(dir, grants);
  }
  async function run(id) {
    const command = runtime.getCommands().find((command) => command.id === id);
    assert.ok(command);
    await command.run();
  }
  return { runtime, load, run, children };
}

function remoteService(overrides = {}) {
  return {
    getDevice: async () => ({ id: "device-1", name: "Desktop", os: "win32" }),
    list: async () => [],
    isDeleted: async () => false,
    invoke: async () => null,
    cancel: () => {},
    reset: () => {},
    dispose: () => {},
    ...overrides,
  };
}

test("every credentials and remote API denies permission before accessing services", async (t) => {
  let accesses = 0;
  const { runtime, load, run } = fixture(t);
  const denied = async () => { accesses++; throw new Error("must not dispatch"); };
  runtime.setServices({ credentials: { get: denied, set: denied, remove: denied }, remoteSessions: remoteService({ getDevice: denied, list: denied, isDeleted: denied, invoke: denied, cancel: denied, reset: denied }) });
  await load("demo.denied", ["session.read"], `
    for (const call of [() => pi.credentials.get("token"), () => pi.credentials.set("token", "secret"), () => pi.credentials.remove("token"), () => pi.remoteSessions.getDevice(), () => pi.remoteSessions.list(), () => pi.remoteSessions.isDeleted("s"), () => pi.remoteSessions.invoke(${JSON.stringify(request)}), () => pi.remoteSessions.cancel("r"), () => pi.remoteSessions.reset()]) {
      try { await call(); } catch (error) { await pi.ui.showToast(error.code); }
    }
  `);
  await run("demo.denied");
  assert.deepEqual(runtime.drainToasts(), Array(9).fill("PERMISSION_DENIED"));
  assert.equal(accesses, 0);
});

test("credentials are addressed by authoritative owner and never enter audits", async (t) => {
  const values = new Map();
  const audits = [];
  const { runtime, load, run } = fixture(t, {
    audit: (entry) => audits.push(entry),
    credentials: {
      get: async (owner, key) => values.get(`${owner}:${key}`) ?? null,
      set: async (owner, key, value) => { values.set(`${owner}:${key}`, value); },
      remove: async (owner, key) => { values.delete(`${owner}:${key}`); },
    },
  });
  await load("demo.owner", permissions, `await pi.credentials.set("token", "private-secret"); await pi.credentials.set("pending-deletes", "x".repeat(70000)); await pi.ui.showToast(await pi.credentials.get("token") === "private-secret" ? "matched" : "wrong");`);
  await load("demo.other", permissions, `await pi.ui.showToast(String(await pi.credentials.get("token"))); await pi.credentials.remove("token");`);
  await run("demo.owner");
  await run("demo.other");
  assert.deepEqual(runtime.drainToasts(), ["matched", "null"]);
  assert.equal(values.get("demo.owner:token"), "private-secret");
  assert.equal(values.get("demo.owner:pending-deletes"), "x".repeat(70000));
  assert.equal(JSON.stringify(audits).includes("private-secret"), false);
});

test("malformed credentials and remote requests never reach a host method", async (t) => {
  let calls = 0;
  const rejectDispatch = async () => { calls++; };
  const { runtime, load, run } = fixture(t, { credentials: { get: rejectDispatch, set: rejectDispatch, remove: rejectDispatch }, remoteSessions: remoteService({ invoke: rejectDispatch, cancel: rejectDispatch, isDeleted: rejectDispatch }) });
  const invalid = [null, { ...request, action: "raw.invoke" }, { ...request, action: "toString" }, { ...request, caller: { id: "x", kind: "host" } }, { ...request, args: [] }, { ...request, sharedSessionIds: [null] }, { ...request, scope: "x".repeat(129) }, { ...request, requestId: "\u0000" }];
  await load("demo.invalid", permissions, `
    const calls = [() => pi.credentials.get("../token"), () => pi.credentials.set("token", "界".repeat(349526)), () => pi.credentials.remove("x".repeat(129)), () => pi.remoteSessions.cancel(""), () => pi.remoteSessions.isDeleted("x".repeat(257))];
    for (const input of ${JSON.stringify(invalid)}) calls.push(() => pi.remoteSessions.invoke(input));
    for (const call of calls) { try { await call(); } catch (error) { await pi.ui.showToast(error.code); } }
  `);
  await run("demo.invalid");
  assert.deepEqual(runtime.drainToasts(), Array(invalid.length + 5).fill("INVALID_ARGUMENT"));
  assert.equal(calls, 0);
});

test("remote progress is private and every allowed action reaches its owner broker", async (t) => {
  const calls = [];
  const { runtime, load, run } = fixture(t, { remoteSessions: remoteService({ invoke: async (owner, input) => { calls.push([owner, input.action]); return input.requestId; } }) });
  const actions = ["task", "stop", "interactive.list", "interactive.resolve", "info", "sessions.list", "chat.send", "shell", "files", "file.get", "file.put", "open", "screen"];
  const listener = `pi.events.on("remote-session:event", (payload) => pi.ui.showToast(pi.plugin.getId() + ":" + payload.requestId));`;
  await load("demo.receiver", permissions, `${listener} for (const action of ${JSON.stringify(actions)}) await pi.remoteSessions.invoke({...${JSON.stringify(request)}, action});`);
  await load("demo.bystander", permissions, listener);
  await run("demo.receiver");
  await run("demo.bystander");
  runtime.emitPluginEvent("demo.receiver", "remote-session:event", [{ requestId: "private", event: { type: "done" } }]);
  // A round trip flushes the preceding event and its toast through the child IPC.
  await run("demo.receiver");
  assert.deepEqual(runtime.drainToasts(), ["demo.receiver:private"]);
  assert.deepEqual(calls.slice(0, actions.length), actions.map((action) => ["demo.receiver", action]));
});

test("unload, crash and global shutdown dispose only their owner remote work", async (t) => {
  const active = new Set();
  const disposed = [];
  const { runtime, load, run, children } = fixture(t, { remoteSessions: remoteService({
    invoke: async (owner) => { active.add(owner); },
    dispose: (owner) => { disposed.push(owner); active.delete(owner); },
  }) });
  for (const owner of ["demo.unload", "demo.crash", "demo.shutdown"]) {
    await load(owner, permissions, `await pi.remoteSessions.invoke(${JSON.stringify(request)});`);
    await run(owner);
  }
  await runtime.unload("demo.unload");
  assert.deepEqual([...active], ["demo.crash", "demo.shutdown"]);
  children[1].child.kill();
  await children[1].exited;
  assert.deepEqual([...active], ["demo.shutdown"]);
  await runtime.disposeAll();
  assert.deepEqual([...active], []);
  assert.deepEqual(disposed.sort(), ["demo.crash", "demo.shutdown", "demo.unload"]);
  runtime.emitPluginEvent("demo.shutdown", "remote-session:event", [{ requestId: "late", event: {} }]);
});

test("optional services fail with UNSUPPORTED for granted plugins", async (t) => {
  const { runtime, load, run } = fixture(t);
  await load("demo.unsupported", permissions, `for (const call of [() => pi.credentials.get("token"), () => pi.remoteSessions.list()]) { try { await call(); } catch(error) { await pi.ui.showToast(error.code); } }`);
  await run("demo.unsupported");
  assert.deepEqual(runtime.drainToasts(), ["UNSUPPORTED", "UNSUPPORTED"]);
});

test("remote control alone cannot claim or continue existing local sessions", async (t) => {
  const received = [];
  const { runtime, load, run } = fixture(t, {
    remoteSessions: remoteService({ invoke: async (owner, input) => { received.push([owner, input]); } }),
  });
  const newSession = { ...request, sharedSessionIds: [] };
  const continuation = { ...newSession, args: { sessionId: "guessed-local-session" } };
  const shared = { ...newSession, sharedSessionIds: ["guessed-local-session"] };
  const listing = { ...newSession, action: "sessions.list" };
  await load("demo.remote-only", ["remote.control", "session.read"], `
    await pi.remoteSessions.invoke(${JSON.stringify(newSession)});
    for (const input of ${JSON.stringify([continuation, shared, listing])}) {
      try { await pi.remoteSessions.invoke(input); }
      catch (error) { await pi.ui.showToast(error.code); }
    }
  `);
  await run("demo.remote-only");
  assert.deepEqual(runtime.drainToasts(), Array(3).fill("PERMISSION_DENIED"));
  assert.deepEqual(received, [["demo.remote-only", newSession]]);
  await load("demo.remote-reader", permissions, `await pi.remoteSessions.invoke(${JSON.stringify(continuation)});`);
  await run("demo.remote-reader");
  assert.deepEqual(received[1], ["demo.remote-reader", continuation]);
});
