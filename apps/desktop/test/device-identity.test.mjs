import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationSync } from "../electron/main/conversation-sync-client.mjs";
import { desktopDeviceName, desktopOsLabel } from "../electron/main/device-identity.mjs";

test("device identity shows the computer name and a readable OS", () => {
  assert.equal(desktopDeviceName("DESKTOP-ABC"), "DESKTOP-ABC");
  assert.equal(desktopDeviceName("  padded  "), "padded");
  assert.equal(desktopDeviceName(""), "Pilot");
  assert.equal(desktopDeviceName("   "), "Pilot");
  assert.equal(desktopDeviceName("x".repeat(80)).length, 60);

  // The Node platform id ("win32") must never reach the device list.
  assert.equal(desktopOsLabel("win32", "10.0.22631"), "Windows 11");
  assert.equal(desktopOsLabel("win32", "10.0.19045"), "Windows 10");
  assert.equal(desktopOsLabel("win32", ""), "Windows");
  assert.equal(desktopOsLabel("darwin", "23.0.0"), "macOS");
  assert.equal(desktopOsLabel("linux", "6.1.0"), "Linux");
  assert.equal(desktopOsLabel("freebsd", ""), "freebsd");
});

test("hub hello registers the computer name, not the platform id", async () => {
  class RecordingSocket {
    static instances = [];
    readyState = 1;
    sent = [];
    listeners = new Map();
    constructor() { RecordingSocket.instances.push(this); }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    send(data) { this.sent.push(JSON.parse(String(data))); }
    close() { this.readyState = 3; this.fire("close", {}); }
    fire(type, event) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event); }
  }
  const dir = mkdtempSync(join(tmpdir(), "device-identity-"));
  const sync = createConversationSync({
    filePath: join(dir, "session.json"),
    encrypt: (value) => value,
    decrypt: (value) => value,
    encryptionAvailable: () => true,
    deviceId: "desktop-identity",
    WebSocketImpl: RecordingSocket,
    listSessions: async () => [],
    onCall: async () => ({}),
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/auth/login")) return { ok: true, json: async () => ({ token: "token-1", account: "alice" }) };
      return { ok: true, json: async () => ({ enabled: true }) };
    },
  });
  try {
    await sync.signIn({ baseUrl: "http://127.0.0.1:8788", account: "alice", password: "secret1" });
    const socket = RecordingSocket.instances.at(-1);
    socket.fire("open", {});
    const hello = socket.sent.find((frame) => frame.type === "hello");
    assert.ok(hello, "hello frame is sent once the hub socket opens");
    assert.equal(hello.device.name, desktopDeviceName());
    assert.equal(hello.device.name.includes("win32"), false);
    assert.equal(hello.device.kind, "computer");
    assert.equal(hello.device.os, desktopOsLabel());
    if (["win32", "darwin", "linux"].includes(process.platform)) {
      assert.notEqual(hello.device.os, process.platform);
    }
  } finally {
    await sync.signOut();
    rmSync(dir, { recursive: true, force: true });
  }
});
