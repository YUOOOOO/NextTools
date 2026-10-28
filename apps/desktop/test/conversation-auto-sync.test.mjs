import assert from "node:assert/strict";
import test from "node:test";
import { createConversationAutoSync } from "../electron/main/conversation-auto-sync.mjs";

function fixture() {
  const timers = new Map(); let next = 0; const calls = []; const errors = [];
  let state = { signedIn: true, state: { enabled: true } };
  let push = async () => { calls.push("push"); };
  const auto = createConversationAutoSync({
    sync: { getState: async () => state, push: () => push() },
    onError: (error) => errors.push(error),
    setTimer(fn) { const id = ++next; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  const fire = async () => { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); };
  return { auto, calls, errors, timers, fire, state(value) { state = value; }, push(fn) { push = fn; } };
}
test("startup backfill and subsequent rounds upload enabled accounts, never signed-out or disabled ones", async () => {
  const f = fixture(); f.auto.start(); await f.fire(); assert.equal(f.calls.length, 1);
  await f.fire(); assert.equal(f.calls.length, 2);
  f.state({ signedIn: false }); await f.fire(); assert.equal(f.calls.length, 2);
  f.state({ signedIn: true, state: { enabled: false } }); await f.fire(); assert.equal(f.calls.length, 2);
  f.auto.dispose(); assert.equal(f.timers.size, 0);
});
test("completion requests coalesce, never overlap uploads, and retry after a failed round", async () => {
  const f = fixture(); let release; let count = 0;
  f.push(async () => { count++; await new Promise((resolve) => { release = resolve; }); });
  f.auto.start(); const round = f.fire(); await Promise.resolve(); await Promise.resolve();
  f.auto.request(); f.auto.request(); assert.equal(count, 1); assert.equal(f.timers.size, 0);
  release(); await round; assert.equal(f.timers.size, 1);
  f.push(async () => { throw new Error("offline"); }); await f.fire(); assert.equal(f.errors.length, 1);
  f.push(async () => { count++; }); await f.fire(); assert.equal(count, 2);
  f.auto.dispose();
});
test("dispose during an upload cannot create another timer", async () => {
  const f = fixture(); let release;
  f.push(() => new Promise((resolve) => { release = resolve; })); f.auto.start();
  const round = f.fire(); await Promise.resolve(); await Promise.resolve(); f.auto.dispose(); release(); await round;
  assert.equal(f.timers.size, 0);
});
