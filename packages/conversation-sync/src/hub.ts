import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AccountBook } from "./accounts.js";
import { SyncError } from "./store.js";
import { acceptWebSocket, type WsPeer } from "./ws.js";

const ID = /^[A-Za-z0-9._:-]{4,80}$/;
const KINDS = new Set(["phone", "computer", "web"]);

interface Device {
  id: string;
  name: string;
  kind: string;
  os: string;
  version: string;
  actions: string[];
  online: boolean;
  last_seen: number;
  controllable: boolean;
}

interface Connection {
  peer: WsPeer;
  accountId: string;
  token: string;
  device: Device;
}

interface Pending {
  callerId: string;
  targetId: string;
}

/**
 * Forwards hub frames inside one account. A `web` device may call, and cannot
 * be called. The hub does not run the action. Computers and phones are
 * remembered so a browser can see them after they disconnect.
 */
export class DeviceHub {
  private readonly online = new Map<string, Map<string, Connection>>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly accounts: AccountBook) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://sync.local");
    if (url.pathname !== "/v1/hub") {
      socket.destroy();
      return;
    }
    const peer = acceptWebSocket(req, socket, head);
    if (!peer) return;
    const headerToken = bearer(req.headers.authorization);
    let conn: Connection | null = null;
    const helloTimer = setTimeout(() => {
      if (!conn) peer.close();
    }, 15_000);
    peer.onMessage = (text) => {
      const frame = parseFrame(text);
      if (!conn) {
        conn = this.hello(peer, headerToken, frame);
        if (conn) clearTimeout(helloTimer);
        return;
      }
      this.route(conn, frame);
    };
    peer.onClose = () => {
      clearTimeout(helloTimer);
      if (conn) this.detach(conn);
    };
  }

  list(accountId: string): Device[] {
    return this.devices(accountId);
  }

  dropRevoked(accountId: string): void {
    for (const conn of [...(this.online.get(accountId)?.values() ?? [])]) {
      if (this.accounts.accountForToken(conn.token) !== accountId) {
        conn.peer.send(JSON.stringify({ type: "error", code: "bad_key", message: "Sign-in revoked" }));
        conn.peer.close(4001, "bad_key");
      }
    }
  }

  notifySync(accountId: string, cursor: number, fromDevice: string): void {
    const frame = JSON.stringify({ type: "sync", what: "conversations", cursor, from: fromDevice });
    for (const conn of this.online.get(accountId)?.values() ?? []) {
      if (conn.device.id !== fromDevice) conn.peer.send(frame);
    }
  }

  notifyWorking(accountId: string, body: Record<string, unknown>): void {
    const from = String(body.from ?? "");
    const frame = JSON.stringify({ type: "working", ...body });
    for (const conn of this.online.get(accountId)?.values() ?? []) {
      if (conn.device.id !== from) conn.peer.send(frame);
    }
  }

  forget(accountId: string, deviceId: string): void {
    if (this.online.get(accountId)?.has(deviceId)) {
      throw new SyncError(409, "device_online", "这台设备还连着，先在那边退出");
    }
    if (!this.accounts.forgetDevice(accountId, deviceId)) {
      throw new SyncError(404, "not_found", "没有这台设备");
    }
  }

  rename(accountId: string, deviceId: string, name: string): void {
    const clipped = name.trim().slice(0, 60);
    if (!clipped) throw new SyncError(400, "bad_request", "设备名不能为空");
    const live = this.online.get(accountId)?.get(deviceId);
    if (live) live.device.name = clipped;
    if (!this.accounts.renameDevice(accountId, deviceId, clipped) && !live) {
      throw new SyncError(404, "not_found", "没有这台设备");
    }
    this.broadcast(accountId);
  }

  private hello(peer: WsPeer, headerToken: string, frame: Record<string, unknown> | null): Connection | null {
    if (!frame || frame.type !== "hello") {
      peer.send(JSON.stringify({ type: "error", code: "bad_frame", message: "hello expected" }));
      peer.close();
      return null;
    }
    const token = headerToken || String(frame.key ?? "");
    const accountId = this.accounts.accountForToken(token);
    if (!accountId) {
      peer.send(JSON.stringify({ type: "error", code: "bad_key", message: "Unknown or revoked key" }));
      peer.close();
      return null;
    }
    const device = frame.device && typeof frame.device === "object" ? frame.device as Record<string, unknown> : {};
    const kind = String(device.kind ?? "");
    if (!KINDS.has(kind)) {
      peer.send(JSON.stringify({ type: "error", code: "bad_device", message: "kind must be phone, computer or web" }));
      peer.close();
      return null;
    }
    let id = String(device.id ?? "");
    if (kind === "web" && !id) id = `web-${randomBytes(6).toString("hex")}`;
    if (!ID.test(id)) {
      peer.send(JSON.stringify({ type: "error", code: "bad_device", message: "device id: 4–80 letters, digits, . _ : -" }));
      peer.close();
      return null;
    }
    const actions = Array.isArray(device.actions) ? device.actions.filter((item) => typeof item === "string").map(String).slice(0, 64) : [];
    const conn: Connection = {
      peer,
      accountId,
      token,
      device: {
        id,
        name: String(device.name ?? "").trim().slice(0, 60) || kind,
        kind,
        os: String(device.os ?? "").slice(0, 40),
        version: String(device.version ?? "").slice(0, 40),
        actions,
        online: true,
        last_seen: now(),
        controllable: kind !== "web",
      },
    };
    if (kind !== "web") this.accounts.rememberDevice(this.stored(conn));
    this.attach(conn);
    peer.send(JSON.stringify({
      type: "welcome",
      device_id: id,
      devices: this.devices(accountId),
      server: { version: "conversation-sync", time: now() },
    }));
    this.broadcast(accountId);
    return conn;
  }

  private route(conn: Connection, frame: Record<string, unknown> | null): void {
    if (this.accounts.accountForToken(conn.token) !== conn.accountId) {
      this.dropRevoked(conn.accountId);
      return;
    }
    if (frame?.type === "forget") {
      try {
        this.forget(conn.accountId, String(frame.device_id ?? ""));
        this.broadcast(conn.accountId);
      } catch (error) {
        if (!(error instanceof SyncError)) throw error;
        conn.peer.send(JSON.stringify({ type: "error", code: error.code, message: error.message }));
      }
      return;
    }
    if (!frame) {
      conn.peer.send(JSON.stringify({ type: "error", code: "bad_frame", message: "Frames are JSON objects" }));
      return;
    }
    if (frame.type === "ping") {
      conn.peer.send(JSON.stringify({ type: "pong", time: now() }));
      return;
    }
    if (frame.type === "devices") {
      conn.peer.send(JSON.stringify({ type: "devices", devices: this.devices(conn.accountId) }));
      return;
    }
    if (frame.type === "call") {
      this.call(conn, frame);
      return;
    }
    if (frame.type === "result" || frame.type === "event") {
      this.answer(conn, frame);
      return;
    }
    conn.peer.send(JSON.stringify({ type: "error", code: "bad_frame", message: `Unknown frame type ${String(frame.type)}` }));
  }

  private call(conn: Connection, frame: Record<string, unknown>): void {
    const id = String(frame.id ?? "");
    const to = String(frame.to ?? "");
    const action = String(frame.action ?? "");
    if (!id || !to || !action) {
      conn.peer.send(JSON.stringify({ type: "error", id, code: "bad_frame", message: "call needs id, to and action" }));
      return;
    }
    const target = this.online.get(conn.accountId)?.get(to);
    if (!target || target.peer.closed) {
      conn.peer.send(JSON.stringify({ type: "error", id, code: "device_offline", message: "That device is not connected" }));
      return;
    }
    if (target.device.kind === "web") {
      conn.peer.send(JSON.stringify({ type: "error", id, code: "not_controllable", message: "A browser tab cannot be asked to do things" }));
      return;
    }
    if (target === conn) {
      conn.peer.send(JSON.stringify({ type: "error", id, code: "self_call", message: "That is this device" }));
      return;
    }
    this.pending.set(`${conn.accountId}\n${id}`, { callerId: conn.device.id, targetId: to });
    const args = frame.args && typeof frame.args === "object" ? frame.args : {};
    target.peer.send(JSON.stringify({
      type: "call",
      id,
      from: { id: conn.device.id, name: conn.device.name, kind: conn.device.kind },
      action,
      args,
    }));
  }

  private answer(conn: Connection, frame: Record<string, unknown>): void {
    const id = String(frame.id ?? "");
    const key = `${conn.accountId}\n${id}`;
    const pending = this.pending.get(key);
    if (!pending || pending.targetId !== conn.device.id) {
      conn.peer.send(JSON.stringify({ type: "error", id, code: "unknown_call", message: "No call with that id is waiting on this device" }));
      return;
    }
    if (frame.type === "result") this.pending.delete(key);
    const caller = this.online.get(conn.accountId)?.get(pending.callerId);
    if (!caller) return;
    caller.peer.send(JSON.stringify({
      type: frame.type,
      id,
      ok: frame.ok,
      body: frame.body,
      error: frame.error,
      message: frame.message,
      from: { id: conn.device.id, name: conn.device.name, kind: conn.device.kind },
    }));
  }

  private attach(conn: Connection): void {
    let account = this.online.get(conn.accountId);
    if (!account) {
      account = new Map();
      this.online.set(conn.accountId, account);
    }
    const previous = account.get(conn.device.id);
    account.set(conn.device.id, conn);
    if (previous && previous !== conn) previous.peer.close();
  }

  private detach(conn: Connection): void {
    const account = this.online.get(conn.accountId);
    if (!account || account.get(conn.device.id) !== conn) return;
    if (conn.device.kind !== "web" && this.accounts.accountForToken(conn.token)) this.accounts.rememberDevice(this.stored(conn));
    account.delete(conn.device.id);
    if (!account.size) this.online.delete(conn.accountId);
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(`${conn.accountId}\n`)) continue;
      if (pending.targetId === conn.device.id) {
        this.pending.delete(key);
        const caller = account.get(pending.callerId);
        caller?.peer.send(JSON.stringify({
          type: "error",
          id: key.slice(conn.accountId.length + 1),
          code: "device_offline",
          message: `${conn.device.name} disconnected before answering`,
        }));
      } else if (pending.callerId === conn.device.id) {
        this.pending.delete(key);
      }
    }
    this.broadcast(conn.accountId);
  }

  private devices(accountId: string): Device[] {
    const live = this.online.get(accountId) ?? new Map();
    const seen = new Set<string>();
    const out: Device[] = [];
    for (const row of this.accounts.listDevices(accountId)) {
      const conn = live.get(row.id);
      seen.add(row.id);
      out.push(conn ? { ...conn.device, online: !conn.peer.closed, last_seen: now() } : {
        ...row,
        online: false,
        controllable: row.kind !== "web",
      });
    }
    for (const conn of live.values()) {
      if (seen.has(conn.device.id)) continue;
      out.push({ ...conn.device, online: !conn.peer.closed, last_seen: now() });
    }
    out.sort((left, right) => Number(right.online) - Number(left.online) || Number(left.kind === "web") - Number(right.kind === "web") || right.last_seen - left.last_seen);
    return out;
  }

  private broadcast(accountId: string): void {
    const frame = JSON.stringify({ type: "devices", devices: this.devices(accountId) });
    for (const conn of this.online.get(accountId)?.values() ?? []) conn.peer.send(frame);
  }

  private stored(conn: Connection) {
    return {
      accountId: conn.accountId,
      id: conn.device.id,
      name: conn.device.name,
      kind: conn.device.kind,
      os: conn.device.os,
      version: conn.device.version,
      actions: conn.device.actions,
    };
  }
}

function bearer(header: string | undefined): string {
  const value = header ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function parseFrame(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
