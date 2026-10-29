import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { createConversationInteractiveBridge } from "../electron/main/conversation-interactive-bridge.mjs";

// Real desktop handlers + Agent Host ledger; mock only Host/sidecar process edges.
test("remote cards resolve through normal permission/ask handlers and disappear from the desktop pending ledger", async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const vite = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  const { registerAgentIpc } = await vite.ssrLoadModule("/electron/main/ipc/agent-ipc.ts");
  const { createAgentHostBridge } = await vite.ssrLoadModule("/electron/main/agent-host-bridge.ts");
  const { IPC } = await import("@pi-desktop/shared");
  const handlers = new Map(), calls = [];
  const permission = { sessionId: "card-session", requestId: "native-permission", toolCallId: "tool-permission", toolName: "Write", argsPreview: "fixture", risk: "high", reason: "fixture", createdAt: Date.now(), expiresAt: Date.now() + 60000 };
  let permissions = [permission];
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "permissions.pending") return { requests: permissions };
    if (method === "permissions.resolve") { assert.equal(params.requestId, permission.requestId); permissions = []; return { ok: true }; }
    throw new Error("Unexpected Host method: " + method);
  } };
  const sidecar = { async call(method, params) { calls.push([method, params]); if (method === "asktool.resolve") return { ok: true }; throw new Error("Unexpected sidecar method"); } };
  const invoke = async (channel, args) => { const fn = handlers.get(channel); assert(fn, channel); return fn(...args); };
  const bridge = createAgentHostBridge({ channels: IPC.invoke, getHost: () => host, log() {}, invoke });
  registerAgentIpc({ registrar: { handle(channel, fn) { handlers.set(channel, fn); } }, getHost: () => host, getSidecar: () => sidecar, getAgentHostBridge: () => bridge, logger: { app() {} } });
  const request = { sessionId: "card-session", requestId: "native-ask", toolCallId: "tool-ask", questions: [{ question: "Choose?", options: ["Yes", "No"] }] };
  bridge.ingest({ sessionId: "card-session", turnId: "card-turn", ts: Date.now(), event: { type: "agent_start" } });
  bridge.ingest({ sessionId: "card-session", turnId: "card-turn", ts: Date.now(), event: { type: "asktool_request", request } });
  const interactive = createConversationInteractiveBridge({
    authorize: () => "card-session", getHost: () => host, getSidecar: () => sidecar,
    currentTurn: (id) => bridge.observeWorkTarget(id),
    pending: (sessionId) => invoke(IPC.invoke.pendingInteractive, [{ sessionId }]),
    resolvePermission: (resolution) => invoke(IPC.invoke.toolResolvePermission, [resolution]),
    resolveAsk: (resolution) => invoke(IPC.invoke.askToolResolve, [resolution]),
  });
  const controller = new AbortController(), context = { scope: "fixture-account", caller: { id: "web-fixture" }, signal: controller.signal };
  const cards = (await interactive.list({}, context)).cards;
  assert.equal(cards.length, 2);
  await interactive.resolve({ id: cards.find((c) => c.kind === "permission").id, decision: "deny" }, context);
  await interactive.resolve({ id: cards.find((c) => c.kind === "ask").id, answers: [["Yes"]] }, context);
  assert.deepEqual(await invoke(IPC.invoke.pendingInteractive, [{ sessionId: "card-session" }]), { permissions: [], asks: [] });
  assert.deepEqual((await interactive.list({}, context)).cards, []);
  assert(calls.some(([method, params]) => method === "permissions.resolve" && params.decision === "deny"));
  assert.equal(calls.filter(([method]) => method === "asktool.resolve").length, 1);
  controller.abort(); interactive.dispose();
});
