import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createSyncServer } from "./http.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

it("forwards a web call to the computer and refuses to call the browser", async () => {
  const db = new DatabaseSync(":memory:");
  const server = createSyncServer({ db, accounts: new Map() });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const registered = await fetch(`http://127.0.0.1:${address.port}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "ada", password: "secret1" }),
  });
  const token = ((await registered.json()) as { token: string }).token;
  const computer = new WebSocket(`ws://127.0.0.1:${address.port}/v1/hub`);
  const web = new WebSocket(`ws://127.0.0.1:${address.port}/v1/hub`);
  const computerHello = nextFrame(computer);
  const webHello = nextFrame(web);
  computer.addEventListener("open", () => {
    computer.send(JSON.stringify({
      type: "hello",
      key: token,
      device: { id: "desktop-local", name: "Pilot", kind: "computer", actions: ["chat.send"] },
    }));
  });
  web.addEventListener("open", () => {
    web.send(JSON.stringify({ type: "hello", key: token, device: { kind: "web", name: "Browser" } }));
  });
  const welcomed = await computerHello;
  expect(welcomed.type).toBe("welcome");
  const webWelcome = await webHello;
  expect(webWelcome.type).toBe("welcome");
  const call = nextFrame(computer);
  web.send(JSON.stringify({ type: "call", id: "c1", to: "desktop-local", action: "chat.send", args: { text: "hello" } }));
  const asked = await call;
  expect(asked).toMatchObject({ type: "call", id: "c1", action: "chat.send", args: { text: "hello" } });
  const result = nextFrame(web);
  computer.send(JSON.stringify({ type: "result", id: "c1", ok: true, body: { accepted: true } }));
  expect(await result).toMatchObject({ type: "result", id: "c1", ok: true, body: { accepted: true } });
  const refused = nextFrame(computer);
  computer.send(JSON.stringify({ type: "call", id: "c2", to: webWelcome.device_id, action: "chat.send", args: {} }));
  expect(await refused).toMatchObject({ type: "error", id: "c2", code: "not_controllable" });
  computer.close();
  web.close();
});

it("remembers a computer after it disconnects and refuses chat without an upstream key", async () => {
  const db = new DatabaseSync(":memory:");
  const server = createSyncServer({ db, accounts: new Map() });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const logs: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const coded = await fetch(`${base}/v1/auth/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "ada@example.com" }),
    });
    expect(coded.status).toBe(204);
    const code = logs.at(-1)?.match(/(\d{6})/)?.[1];
    const verified = await fetch(`${base}/v1/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "ada@example.com", code }),
    });
    const session = (await verified.json()) as { token: string; account: { channel: string } };
    expect(verified.status).toBe(200);
    expect(session.account.channel).toBe("email");
    const computer = new WebSocket(`ws://127.0.0.1:${address.port}/v1/hub`);
    const hello = nextFrame(computer);
    computer.addEventListener("open", () => {
      computer.send(JSON.stringify({ type: "hello", key: session.token, device: { id: "desk-1", name: "Pilot", kind: "computer" } }));
    });
    expect((await hello).type).toBe("welcome");
    computer.close();
    await new Promise((resolve) => computer.addEventListener("close", resolve));
    const listed = await fetch(`${base}/v1/devices`, { headers: { authorization: `Bearer ${session.token}` } });
    const devices = (await listed.json()) as { devices: Array<{ id: string; online: boolean }> };
    expect(devices.devices).toContainEqual(expect.objectContaining({ id: "desk-1", online: false }));
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "none", messages: [] }),
    });
    expect(chat.status).toBe(503);
  } finally {
    console.info = original;
  }
});

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === "devices") return;
      socket.removeEventListener("message", onMessage);
      resolve(frame);
    };
    socket.addEventListener("message", onMessage);
  });
}
