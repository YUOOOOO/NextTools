import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { AccountBook } from "./accounts.js";
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
  return createServer((req, res) => {
    void handle(store, accounts, options, req, res);
  });
}

async function handle(store: SyncStore, accounts: AccountBook, options: SyncServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://sync.local");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/console")) {
      const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "console.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/auth/register" || url.pathname === "/v1/auth/login")) {
      const body = await readJson(req);
      const result = url.pathname.endsWith("/register")
        ? accounts.register(body.account, body.password)
        : accounts.login(body.account, body.password);
      return send(res, 200, result);
    }
    const accountId = accountFrom(req, options.accounts, accounts);
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
      if (out.accepted) options.onSync?.(accountId, out.cursor, device);
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
      options.onWorking?.(accountId, frame);
      res.writeHead(204);
      res.end();
      return;
    }
    const deleted = url.pathname.match(/^\/v1\/sync\/conversations\/([^/]+)$/);
    if (req.method === "DELETE" && deleted) {
      const cid = decodeURIComponent(deleted[1] ?? "");
      const out = store.deleteConversation(accountId, cid);
      const device = String(req.headers["x-nanomuse-device"] ?? "").slice(0, 80);
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}
