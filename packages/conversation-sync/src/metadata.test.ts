import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { AccountBook } from "./accounts.js";
import { createSyncServer } from "./http.js";
import { SyncStore } from "./store.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function open() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}
const conv = (extra: Record<string, unknown> = {}) => ({ cid: "session-one", title: "First", created_at: 1700000000, updated_at: 1700000000, ...extra });
const metadata = { project_id: "a".repeat(64), project_name: "Project", execution_device: "desktop-one", session_id: "session-one" };

it("migrates the previous schema transactionally without losing passwords, sessions or sync rows", () => {
  const db = open();
  const accounts = new AccountBook(db);
  const session = accounts.register("existing", "secret1");
  db.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, sync_enabled INTEGER NOT NULL DEFAULT 1);
    INSERT INTO accounts VALUES ('existing', 1);
    CREATE TABLE sync_cursors (account_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    INSERT INTO sync_cursors VALUES ('existing', 2);
    CREATE TABLE sync_conversations (account_id TEXT NOT NULL, cid TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, seq INTEGER NOT NULL, PRIMARY KEY(account_id,cid));
    INSERT INTO sync_conversations VALUES ('existing','session-one','side','First','desktop-one',1700000000,1700000000,0,NULL,1);
    CREATE TABLE sync_messages (account_id TEXT NOT NULL, mid TEXT NOT NULL, cid TEXT NOT NULL, seq INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', truncated INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, PRIMARY KEY(account_id,mid));
    INSERT INTO sync_messages VALUES ('existing','message-one','session-one',2,'desktop-one','user','Saved',0,'[]',1700000000,0,NULL);`);
  const store = new SyncStore(db);
  expect(accounts.accountForToken(session.token)).toBe("existing");
  expect(accounts.login("existing", "secret1").account).toBe("existing");
  expect(store.state("existing")).toMatchObject({ cursor: 2, counts: { conversations: 1, messages: 1 } });
  expect(store.conversation("existing", "session-one")).toMatchObject({ conversation: { title: "First" }, messages: [{ text: "Saved" }] });
  expect(db.prepare("SELECT version FROM sync_schema").all()).toEqual([{ version: 1 }]);
  expect(() => new SyncStore(db)).not.toThrow();
});

it("backfills at the same timestamp exactly once and preserves metadata on legacy title writes", () => {
  const store = new SyncStore(open());
  expect(store.push("alice", "desktop-one", [conv()], []).cursor).toBe(1);
  expect(store.push("alice", "desktop-one", [conv(metadata)], [])).toMatchObject({ accepted: 1, cursor: 2, rejected: [] });
  expect(store.push("alice", "desktop-one", [conv(metadata)], [])).toMatchObject({ accepted: 0, cursor: 2 });
  expect(store.push("alice", "desktop-two", [conv({ title: "Renamed", updated_at: 1700000001 })], []).accepted).toBe(1);
  expect(store.listConversations("alice")).toMatchObject({ conversations: [{ title: "Renamed", ...metadata }] });
  expect(store.changes("alice")).toMatchObject({ conversations: [{ ...metadata }] });
  expect(store.listConversations("bob")).toMatchObject({ conversations: [] });
});

it("rejects forged routing, ownership takeover and invalid metadata without mutating rows", () => {
  const store = new SyncStore(open());
  store.push("alice", "desktop-one", [conv()], []);
  expect(store.push("alice", "desktop-two", [conv({ ...metadata, execution_device: "desktop-two" })], []).rejected).toEqual([{ cid: "session-one", reason: "metadata_owner" }]);
  for (const bad of [{ execution_device: "other" }, { session_id: "../invalid" }, { session_id: 42 }, { project_id: "/private/path" }, { project_name: "x".repeat(201) }, { project_name: null }, { execution_device: "" }]) {
    expect(store.push("alice", "desktop-one", [conv(bad)], []).rejected).toEqual([{ cid: "session-one", reason: "bad_metadata" }]);
  }
  store.push("alice", "desktop-one", [conv(metadata)], []);
  expect(store.push("alice", "desktop-two", [conv({ ...metadata, execution_device: "desktop-two", session_id: "stolen-session" })], []).rejected).toEqual([{ cid: "session-one", reason: "metadata_owner" }]);
  expect(store.conversation("alice", "session-one")).toMatchObject({ conversation: metadata });
});

it("authenticates single conversation reads, isolates accounts, caps newest live messages and respects sync off", async () => {
  const db = open();
  const store = new SyncStore(db);
  store.push("alice", "desktop-one", [conv(metadata)], []);
  // Reverse chronological insertion proves selection and presentation use message time, with seq as a tie breaker.
  const messages = Array.from({ length: 505 }, (_, i) => ({ mid: `message-${String(i).padStart(4, "0")}`, cid: "session-one", role: "user", text: String(i), created_at: 1700000505 - i }));
  for (let i = 0; i < messages.length; i += 200) store.push("alice", "desktop-one", [], messages.slice(i, i + 200));
  store.push("alice", "desktop-one", [], [{ ...messages[0], deleted: true }]);
  const server = createSyncServer({ db, store, accounts: new Map([["token-a", "alice"], ["token-b", "bob"]]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, token = "token-a") => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  try {
    expect((await get("/v1/sync/conversations/session-one", "missing")).status).toBe(401);
    const result = await get("/v1/sync/conversations/session-one");
    expect(result.status).toBe(200);
    const body = await result.json() as { conversation: Record<string, unknown>; messages: Array<{ text: string }> };
    expect(body.conversation).toMatchObject(metadata);
    expect(body.messages).toHaveLength(500);
    expect(body.messages[0]?.text).toBe("500");
    expect(body.messages.at(-1)?.text).toBe("1");
    expect(await (await get("/v1/sync/conversations")).json()).toMatchObject({ conversations: [{ ...metadata }] });
    expect(await (await get("/v1/sync/conversations/session-one", "token-b")).json()).toMatchObject({ error: { code: "not_found" } });
    store.deleteConversation("alice", "session-one");
    expect(await (await get("/v1/sync/conversations/session-one")).json()).toMatchObject({ error: { code: "not_found" } });
    store.setEnabled("alice", false);
    expect(await (await get("/v1/sync/conversations/session-one")).json()).toMatchObject({ error: { code: "sync_off" } });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
