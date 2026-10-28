import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { createConversationSync } from "../electron/main/conversation-sync-client.mjs";
import { createConversationTaskBridge } from "../electron/main/conversation-task-bridge.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only external Host/sidecar/transport edges are fixtures. The client, lifecycle
// ownership, task execution, event projection and conversation mapping are real.
function runtime() {
  const listeners = new Set();
  const calls = [];
  const admissions = [];
  const aborts = [];
  const host = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "session.create") return { session: { id: `web-session-${calls.filter((c) => c.method === method).length}` } };
      if (method === "session.configure") return {};
      throw new Error(`Unexpected host method: ${method}`);
    },
  };
  const sidecar = {
    onNotification(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const handles = { host, sidecar };
  const bridge = createConversationTaskBridge({
    getHost: () => handles.host,
    getSidecar: () => handles.sidecar,
    prompt(request) {
      const admission = { request, ...deferred() };
      admissions.push(admission);
      return admission.promise;
    },
    async abort(request) { aborts.push(request); return { ok: true }; },
  });
  const emit = (sessionId, turnId, event, extra = {}) => {
    for (const listener of [...listeners]) listener("agent.event", { sessionId, turnId, event, ...extra });
  };
  const events = [];
  const controller = new AbortController();
  const context = { scope: "account-scope", caller: { id: "browser-one" }, signal: controller.signal, emit: (body) => events.push(body) };
  return { bridge, host, sidecar, handles, listeners, calls, admissions, aborts, emit, events, controller, context };
}

function complete(fixture, turn = "turn-one", text = "Actual final answer") {
  const admission = fixture.admissions.at(-1);
  const sessionId = admission.request.sessionId;
  admission.resolve({ accepted: true, turnId: turn });
  fixture.emit(sessionId, turn, { type: "message_end", message: { role: "assistant", content: text } });
  fixture.emit(sessionId, turn, { type: "agent_end", messageIds: ["answer"] });
}

test("task waits for its final answer, projects safe progress, and reuses only its dedicated session", async () => {
  const f = runtime();
  let resolved = false;
  const first = f.bridge.task({ text: "Do the task", conversation: "conversation-one", from: "a forged label" }, f.context);
  first.then(() => { resolved = true; });
  await tick();
  assert.equal(f.admissions.length, 1);
  const sessionId = f.admissions[0].request.sessionId;
  assert.equal(sessionId, "web-session-1");
  assert.deepEqual(f.calls.map((c) => c.method), ["session.create", "session.configure"]);
  assert.deepEqual(f.calls[1].params, { id: sessionId, mode: "agent", permissionMode: "ask" });
  assert.equal(f.admissions[0].request.content, "Do the task");
  assert.deepEqual(f.events[0], { stage: "session", sessionId });
  assert.equal("permissionMode" in f.admissions[0].request, false);
  f.admissions[0].resolve({ accepted: true, turnId: "turn-one" });
  await tick();
  assert.equal(resolved, false, "acceptance must not be returned as the answer");
  f.emit("another-session", "turn-one", { type: "agent_end" });
  f.emit(sessionId, "old-turn", { type: "message_end", message: { role: "assistant", content: "stale answer" } });
  f.emit(sessionId, "turn-one", { type: "message_end", message: { role: "assistant", content: "delegate answer" } }, { parentToolCallId: "task-tool" });
  f.emit(sessionId, "turn-one", { type: "message_update", message: { role: "assistant" }, deltaThinking: "private reasoning" });
  f.emit(sessionId, "turn-one", { type: "tool_start", toolName: "Read", args: { token: "SECRET_TOOL_ARGUMENT" } });
  f.emit(sessionId, "turn-one", { type: "tool_end", result: "SECRET_TOOL_RESULT" });
  f.emit(sessionId, "turn-one", { type: "tool_permission_request", request: { id: "approval" } });
  assert.equal(resolved, false, "permissions remain in the local approval flow");
  f.emit(sessionId, "turn-one", { type: "message_update", message: { role: "assistant" }, deltaText: "Actual" });
  f.emit(sessionId, "turn-one", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Actual final answer" }] } });
  f.emit(sessionId, "turn-one", { type: "turn_end" });
  assert.equal(resolved, false, "turn_end can precede later tool/model steps");
  f.emit(sessionId, "turn-one", { type: "agent_end" });
  assert.deepEqual(await first, { text: "Actual final answer" });
  assert.deepEqual(f.events.map((e) => e.stage), ["session", "thinking", "tool", "text", "text", "done"]);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET|private reasoning|delegate answer|stale answer/);
  assert.equal(f.listeners.size, 0);

  const second = f.bridge.task({ text: "Continue", conversation: "conversation-one" }, f.context);
  await tick();
  assert.equal(f.admissions[1].request.sessionId, sessionId);
  complete(f, "turn-two", "Second answer");
  assert.deepEqual(await second, { text: "Second answer" });
  assert.equal(f.calls.filter((c) => c.method === "session.create").length, 1);
});

test("notifications arriving before admission are correlated to the returned turn", async () => {
  const f = runtime();
  const task = f.bridge.task({ text: "Fast", conversation: "fast" }, f.context);
  await tick();
  f.emit("web-session-1", "old-turn", { type: "agent_end" });
  complete(f);
  assert.deepEqual(await task, { text: "Actual final answer" });
  assert.equal(f.listeners.size, 0);
});

test("busy and stop are scoped to authenticated caller, account, and conversation", async () => {
  const f = runtime();
  const args = { text: "Wait", conversation: "same" };
  const task = f.bridge.task(args, f.context);
  const rejected = assert.rejects(task, { code: "cancelled" });
  await tick();
  await assert.rejects(f.bridge.task(args, f.context), { code: "busy" });
  assert.deepEqual(await f.bridge.stop(args, { ...f.context, caller: { id: "other-browser" } }), { stopped: false });
  assert.deepEqual(await f.bridge.stop(args, { ...f.context, scope: "other-account" }), { stopped: false });
  assert.deepEqual(await f.bridge.stop(args, f.context), { stopped: true });
  assert.equal(f.listeners.size, 0);
  await assert.rejects(f.bridge.task(args, f.context), { code: "busy" });
  f.admissions[0].resolve({ accepted: true, turnId: "only-this-turn" });
  await rejected;
  assert.deepEqual(f.aborts, [{ sessionId: "web-session-1", turnId: "only-this-turn" }]);
  const events = [...f.events];
  f.emit("web-session-1", "only-this-turn", { type: "agent_end" });
  assert.deepEqual(f.events, events);
  assert.deepEqual(await f.bridge.stop(args, f.context), { stopped: false });
});

test("stop after admission aborts the exact turn and cleans listeners", async () => {
  const f = runtime();
  const task = f.bridge.task({ text: "Wait", conversation: "one" }, f.context);
  const rejected = assert.rejects(task, { code: "cancelled" });
  await tick();
  f.admissions[0].resolve({ accepted: true, turnId: "running-turn" });
  await tick();
  await f.bridge.stop({ conversation: "one" }, f.context);
  await rejected;
  assert.deepEqual(f.aborts, [{ sessionId: "web-session-1", turnId: "running-turn" }]);
  assert.equal(f.listeners.size, 0);
});

test("cancel during session creation never dispatches a prompt", async () => {
  const f = runtime();
  const created = deferred();
  f.host.call = () => created.promise;
  const task = f.bridge.task({ text: "Wait", conversation: "one" }, f.context);
  const rejected = assert.rejects(task, { code: "cancelled" });
  f.controller.abort();
  created.resolve({ session: { id: "late-session" } });
  await rejected;
  assert.equal(f.admissions.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("different conversations, callers, and accounts never select a user's latest session", async () => {
  const f = runtime();
  for (const [conversation, context] of [
    ["one", f.context], ["two", f.context], ["one", { ...f.context, caller: { id: "other" } }],
    ["one", { ...f.context, scope: "another-account" }],
  ]) {
    const task = f.bridge.task({ text: "Hello", conversation }, context);
    await tick();
    complete(f);
    await task;
  }
  assert.deepEqual(f.admissions.map((a) => a.request.sessionId), ["web-session-1", "web-session-2", "web-session-3", "web-session-4"]);
});

test("terminal errors are sanitized; an empty answer is not reported as acceptance", async () => {
  for (const [event, code] of [
    [{ type: "error", error: { message: "SECRET_PROVIDER_KEY" } }, "task_failed"],
    [{ type: "agent_end" }, "no_answer"],
  ]) {
    const f = runtime();
    const task = f.bridge.task({ text: "Fail", conversation: "one" }, f.context);
    const rejected = assert.rejects(task, { code });
    await tick();
    f.admissions[0].resolve({ accepted: true, turnId: "failure-turn" });
    f.emit("web-session-1", "failure-turn", event);
    await rejected;
    assert.equal(f.listeners.size, 0);
    assert.equal(f.events.at(-1).stage, "error");
    assert.doesNotMatch(JSON.stringify(f.events), /SECRET_PROVIDER_KEY/);
  }
});

test("prompt rejection releases busy lease and notification listener", async () => {
  const f = runtime();
  const task = f.bridge.task({ text: "Fail", conversation: "one" }, f.context);
  const rejected = assert.rejects(task, { code: "task_failed" });
  await tick();
  f.admissions[0].reject(new Error("SECRET_ADMISSION_ERROR"));
  await rejected;
  assert.equal(f.listeners.size, 0);
  assert.doesNotMatch(JSON.stringify(f.events), /SECRET_ADMISSION_ERROR/);
  assert.deepEqual(await f.bridge.stop({ conversation: "one" }, f.context), { stopped: false });
});

class SocketFixture extends EventTarget {
  static sockets = [];
  readyState = 0;
  sent = [];
  constructor(url) { super(); this.url = url; SocketFixture.sockets.push(this); }
  send(text) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  call(id, action, args, from = { id: "web-tab", name: "Browser", kind: "web" }) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "call", id, action, args, from }) }));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

async function connected(t, f = runtime()) {
  const dir = mkdtempSync(join(tmpdir(), "conversation-task-test-"));
  const sync = createConversationSync({
    filePath: join(dir, "login.json"), encrypt: (s) => s, decrypt: (s) => s, encryptionAvailable: () => true,
    listSessions: async () => [], WebSocketImpl: SocketFixture,
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: "FIXTURE_TOKEN", account: "fixture-account" }) }),
    onCall(action, args, context) {
      if (action === "task") return f.bridge.task(args, context);
      if (action === "stop") return f.bridge.stop(args, context);
      if (action === "info") return { name: "Pilot" };
      throw new Error("unknown action");
    },
  });
  t.after(async () => { await sync.signOut(); rmSync(dir, { recursive: true, force: true }); });
  await sync.signIn({ baseUrl: "http://fixture.invalid", account: "fixture-account", password: "fixture-password" });
  const socket = SocketFixture.sockets.at(-1);
  socket.open();
  return { ...f, sync, socket };
}

test("hub task user path: advertised actions, progress events, final result, continuation, and stop", async (t) => {
  const f = await connected(t);
  const { socket } = f;
  assert.ok(socket.sent[0].device.actions.includes("task"));
  assert.ok(socket.sent[0].device.actions.includes("stop"));
  assert.ok(socket.sent[0].device.actions.includes("shell"));
  socket.call("call-one", "task", { text: "Answer", conversation: "browser-conversation", from: "web console" });
  await tick();
  assert.equal(socket.sent.some((e) => e.type === "result"), false);
  complete(f);
  await tick();
  assert.deepEqual(socket.sent.find((e) => e.type === "result"), { type: "result", id: "call-one", ok: true, body: { text: "Actual final answer" } });
  assert.deepEqual(socket.sent.filter((e) => e.type === "event").map((e) => [e.id, e.body.stage]), [
    ["call-one", "session"], ["call-one", "thinking"], ["call-one", "text"], ["call-one", "done"],
  ]);
  assert.doesNotMatch(JSON.stringify(socket.sent.slice(1)), /FIXTURE_TOKEN/);
  socket.call("call-two", "task", { text: "Continue", conversation: "browser-conversation" });
  await tick();
  assert.equal(f.admissions[1].request.sessionId, f.admissions[0].request.sessionId);
  socket.call("call-stop", "stop", { conversation: "browser-conversation" });
  await tick();
  f.admissions[1].resolve({ accepted: true, turnId: "turn-two" });
  await tick();
  assert.deepEqual(socket.sent.find((e) => e.id === "call-stop").body, { stopped: true });
  assert.equal(socket.sent.find((e) => e.id === "call-two" && e.type === "result").error, "cancelled");
  assert.deepEqual(f.aborts, [{ sessionId: "web-session-1", turnId: "turn-two" }]);
  assert.equal(f.listeners.size, 0);
});

for (const loss of ["signout", "close", "error", "replace-account"]) {
  test(`hub ${loss} aborts in-flight task and suppresses all stale results and events`, async (t) => {
    const f = await connected(t);
    f.socket.call("old-call", "task", { text: "Wait", conversation: "one" });
    await tick();
    const count = f.socket.sent.length;
    if (loss === "signout") await f.sync.signOut();
    else if (loss === "close") f.socket.close();
    else if (loss === "error") f.socket.dispatchEvent(new Event("error"));
    else await f.sync.signIn({ baseUrl: "http://other-fixture.invalid", account: "fixture-account", password: "fixture-password" });
    assert.equal(f.listeners.size, 0);
    complete(f, "late-turn", "Must not reach old socket");
    await tick();
    assert.equal(f.socket.sent.length, count);
    assert.deepEqual(f.aborts, [{ sessionId: "web-session-1", turnId: "late-turn" }]);
    f.socket.call("stale-call", "task", { text: "Never dispatch", conversation: "two" });
    await tick();
    assert.equal(f.admissions.length, 1);
  });
}

test("a repeated in-flight hub call id is dispatched once and old actions still work", async (t) => {
  const f = await connected(t);
  f.socket.call("duplicate", "task", { text: "Once", conversation: "one" });
  f.socket.call("duplicate", "task", { text: "Twice", conversation: "one" });
  f.socket.call("info-call", "info", {});
  await tick();
  assert.equal(f.admissions.length, 1);
  complete(f);
  await tick();
  assert.deepEqual(f.socket.sent.find((e) => e.id === "info-call").body, { name: "Pilot" });
  assert.equal(f.socket.sent.filter((e) => e.id === "duplicate" && e.type === "result").length, 1);
});


test("socket loss while sending first progress must not dispatch the prompt", async () => {
  const f = runtime();
  const context = { ...f.context, emit() { f.controller.abort(); } };
  await assert.rejects(f.bridge.task({ text: "Never dispatch", conversation: "one" }, context), { code: "cancelled" });
  assert.equal(f.admissions.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("timeout uses controlled time, interrupts the named turn and cleans listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = runtime();
  const task = f.bridge.task({ text: "Wait", conversation: "one" }, f.context);
  const rejected = assert.rejects(task, { code: "cancelled" });
  await tick();
  f.admissions[0].resolve({ accepted: true, turnId: "timeout-turn" });
  await tick();
  t.mock.timers.tick(600_000);
  await rejected;
  assert.deepEqual(f.aborts, [{ sessionId: "web-session-1", turnId: "timeout-turn" }]);
  assert.equal(f.listeners.size, 0);
});

test("backend replacement during admission cannot stream a stale answer", async () => {
  const f = runtime();
  const task = f.bridge.task({ text: "Wait", conversation: "one" }, f.context);
  const rejected = assert.rejects(task, { code: "agent_unavailable" });
  await tick();
  f.handles.sidecar = null;
  complete(f);
  await rejected;
  assert.deepEqual(f.events.map((e) => e.stage), ["session", "thinking", "error"]);
  assert.equal(f.listeners.size, 0);
});

test("missing normal Agent handler fails closed, without creating a session", async () => {
  const f = runtime();
  const bridge = createConversationTaskBridge({ getHost: () => f.host, getSidecar: () => f.sidecar });
  await assert.rejects(bridge.task({ text: "Never dispatch", conversation: "one" }, f.context), { code: "agent_unavailable" });
  assert.equal(f.calls.length, 0);
});

test("socket reconnect preserves its conversation mapping; signout cancels a scheduled reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await connected(t);
  f.socket.call("first", "task", { text: "One", conversation: "same" });
  await tick();
  complete(f);
  await tick();
  f.socket.close();
  const oldCount = SocketFixture.sockets.length;
  t.mock.timers.tick(2000);
  const next = SocketFixture.sockets.at(-1);
  assert.notEqual(next, f.socket);
  assert.equal(SocketFixture.sockets.length, oldCount + 1);
  next.open();
  next.call("second", "task", { text: "Two", conversation: "same" });
  await tick();
  assert.equal(f.admissions[1].request.sessionId, f.admissions[0].request.sessionId);
  complete(f, "second-turn");
  await tick();
  next.close();
  await f.sync.signOut();
  const afterSignout = SocketFixture.sockets.length;
  t.mock.timers.tick(10_000);
  assert.equal(SocketFixture.sockets.length, afterSignout);
});


test("cloud continuation reuses the shared project session with its existing model and mode", async () => {
  const f = runtime(); const original = f.host.call;
  f.host.call = async (method, params) => {
    if (method === "session.get") return { session: { id: "project-session", projectPath: "C:/Projects/one", mode: "plan", providerId: "provider-one", modelId: "model-one" } };
    return original(method, params);
  };
  const context = { ...f.context, isSessionShared: (id) => id === "project-session" };
  const task = f.bridge.task({ text: "Continue existing work", conversation: "cloud-conversation", sessionId: "project-session" }, context);
  await tick();
  assert.equal(f.calls.some((call) => call.method === "session.create"), false);
  assert.deepEqual(f.calls.find((call) => call.method === "session.configure").params, { id: "project-session", mode: "plan", permissionMode: "ask" });
  assert.equal(f.admissions[0].request.sessionId, "project-session");
  complete(f, "continued-turn", "continued answer"); assert.deepEqual(await task, { text: "continued answer" });
});

test("cloud continuation refuses unshared ids and missing or remote local sessions", async () => {
  const f = runtime();
  await assert.rejects(f.bridge.task({ text: "hello", conversation: "cloud", sessionId: "unshared-session" }, f.context), { code: "session_not_shared" });
  assert.equal(f.calls.length, 0);
  for (const session of [null, { id: "project-session", remoteWorkspace: { hostKey: "elsewhere" } }]) {
    f.host.call = async () => ({ session });
    await assert.rejects(f.bridge.task({ text: "hello", conversation: "cloud", sessionId: "project-session" }, { ...f.context, isSessionShared: () => true }), { code: "session_not_found" });
  }
  assert.equal(f.admissions.length, 0);
});

test("two callers cannot run or stop each other's continuation of one Host session", async () => {
  const f = runtime(); const original = f.host.call;
  f.host.call = async (method, params) => method === "session.get" ? { session: { id: "project-session", mode: "agent" } } : original(method, params);
  const context = { ...f.context, isSessionShared: () => true };
  const args = { text: "hello", conversation: "cloud", sessionId: "project-session" };
  const task = f.bridge.task(args, context); const cancelled = assert.rejects(task, { code: "cancelled" });
  await tick(); f.admissions[0].resolve({ accepted: true, turnId: "project-turn" }); await tick();
  const other = { ...context, caller: { id: "another-tab" } };
  await assert.rejects(f.bridge.task({ ...args, conversation: "another-cloud" }, other), { code: "busy" });
  assert.deepEqual(await f.bridge.stop(args, other), { stopped: false });
  assert.deepEqual(await f.bridge.stop(args, context), { stopped: true }); await cancelled;
  assert.deepEqual(f.aborts.at(-1), { sessionId: "project-session", turnId: "project-turn" });
});


test("task provenance follows authenticated caller kind, not args or display text", async () => {
  for (const [kind, expected] of [["web", "web"], ["computer", undefined], ["phone", undefined]]) {
    const f = runtime(); const context = { ...f.context, caller: { id: "caller-origin", kind } };
    const task = f.bridge.task({ text: "Hello", conversation: "origin-test", inputSource: "web", from: "web" }, context);
    await tick(); assert.equal(f.admissions[0].request.inputSource, expected);
    complete(f); await task;
  }
  const f = runtime(), original = f.host.call;
  f.host.call = async (method, params) => method === "session.get" ? { session: { id: "project-session", mode: "agent" } } : original(method, params);
  const task = f.bridge.task({ text: "Shared continuation", conversation: "origin-test", sessionId: "project-session" }, { ...f.context, caller: { id: "web-shared", kind: "web" }, isSessionShared: () => true });
  await tick(); assert.equal(f.admissions[0].request.inputSource, "web"); complete(f); await task;
});
