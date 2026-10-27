import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createSyncServer } from "./http.js";

type Frame = Record<string, unknown>;
function wait(socket: WebSocket, predicate: (frame: Frame) => boolean): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error("Expected hub frame did not arrive")); }, 3000);
    const receive = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (!predicate(frame)) return;
      clearTimeout(timer); socket.removeEventListener("message", receive); resolve(frame);
    };
    socket.addEventListener("message", receive);
  });
}
it("runs the original console's device/task/event/result/offline/forget journey and revokes live sockets", async () => {
  const db = new DatabaseSync(":memory:");
  const server = createSyncServer({ db, accounts: new Map() });
  const sockets: WebSocket[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, token?: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    const first = await (await post("/v1/auth/register", { account: "console-test", password: "secret1", device: "Web" })).json() as { token: string };
    const second = await (await post("/v1/auth/login", { account: "console-test", password: "secret1", device: "Computer" })).json() as { token: string };
    async function connect(token: string, id: string, kind: string) {
      const socket = new WebSocket(base.replace("http", "ws") + "/v1/hub"); sockets.push(socket);
      const welcomed = wait(socket, (f) => f.type === "welcome");
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", key: token, device: { id, kind, name: id, actions: kind === "web" ? [] : ["task", "stop"] } })));
      await welcomed;
      return socket;
    }
    const computer = await connect(second.token, "computer-one", "computer");
    const web = await connect(first.token, "web-one", "web");
    const task = wait(computer, (f) => f.type === "call");
    web.send(JSON.stringify({ type: "call", id: "task-one", to: "computer-one", action: "task", args: { text: "hello", conversation: "web-conversation" } }));
    expect(await task).toMatchObject({ action: "task", args: { text: "hello", conversation: "web-conversation" } });
    const progress = wait(web, (f) => f.type === "event");
    computer.send(JSON.stringify({ type: "event", id: "task-one", body: { stage: "thinking" } }));
    expect(await progress).toMatchObject({ body: { stage: "thinking" } });
    const result = wait(web, (f) => f.type === "result");
    computer.send(JSON.stringify({ type: "result", id: "task-one", ok: true, body: { text: "done" } }));
    expect(await result).toMatchObject({ ok: true, body: { text: "done" } });
    const offline = wait(web, (f) => f.type === "devices" && (f.devices as Array<{ id: string; online: boolean }>).some((d) => d.id === "computer-one" && !d.online));
    const closed = new Promise<CloseEvent>((resolve) => computer.addEventListener("close", resolve, { once: true }));
    const sessions = await (await fetch(base + "/v1/me/sessions", { headers: { authorization: `Bearer ${first.token}` } })).json() as { sessions: Array<{ prefix: string; current: boolean }> };
    const other = sessions.sessions.find((s) => !s.current)!;
    expect((await fetch(base + "/v1/me/sessions/" + other.prefix, { method: "DELETE", headers: { authorization: `Bearer ${first.token}` } })).status).toBe(204);
    expect((await closed).code).toBe(4001);
    await offline;
    const forgotten = wait(web, (f) => f.type === "devices" && !(f.devices as Array<{ id: string }>).some((d) => d.id === "computer-one"));
    web.send(JSON.stringify({ type: "forget", device_id: "computer-one" }));
    await forgotten;
    expect(db.prepare("SELECT id FROM hub_devices WHERE id='computer-one'").get()).toBeUndefined();
    const webClosed = new Promise<CloseEvent>((resolve) => web.addEventListener("close", resolve, { once: true }));
    expect((await post("/v1/auth/sign-out-all", {}, first.token)).status).toBe(204);
    expect((await webClosed).code).toBe(4001);
  } finally {
    for (const socket of sockets) socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve())); db.close();
  }
});
