import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { AccountBook } from "./accounts.js";
import { DeviceHub } from "./hub.js";
import { AccountPortal } from "./portal.js";
import { serveConsole } from "./console-assets.js";
import { SyncError, SyncStore, type WorkingFrame } from "./store.js";

export interface SyncServerOptions {
  db: DatabaseSync;
  /** Bearer token to account id. Missing tokens are rejected. */
  accounts: ReadonlyMap<string, string>;
  store?: SyncStore;
  onSync?: (accountId: string, cursor: number, fromDevice: string) => void;
  onWorking?: (accountId: string, frame: WorkingFrame) => void;
}

export function createSyncServer(options: SyncServerOptions): Server {
  const store = options.store ?? new SyncStore(options.db);
  const accounts = new AccountBook(options.db);
  const hub = new DeviceHub(accounts, store);
  const portal = new AccountPortal(options.db, accounts);
  const server = createServer((req, res) => {
    void handle(store, accounts, hub, portal, options, req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    hub.handleUpgrade(req, socket, head);
  });
  return server;
}

async function handle(store: SyncStore, accounts: AccountBook, hub: DeviceHub, portal: AccountPortal, options: SyncServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://sync.local");
    if (req.method === "OPTIONS") {
      writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && serveConsole(url, res)) return;
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/v1/config") return send(res, 200, { password_min_len: 6, code_ttl_s: 600 });
    if (req.method === "GET" && url.pathname === "/sync-view") {
      const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "console.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/auth/register" || url.pathname === "/v1/auth/login")) {
      const body = await readJson(req);
      const name = body.account ?? body.identifier;
      const created = url.pathname.endsWith("/register");
      const result = created ? accounts.register(name, body.password) : accounts.login(name, body.password);
      portal.authenticated(result, body.device, "password");
      return send(res, 200, sessionPayload(result));
    }
    if (req.method === "POST" && url.pathname === "/v1/auth/code") {
      const body = await readJson(req);
      accounts.requestCode(body.identifier ?? body.account);
      writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/auth/verify") {
      const body = await readJson(req);
      const result = accounts.verifyCode(body.identifier ?? body.account, body.code);
      portal.authenticated(result, body.device, "code");
      return send(res, 200, sessionPayload(result));
    }
    const accountId = accountFrom(req, options.accounts, accounts);
    if (req.method === "GET" && url.pathname === "/v1/me/sessions") {
      return send(res, 200, { sessions: portal.sessions(accountId, tokenFrom(req)) });
    }
    if (req.method === "GET" && url.pathname === "/v1/me/events") {
      return send(res, 200, { events: portal.events(accountId, numberParam(url, "limit")) });
    }
    const sessionPath = url.pathname.match(/^\/v1\/me\/sessions\/([a-f0-9]{24})$/);
    if (req.method === "DELETE" && sessionPath) {
      portal.revoke(accountId, sessionPath[1]);
      hub.dropRevoked(accountId);
      writeCors(res); res.writeHead(204); res.end(); return;
    }
    if (req.method === "POST" && url.pathname === "/v1/auth/sign-out-all") {
      portal.revokeAll(accountId);
      hub.dropRevoked(accountId);
      writeCors(res); res.writeHead(204); res.end(); return;
    }
    if (req.method === "GET" && url.pathname === "/v1/me") {
      return send(res, 200, { ...profilePayload(accounts, accountId), ...portal.me(accountId) });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: [] });
    }
    if (req.method === "GET" && (url.pathname === "/v1/me" || url.pathname === "/v1/me/profile")) {
      return send(res, 200, profilePayload(accounts, accountId));
    }
    if (req.method === "PUT" && url.pathname === "/v1/me/profile") {
      const body = await readJson(req);
      const device = String(req.headers["x-nanomuse-device"] ?? "").slice(0, 80);
      accounts.saveProfile(accountId, body, device);
      return send(res, 200, profilePayload(accounts, accountId));
    }
    if (req.method === "POST" && url.pathname === "/v1/auth/password") {
      const body = await readJson(req);
      accounts.changePassword(tokenFrom(req), body.current, body.password);
      portal.event(accountId, "password.changed");
      writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/auth/sign-out") {
      portal.signedOut(accountId, tokenFrom(req));
      hub.dropRevoked(accountId);
      writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/v1/me") {
      portal.deleteData(accountId);
      const removed = accounts.deleteAccount(tokenFrom(req));
      hub.dropRevoked(accountId);
      store.wipe(removed);
      writeCors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/devices") {
      return send(res, 200, { devices: hubDevices(hub, accountId) });
    }
    const devicePath = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
    if (devicePath && (req.method === "DELETE" || req.method === "PATCH")) {
      const deviceId = decodeURIComponent(devicePath[1] ?? "");
      if (req.method === "DELETE") {
        hub.forget(accountId, deviceId);
        writeCors(res);
        res.writeHead(204);
        res.end();
        return;
      }
      const body = await readJson(req);
      hub.rename(accountId, deviceId, String(body.name ?? ""));
      return send(res, 200, { devices: hubDevices(hub, accountId) });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await proxyChat(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/sync/state") {
      return send(res, 200, store.state(accountId));
    }
    if (req.method === "PUT" && url.pathname === "/v1/sync/state") {
      const body = await readJson(req);
      if (!("enabled" in body)) throw new SyncError(400, "bad_request", "Say enabled: true or false");
      const enabled = Boolean(body.enabled);
      const current = store.state(accountId);
      return send(res, 200, current.enabled === enabled ? current : store.setEnabled(accountId, enabled));
    }
    if (req.method === "GET" && url.pathname === "/v1/sync/conversations") {
      return send(res, 200, store.listConversations(accountId));
    }
    if (req.method === "GET" && url.pathname === "/v1/sync/changes") {
      return send(
        res,
        200,
        store.changes(
          accountId,
          numberParam(url, "since"),
          url.searchParams.has("limit") ? numberParam(url, "limit") : 500,
          url.searchParams.get("scope") ?? "all",
          numberParam(url, "tail"),
        ),
      );
    }
    if (req.method === "POST" && url.pathname === "/v1/sync/changes") {
      const body = await readJson(req);
      const device = String(body.device ?? "").slice(0, 80);
      const out = store.push(accountId, device, body.conversations ?? [], body.messages ?? []);
      if (out.accepted) {
        hub.notifySync(accountId, out.cursor, device);
        options.onSync?.(accountId, out.cursor, device);
      }
      return send(res, 200, out);
    }
    if (req.method === "DELETE" && url.pathname === "/v1/sync/changes") {
      return send(res, 200, store.wipe(accountId));
    }
    if (req.method === "POST" && url.pathname === "/v1/sync/working") {
      const body = await readJson(req);
      const cid = String(body.cid ?? "");
      if (!cid || !("working" in body)) throw new SyncError(400, "bad_request", "Say cid and working: true or false");
      const device = String(body.device ?? req.headers["x-nanomuse-device"] ?? "").slice(0, 80);
      const frame = store.setWorking(accountId, cid, device, Boolean(body.working));
      hub.notifyWorking(accountId, frame as unknown as Record<string, unknown>);
      options.onWorking?.(accountId, frame);
      res.writeHead(204);
      res.end();
      return;
    }
    const deleted = url.pathname.match(/^\/v1\/sync\/conversations\/([^/]+)$/);
    if (req.method === "GET" && deleted) {
      return send(res, 200, store.conversation(accountId, decodeURIComponent(deleted[1] ?? "")));
    }
    if (req.method === "DELETE" && deleted) {
      const cid = decodeURIComponent(deleted[1] ?? "");
      const out = store.deleteConversation(accountId, cid);
      const device = String(req.headers["x-nanomuse-device"] ?? "").slice(0, 80);
      hub.notifySync(accountId, out.cursor, device);
      options.onSync?.(accountId, out.cursor, device);
      return send(res, 200, out);
    }
    send(res, 404, { error: { message: "Not found", type: "conversation_sync", code: "not_found" } });
  } catch (error) {
    if (error instanceof SyncError) {
      send(res, error.status, {
        error: { message: error.message, type: "conversation_sync", code: error.code, ...(error.extra ?? {}) },
      });
      return;
    }
    send(res, 500, { error: { message: "Sync store failed", type: "conversation_sync", code: "internal" } });
  }
}

function accountFrom(req: IncomingMessage, accounts: ReadonlyMap<string, string>, book: AccountBook): string {
  const header = req.headers.authorization ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const accountId = accounts.get(token) ?? book.accountForToken(token);
  if (!accountId) throw new SyncError(401, "bad_key", "Unknown or revoked key");
  return accountId;
}

function numberParam(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          reject(new SyncError(400, "bad_request", "JSON object required"));
          return;
        }
        resolve(body as Record<string, unknown>);
      } catch {
        reject(new SyncError(400, "bad_request", "JSON object required"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  writeCors(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function writeCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-nanomuse-device");
  res.setHeader("access-control-allow-private-network", "true");
}

function sessionPayload(result: { token: string; account: string; channel: string; created?: boolean }) {
  return {
    token: result.token,
    api_key: result.token,
    created: Boolean(result.created),
    account: { id: result.account, channel: result.channel, hint: result.account, member: false },
    tokens: { unlimited: true, granted: 0, used: 0, remaining: 0 },
  };
}

function profilePayload(accounts: AccountBook, accountId: string) {
  return {
    ...accounts.profile(accountId),
    account: { id: accountId, channel: accounts.channelFor(accountId), hint: accountId, member: false },
    tokens: { unlimited: true, granted: 0, used: 0, remaining: 0 },
  };
}

function tokenFrom(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function hubDevices(hub: DeviceHub, accountId: string): unknown[] {
  return hub.list(accountId);
}

async function proxyChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = process.env.CONVERSATION_SYNC_UPSTREAM_KEY ?? "";
  if (!key) throw new SyncError(503, "upstream_unconfigured", "没有配置模型上游密钥");
  const upstream = process.env.CONVERSATION_SYNC_UPSTREAM_URL || "https://api.openai.com/v1/chat/completions";
  const body = await readJson(req);
  const response = await fetch(upstream, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = Buffer.from(await response.arrayBuffer());
  writeCors(res);
  res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
  res.end(payload);
}
