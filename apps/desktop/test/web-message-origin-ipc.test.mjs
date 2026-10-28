import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import { markWebPrompt } from "../electron/main/web-message-source.mjs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");

test("only trusted Web admission persists origin on the user row, not local or serialized claims", async () => {
  const handlers = new Map(), rows = [], events = [], prompts = [];
  const host = { async call(method, params) {
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: "mixed-session", messages: rows } };
    if (method === "session.beginTurn") return { turnId: "turn-" + rows.length };
    if (method === "session.appendMessage") { rows.push(structuredClone(params.message)); return {}; }
    assert.fail(method);
  } };
  const sidecar = { setProjectInstructionRoot() {}, async call(method, params) { assert.equal(method, "agent.prompt"); prompts.push(params); return { accepted: true, turnId: params.turnId }; } };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getHost: () => host, getSidecar: () => sidecar,
    getAgentHostBridge: () => null, logger: { app() {} }, agentExtensions: {}, cancelSessionTools() {}, persistenceOutbox: {}, dataDir: "/unused",
    activeTurns: new Map(), activeTurnUsages: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    recordTurnStart() {}, isTurnDispatchable: () => true, acquireSessionOperation: async () => () => {},
    resolveAgentRuntimeLaunch: async () => ({ providerId: "fixture", modelId: "fixture", sidecarParams: { sessionId: "mixed-session", provider: { modelConfig: { input: ["text"] } } } }),
    finishTurn: async () => assert.fail("Unexpected terminal failure"), emitAgentEvent: (event) => events.push(event), setNotificationViewingSessionId() {},
    optionalWorkspaceRoot: async () => null, composerCommandService: { buildComposerCommands: async () => [] }, loadComposerTemplatesCached: async () => [],
  });
  const invoke = handlers.get(IPC.invoke.agentPrompt);
  await invoke(markWebPrompt({ sessionId: "mixed-session", content: "Hello from actual browser" }));
  await invoke({ sessionId: "mixed-session", content: "Local follow-up" });
  await invoke({ sessionId: "mixed-session", content: "来自网页", inputSource: "web" });
  const marked = markWebPrompt({ sessionId: "mixed-session", content: "Serialized copy" });
  await invoke(JSON.parse(JSON.stringify(marked)));
  assert.equal(rows[0].inputSource, "web");
  for (const row of rows.slice(1)) assert.equal(row.inputSource, undefined);
  assert.equal(events[0].event.message.inputSource, "web");
  assert.equal(prompts[0].content, "Hello from actual browser");
  assert.equal(prompts.some((prompt) => "inputSource" in prompt), false);
});
