import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createSyncServer } from "./http.js";

function frame(socket: WebSocket, type: string, id?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", read); reject(new Error(`Missing ${type} frame`)); }, 3000);
    const read = (event: MessageEvent) => {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (data.type !== type || (id && data.id !== id)) return;
      clearTimeout(timer); socket.removeEventListener("message", read); resolve(data);
    };
    socket.addEventListener("message", read);
  });
}
it("routes shared project continuation only to its declared local executor and session", async () => {
  const db = new DatabaseSync(":memory:");
  const server = createSyncServer({ db, accounts: new Map() });
  const sockets: WebSocket[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, body: unknown, token?: string) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  async function connect(token: string, id: string, kind: string) {
    const socket = new WebSocket(base.replace("http", "ws") + "/v1/hub"); sockets.push(socket);
    const welcome = frame(socket, "welcome");
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", key: token, device: { id, kind, name: id, actions: kind === "web" ? [] : ["task", "stop"] } })));
    await welcome; return socket;
  }
  try {
    const { token } = await (await request("/v1/auth/register", { account: "route-one", password: "secret1" })).json() as { token: string };
    const second = await (await request("/v1/auth/register", { account: "route-two", password: "secret1" })).json() as { token: string };
    const desktop = await connect(token, "desktop-one", "computer");
    await connect(token, "desktop-two", "computer");
    const web = await connect(token, "web-one", "web");
    const otherWeb = await connect(second.token, "web-other", "web");
    const pushed = await request("/v1/sync/changes", { device: "desktop-one", conversations: [{
      cid: "project-conversation", kind: "side", title: "Project task", project_id: "project-one", project_name: "One",
      execution_device: "desktop-one", session_id: "local-session", created_at: 1700000000, updated_at: 1700000000,
    }], messages: [] }, token);
    expect(await pushed.json()).toMatchObject({ accepted: 1, rejected: [] });
    for (const [id, to, args] of [
      ["wrong-cid", "desktop-one", { cid: "missing-conversation", sessionId: "local-session" }],
      ["wrong-session", "desktop-one", { cid: "project-conversation", sessionId: "another-session" }],
      ["wrong-device", "desktop-two", { cid: "project-conversation", sessionId: "local-session" }],
    ] as const) {
      const refused = frame(web, "error", id);
      web.send(JSON.stringify({ type: "call", id, to, action: "task", args: { ...args, text: "hello", conversation: "web-thread" } }));
      expect(await refused).toMatchObject({ code: "session_not_shared" });
    }
    const cross = frame(otherWeb, "error", "cross-account");
    otherWeb.send(JSON.stringify({ type: "call", id: "cross-account", to: "desktop-one", action: "task", args: { cid: "project-conversation", sessionId: "local-session", text: "hello", conversation: "web-thread" } }));
    expect(await cross).toMatchObject({ code: "device_offline" });
    const called = frame(desktop, "call", "continued");
    web.send(JSON.stringify({ type: "call", id: "continued", to: "desktop-one", action: "task", args: { cid: "project-conversation", sessionId: "local-session", text: "continue", conversation: "web-thread" } }));
    expect(await called).toMatchObject({ action: "task", args: { sessionId: "local-session", cid: "project-conversation" } });
    const answer = frame(web, "result", "continued");
    desktop.send(JSON.stringify({ type: "result", id: "continued", ok: true, body: { text: "Original project continued" } }));
    expect(await answer).toMatchObject({ ok: true, body: { text: "Original project continued" } });
    for (const action of ["interactive.list", "interactive.resolve"]) {
      const id = "valid-" + action;
      const forwarded = frame(desktop, "call", id);
      web.send(JSON.stringify({ type: "call", id, to: "desktop-one", action, args: { cid: "project-conversation", sessionId: "local-session", conversation: "web-thread", id: "opaque-token", decision: "deny" } }));
      expect(await forwarded).toMatchObject({ action, args: { sessionId: "local-session" } });
      const reply = frame(web, "result", id);
      desktop.send(JSON.stringify({ type: "result", id, ok: true, body: { cards: [], ok: true } }));
      expect(await reply).toMatchObject({ ok: true });
      const wrong = frame(web, "error", "wrong-" + action);
      web.send(JSON.stringify({ type: "call", id: "wrong-" + action, to: "desktop-one", action, args: { cid: "project-conversation", sessionId: "another-local-session", conversation: "web-thread" } }));
      expect(await wrong).toMatchObject({ code: "session_not_shared" });
    }

  } finally {
    for (const socket of sockets) socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve())); db.close();
  }
});
