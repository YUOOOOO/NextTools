import assert from "node:assert/strict";
import test from "node:test";
import { createConversationInteractiveBridge } from "../electron/main/conversation-interactive-bridge.mjs";

const permission = { sessionId: "project-session", requestId: "private-permission-id", toolCallId: "tool-write", toolName: "Write", argsPreview: "write fixture.txt SECRET", risk: "high", reason: "Changes a file" };
const ask = { sessionId: "project-session", requestId: "private-question-id", toolCallId: "tool-question", questions: [
  { question: "Choose one", options: ["First", { label: "Second", description: "Details" }] },
  { question: "Choose several", options: ["One", "Two"], multiSelect: true },
] };
function fixture() {
  const host = {}, sidecar = {}, controller = new AbortController(); let turn = "turn-one", instant = 1000;
  let snapshot = { permissions: [structuredClone(permission)], asks: [structuredClone(ask)] };
  let load = async () => structuredClone(snapshot), answer = async () => ({ ok: true });
  const backend = { host, sidecar }, resolutions = [];
  const context = { scope: "server/account-one", caller: { id: "web-one" }, signal: controller.signal };
  const args = { sessionId: "project-session", conversation: "web-thread" };
  const bridge = createConversationInteractiveBridge({
    authorize(input, ctx) { if (ctx.scope !== context.scope || input.sessionId !== args.sessionId) throw Object.assign(new Error("session_not_shared"), { code: "session_not_shared" }); return input.sessionId; },
    getHost: () => backend.host, getSidecar: () => backend.sidecar, currentTurn: () => turn,
    pending: () => load(),
    async resolvePermission(value) { resolutions.push(["permission", value]); const result = await answer(); snapshot.permissions = []; return result; },
    async resolveAsk(value) { resolutions.push(["ask", value]); const result = await answer(); snapshot.asks = []; return result; },
    redact: (value) => typeof value === "string" ? value.replaceAll("SECRET", "[REDACTED]") : value,
    now: () => instant, ttlMs: 100,
  });
  return { bridge, context, args, snapshot, resolutions, controller, backend,
    setTurn(value) { turn = value; }, setTime(value) { instant = value; }, load(fn) { load = fn; }, answer(fn) { answer = fn; } };
}
for (const decision of ["allow-once", "deny"]) test(`permission card user path: list → ${decision} → removed → replay rejected`, async () => {
  const f = fixture(); const result = await f.bridge.list(f.args, f.context);
  const card = result.cards.find((c) => c.kind === "permission");
  assert(card); assert.equal(result.cards.length, 2);
  assert(!JSON.stringify(result).includes("private-permission-id")); assert(!JSON.stringify(result).includes("SECRET"));
  assert.equal((await f.bridge.list(f.args, f.context)).cards[0].id, card.id);
  assert.deepEqual(await f.bridge.resolve({ ...f.args, id: card.id, decision }, f.context), { ok: true });
  assert.deepEqual(f.resolutions, [["permission", { requestId: permission.requestId, decision }]]);
  assert.equal((await f.bridge.list(f.args, f.context)).cards.some((c) => c.kind === "permission"), false);
  await assert.rejects(f.bridge.resolve({ ...f.args, id: card.id, decision }, f.context), { code: "card_expired" });
});
test("ask card accepts single/multiple/custom answers and decline without duplicate execution", async () => {
  for (const answers of [[["Custom answer"], ["One", "Two"]], [null, null]]) {
    const f = fixture(); const card = (await f.bridge.list(f.args, f.context)).cards.find((c) => c.kind === "ask");
    assert.deepEqual(await f.bridge.resolve({ ...f.args, id: card.id, answers }, f.context), { ok: true });
    assert.deepEqual(f.resolutions[0], ["ask", { sessionId: "project-session", requestId: ask.requestId, answers }]);
    assert.equal((await f.bridge.list(f.args, f.context)).cards.some((c) => c.kind === "ask"), false);
  }
});
test("wrong callers, accounts and sessions cannot consume a card", async () => {
  const f = fixture(); const card = (await f.bridge.list(f.args, f.context)).cards[0];
  await assert.rejects(f.bridge.resolve({ ...f.args, id: card.id, decision: "allow-once" }, { ...f.context, caller: { id: "other-tab" } }), { code: "card_expired" });
  await assert.rejects(f.bridge.resolve({ ...f.args, id: card.id, decision: "allow-once" }, { ...f.context, scope: "other-account" }), { code: "session_not_shared" });
  await assert.rejects(f.bridge.resolve({ ...f.args, sessionId: "other-session", id: card.id, decision: "deny" }, f.context), { code: "session_not_shared" });
  assert.equal(f.resolutions.length, 0);
});
test("desktop decisions, terminal/new turns, TTL expiry and changed requests reject stale cards", async () => {
  for (const change of [f => { f.snapshot.permissions.length = 0; }, f => f.setTurn(null), f => f.setTurn("turn-two"), f => f.setTime(1200), f => { f.snapshot.permissions[0].argsPreview = "changed command"; }]) {
    const f = fixture(); const card = (await f.bridge.list(f.args, f.context)).cards[0]; change(f);
    await assert.rejects(f.bridge.resolve({ ...f.args, id: card.id, decision: "allow-once" }, f.context), { code: "card_expired" });
    assert.equal(f.resolutions.length, 0);
  }
});
test("concurrent tabs share a one-shot request lock and consume all tokens", async () => {
  const f = fixture(), other = { ...f.context, caller: { id: "other-tab" } };
  const a = (await f.bridge.list(f.args, f.context)).cards[0], b = (await f.bridge.list(f.args, other)).cards[0];
  let release; f.answer(() => new Promise(resolve => { release = resolve; }));
  const pending = f.bridge.resolve({ ...f.args, id: a.id, decision: "allow-once" }, f.context);
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(f.bridge.resolve({ ...f.args, id: b.id, decision: "deny" }, other), { code: "card_busy" });
  release({ ok: true }); await pending; assert.equal(f.resolutions.length, 1);
  await assert.rejects(f.bridge.resolve({ ...f.args, id: b.id, decision: "deny" }, other), { code: "card_expired" });
});
test("answers validate shape, count, single-select, size and allowed decisions", async () => {
  const f = fixture(); const cards = (await f.bridge.list(f.args, f.context)).cards;
  for (const answers of [[], [["One", "Two"], null], [[123], null], [[""], null], [["x".repeat(4001)], null], [["a"], ["b", "b"]]]) {
    await assert.rejects(f.bridge.resolve({ ...f.args, id: cards[1].id, answers }, f.context), { code: "invalid_answer" });
  }
  await assert.rejects(f.bridge.resolve({ ...f.args, id: cards[0].id, decision: "allow-session" }, f.context), { code: "invalid_answer" });
  assert.equal(f.resolutions.length, 0);
});
test("cancel, backend replacement and turn change during an await fail closed", async () => {
  for (const mutate of [f => f.controller.abort(), f => { f.backend.host = {}; }, f => f.setTurn("new-turn")]) {
    const f = fixture(); let release; f.load(() => new Promise(resolve => { release = resolve; }));
    const pending = f.bridge.list(f.args, f.context); mutate(f); release(f.snapshot);
    await assert.rejects(pending); assert.equal(f.resolutions.length, 0);
  }
});
test("already-resolved external failures do not leak internal error bodies", async () => {
  const f = fixture(); const card = (await f.bridge.list(f.args, f.context)).cards[0];
  f.answer(async () => { throw new Error("SECRET_PROVIDER_ERROR"); });
  await assert.rejects(f.bridge.resolve({ ...f.args, id: card.id, decision: "deny" }, f.context), { code: "card_expired", message: "card_expired" });
});


test("dispose invalidates asynchronous snapshots and failed resolvers never report success", async () => {
  const f = fixture(); let release; f.load(() => new Promise(resolve => { release = resolve; }));
  const pending = f.bridge.list(f.args, f.context); f.bridge.dispose(); release(f.snapshot);
  await assert.rejects(pending, { code: "card_expired" });
  const second = fixture(); const card = (await second.bridge.list(second.args, second.context)).cards[0];
  second.answer(async () => ({ ok: false }));
  await assert.rejects(second.bridge.resolve({ ...second.args, id: card.id, decision: "allow-once" }, second.context), { code: "card_expired" });
  second.load(async () => { throw new Error("SECRET_PENDING_BODY"); });
  await assert.rejects(second.bridge.list(second.args, second.context), { code: "interactive_unavailable", message: "interactive_unavailable" });
});


test("redacted selected options resolve to original labels using opaque option tokens", async () => {
  const f = fixture(); f.snapshot.asks[0].questions[0].options = ["SECRET original selection"];
  const card = (await f.bridge.list(f.args, f.context)).cards.find((c) => c.kind === "ask");
  assert.equal(card.questions[0].options[0].label, "[REDACTED] original selection");
  const option = card.questions[0].options[0].id;
  await f.bridge.resolve({ ...f.args, id: card.id, answers: [[{ option }], null] }, f.context);
  assert.deepEqual(f.resolutions[0][1].answers, [["SECRET original selection"], null]);
});

test("issued backend replacement and expiration during pending lookup invalidate resolution", async () => {
  for (const mutate of [f => { f.backend.host = {}; }, f => { f.backend.sidecar = {}; }]) {
    const f = fixture(); const card = (await f.bridge.list(f.args, f.context)).cards[0]; mutate(f);
    await assert.rejects(f.bridge.resolve({ ...f.args, id: card.id, decision: "deny" }, f.context), { code: "card_expired" });
    assert.equal(f.resolutions.length, 0);
    const refreshed = (await f.bridge.list(f.args, f.context)).cards[0]; assert.notEqual(refreshed.id, card.id);
  }
  const f = fixture(); const card = (await f.bridge.list(f.args, f.context)).cards[0]; let release;
  f.load(() => new Promise(resolve => { release = resolve; }));
  const pending = f.bridge.resolve({ ...f.args, id: card.id, decision: "allow-once" }, f.context);
  f.setTime(1200); release(f.snapshot);
  await assert.rejects(pending, { code: "card_expired" }); assert.equal(f.resolutions.length, 0);
});
