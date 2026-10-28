/**
 * Conversation mirror with the same save effect as nanomuse_cloud's sync store.
 *
 * An account has one monotonic seq. Accepted conversation and message writes
 * take the next seq. Devices pull everything after their cursor. The relay
 * keeps user/assistant text cut at 16 KB and attachment names only — never a
 * file. One live main conversation per account. Turning sync off deletes the
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

export const LIMITS = { messages: 20_000, textBytes: 16_384, conversations: 2_000 } as const;
export const MAX_POST = 200;
export const DEFAULT_PAGE = 500;
export const MAX_PAGE = 1_000;
export const TOMBSTONE_DAYS = 30;
export const MAX_ATTACHMENTS = 20;
export const MAX_TAIL = 500;
export const WORKING_TTL_S = 10 * 60;

const ID = /^[a-z0-9][a-z0-9._:-]{3,63}$/;
const KINDS = new Set(["main", "side"]);
const ROLES = new Set(["user", "assistant"]);
const SCOPES = new Set(["all", "main"]);

export class SyncError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export interface SyncState {
  enabled: boolean;
  cursor: number;
  counts: { conversations: number; messages: number };
  limits: { messages: number; text_bytes: number; conversations: number };
  working: WorkingFrame[];
}

export interface WorkingFrame {
  cid: string;
  from: string;
  device_name: string;
  working: boolean;
  at: number;
}

export interface PushResult {
  cursor: number;
  accepted: number;
  rejected: Array<Record<string, string>>;
}

type Row = Record<string, SQLInputValue>;

export class Presence {
  private readonly live = new Map<string, { cid: string; from: string; device_name: string; at: number }>();

  constructor(private readonly clock: () => number = () => Date.now() / 1000) {}

  set(accountId: string, cid: string, device: string, deviceName: string, working: boolean): WorkingFrame {
    const at = Math.floor(this.clock());
    const key = `${accountId}\0${cid}`;
    if (working) {
      this.live.set(key, { cid, from: device, device_name: deviceName, at });
    } else {
      const cur = this.live.get(key);
      if (cur && cur.from === device) this.live.delete(key);
    }
    return { cid, from: device, device_name: deviceName, working, at };
  }

  working(accountId: string): Array<Omit<WorkingFrame, "working">> {
    this.sweep();
    const out = [...this.live.entries()]
      .filter(([key]) => key.startsWith(`${accountId}\0`))
      .map(([, value]) => ({ ...value }));
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  forget(accountId: string): void {
    for (const key of [...this.live.keys()]) {
      if (key.startsWith(`${accountId}\0`)) this.live.delete(key);
    }
  }

  private sweep(): void {
    const cutoff = Math.floor(this.clock()) - WORKING_TTL_S;
    for (const [key, value] of this.live) {
      if (value.at < cutoff) this.live.delete(key);
    }
  }
}

export class SyncStore {
  readonly presence: Presence;

  constructor(
    readonly db: DatabaseSync,
    presence?: Presence,
    private readonly clock: () => number = () => Date.now() / 1000,
  ) {
    this.presence = presence ?? new Presence(clock);
    this.db.exec(SCHEMA);
    this.tx((c) => {
      c.run("CREATE TABLE IF NOT EXISTS sync_schema (version INTEGER PRIMARY KEY)");
      if (!c.get("SELECT version FROM sync_schema WHERE version=1")) {
        for (const column of ["project_id", "project_name", "execution_device", "session_id"]) {
          c.run(`ALTER TABLE sync_conversations ADD COLUMN ${column} TEXT`);
        }
        c.run("INSERT INTO sync_schema(version) VALUES (1)");
      }
    });
  }

  state(accountId: string): SyncState {
    return this.tx((c) => this.readState(c, accountId));
  }

  setEnabled(accountId: string, enabled: boolean): SyncState {
    return this.tx((c) => {
      this.ensureAccount(c, accountId);
      c.run("UPDATE accounts SET sync_enabled=? WHERE id=?", enabled ? 1 : 0, accountId);
      if (!enabled) this.wipeRows(c, accountId);
      return this.readState(c, accountId);
    });
  }

  wipe(accountId: string): SyncState {
    return this.tx((c) => {
      this.wipeRows(c, accountId);
      return this.readState(c, accountId);
    });
  }

  rememberDevice(accountId: string, deviceId: string, name: string): void {
    const id = deviceId.slice(0, 80);
    if (!id) return;
    this.tx((c) => {
      c.run(
        `INSERT INTO devices(account_id, id, name) VALUES (?, ?, ?)
         ON CONFLICT(account_id, id) DO UPDATE SET name=excluded.name`,
        accountId,
        id,
        name.slice(0, 60),
      );
    });
  }

  changes(
    accountId: string,
    since = 0,
    limit = DEFAULT_PAGE,
    scope = "all",
    tail = 0,
  ): Record<string, unknown> {
    since = Math.max(0, Math.trunc(since));
    limit = Math.max(1, Math.min(Math.trunc(limit), MAX_PAGE));
    if (!SCOPES.has(scope)) throw new SyncError(400, "bad_scope", "scope is all or main");
    tail = since === 0 ? Math.max(0, Math.min(Math.trunc(tail || 0), MAX_TAIL)) : 0;
    const convScope = scope === "main" ? " AND kind='main'" : "";
    const msgScope =
      scope === "main"
        ? " AND cid IN (SELECT cid FROM sync_conversations WHERE account_id=? AND kind='main')"
        : "";
    return this.tx((c) => {
      if (!this.enabled(c, accountId)) {
        throw new SyncError(409, "sync_off", "Conversation sync is off for this account");
      }
      const names = this.deviceNames(c, accountId);
      let skipped: number | undefined;
      let rows: Array<[number, "c" | "m", Row]>;
      let more: boolean;
      let cursor: number;
      if (tail) {
        const params: SQLInputValue[] = [accountId];
        if (msgScope) params.push(accountId);
        params.push(tail);
        const msgs = c
          .all(`SELECT * FROM sync_messages WHERE account_id=?${msgScope} ORDER BY seq DESC LIMIT ?`, ...params)
          .reverse();
        const countParams: SQLInputValue[] = [accountId];
        if (msgScope) countParams.push(accountId);
        const total = Number(c.get(`SELECT COUNT(*) AS n FROM sync_messages WHERE account_id=?${msgScope}`, ...countParams)?.n ?? 0);
        skipped = Math.max(0, total - msgs.length);
        rows = msgs.map((row) => [Number(row.seq), "m", row]);
        more = false;
        cursor = this.cursor(c, accountId);
      } else {
        const convs = c.all(
          `SELECT * FROM sync_conversations WHERE account_id=? AND seq>?${convScope} ORDER BY seq LIMIT ?`,
          accountId,
          since,
          limit + 1,
        );
        const msgParams: SQLInputValue[] = [accountId, since];
        if (msgScope) msgParams.push(accountId);
        msgParams.push(limit + 1);
        const msgs = c.all(
          `SELECT * FROM sync_messages WHERE account_id=? AND seq>?${msgScope} ORDER BY seq LIMIT ?`,
          ...msgParams,
        );
        rows = [
          ...convs.map((row): [number, "c" | "m", Row] => [Number(row.seq), "c", row]),
          ...msgs.map((row): [number, "c" | "m", Row] => [Number(row.seq), "m", row]),
        ];
        rows.sort((a, b) => a[0] - b[0]);
        more = rows.length > limit;
        rows = rows.slice(0, limit);
        cursor = more && rows.length ? rows[rows.length - 1]![0] : this.cursor(c, accountId);
      }
      const conversations = rows.filter((row) => row[1] === "c").map((row) => row[2]);
      const have = new Set(conversations.map((row) => String(row.cid)));
      const parents = [...new Set(rows.filter((row) => row[1] === "m" && !have.has(String(row[2].cid))).map((row) => String(row[2].cid)))].sort();
      if (parents.length) {
        const marks = parents.map(() => "?").join(",");
        const extra = c.all(
          `SELECT * FROM sync_conversations WHERE account_id=? AND cid IN (${marks}) ORDER BY seq`,
          accountId,
          ...parents,
        );
        conversations.push(...extra);
        for (const row of extra) have.add(String(row.cid));
      }
      if (tail) {
        const main = c.get(
          "SELECT * FROM sync_conversations WHERE account_id=? AND kind='main' AND deleted=0 ORDER BY seq LIMIT 1",
          accountId,
        );
        if (main && !have.has(String(main.cid))) conversations.push(main);
      }
      const out: Record<string, unknown> = {
        cursor,
        more,
        conversations: conversations.map((row) => conversationRow(row, names)),
        messages: rows.filter((row) => row[1] === "m").map((row) => messageRow(row[2], names)),
      };
      if (skipped !== undefined) out.skipped = skipped;
      return out;
    });
  }

  listConversations(accountId: string): Record<string, unknown> {
    return this.tx((c) => {
      if (!this.enabled(c, accountId)) throw new SyncError(409, "sync_off", "Conversation sync is off for this account");
      const names = this.deviceNames(c, accountId);
      const rows = c.all("SELECT * FROM sync_conversations WHERE account_id=? AND deleted=0 ORDER BY updated_at DESC, cid", accountId);
      return { cursor: this.cursor(c, accountId), conversations: rows.map((row) => conversationRow(row, names)) };
    });
  }

  conversation(accountId: string, cid: string): Record<string, unknown> {
    return this.tx((c) => {
      if (!this.enabled(c, accountId)) throw new SyncError(409, "sync_off", "Conversation sync is off for this account");
      const id = validId(cid);
      const row = id ? c.get("SELECT * FROM sync_conversations WHERE account_id=? AND cid=? AND deleted=0", accountId, id) : undefined;
      if (!row) throw new SyncError(404, "not_found", "No synced conversation with that id");
      const names = this.deviceNames(c, accountId);
      const messages = c.all(
        "SELECT * FROM sync_messages WHERE account_id=? AND cid=? AND deleted=0 ORDER BY created_at DESC, seq DESC LIMIT ?",
        accountId, String(row.cid), MAX_TAIL,
      ).reverse();
      return { conversation: conversationRow(row, names), messages: messages.map((message) => messageRow(message, names)) };
    });
  }

  setWorking(accountId: string, cid: string, device: string, working: boolean): WorkingFrame {
    const cidOk = validId(cid);
    if (!cidOk) throw new SyncError(400, "bad_cid", "That is not a conversation id");
    device = String(device || "").slice(0, 80);
    const name = this.tx((c) => {
      if (!this.enabled(c, accountId)) {
        throw new SyncError(409, "sync_off", "Conversation sync is off for this account");
      }
      const row = c.get("SELECT deleted FROM sync_conversations WHERE account_id=? AND cid=?", accountId, cidOk);
      if (!row || row.deleted) throw new SyncError(404, "no_conversation", "No synced conversation with that id");
      return this.deviceNames(c, accountId).get(device) ?? "";
    });
    return this.presence.set(accountId, cidOk, device, name, Boolean(working));
  }

  push(accountId: string, device: string, conversations: unknown, messages: unknown): PushResult {
    if (!Array.isArray(conversations) || !Array.isArray(messages)) {
      throw new SyncError(400, "bad_request", "conversations and messages are lists");
    }
    if (messages.length > MAX_POST) {
      throw new SyncError(413, "too_many_messages", `At most ${MAX_POST} messages per request`);
    }
    if (conversations.length > MAX_POST) {
      throw new SyncError(413, "too_many_conversations", `At most ${MAX_POST} conversations per request`);
    }
    device = String(device || "").slice(0, 80);
    const t = Math.floor(this.clock());
    return this.tx((c) => {
      if (!this.enabled(c, accountId)) {
        throw new SyncError(409, "sync_off", "Conversation sync is off for this account");
      }
      this.sweep(c, t);
      let accepted = 0;
      const rejected: Array<Record<string, string>> = [];
      const redirected = new Map<string, string>();
      for (const conv of conversations) {
        if (!isRecord(conv)) continue;
        const cid = validId(conv.cid);
        if (!cid) {
          rejected.push({ cid: String(conv.cid ?? "").slice(0, 80), reason: "bad_cid" });
          continue;
        }
        const kind = String(conv.kind ?? "side");
        if (!KINDS.has(kind)) {
          rejected.push({ cid, reason: "bad_kind" });
          continue;
        }
        const title = String(conv.title ?? "").slice(0, 200);
        const createdAt = timestamp(conv.created_at, t);
        const updatedAt = Math.max(createdAt, timestamp(conv.updated_at, createdAt, t));
        const deleted = Boolean(conv.deleted);
        const row = c.get("SELECT * FROM sync_conversations WHERE account_id=? AND cid=?", accountId, cid);
        const metadata = readMetadata(conv, device);
        if (!metadata) {
          rejected.push({ cid, reason: "bad_metadata" });
          continue;
        }
        const hasMetadata = Object.keys(metadata).length > 0;
        if (hasMetadata && row && (row.execution_device ?? row.device) !== device) {
          rejected.push({ cid, reason: "metadata_owner" });
          continue;
        }
        if (!row) {
          if (kind === "side" && !deleted && this.liveConversations(c, accountId) >= LIMITS.conversations) {
            rejected.push({ cid, reason: "conversation_limit" });
            continue;
          }
          if (kind === "main" && !deleted) {
            const main = c.get(
              "SELECT cid FROM sync_conversations WHERE account_id=? AND kind='main' AND deleted=0 ORDER BY seq LIMIT 1",
              accountId,
            );
            if (main) {
              redirected.set(cid, String(main.cid));
              rejected.push({ cid, reason: "main_exists", cid_main: String(main.cid) });
              continue;
            }
          }
          const seq = this.nextSeq(c, accountId);
          c.run(
            `INSERT INTO sync_conversations(account_id, cid, kind, title, device, created_at, updated_at, deleted, deleted_at, seq, project_id, project_name, execution_device, session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            accountId,
            cid,
            kind,
            deleted ? "" : title,
            device,
            createdAt,
            updatedAt,
            deleted ? 1 : 0,
            deleted ? t : null,
            seq,
            metadata.project_id ?? null,
            metadata.project_name ?? null,
            metadata.execution_device ?? null,
            metadata.session_id ?? null,
          );
          accepted += 1;
          continue;
        }
        if (row.deleted) continue;
        if (deleted) {
          this.tombstone(c, accountId, cid, t);
          accepted += 1;
        } else if (updatedAt >= Number(row.updated_at) && (title !== row.title || updatedAt !== Number(row.updated_at)
          || Object.entries(metadata).some(([key, value]) => row[key] !== value))) {
          const seq = this.nextSeq(c, accountId);
          c.run(
            "UPDATE sync_conversations SET title=?, updated_at=?, seq=?, project_id=?, project_name=?, execution_device=?, session_id=? WHERE account_id=? AND cid=?",
            title,
            updatedAt,
            seq,
            metadata.project_id ?? row.project_id ?? null,
            metadata.project_name ?? row.project_name ?? null,
            metadata.execution_device ?? row.execution_device ?? null,
            metadata.session_id ?? row.session_id ?? null,
            accountId,
            cid,
          );
          accepted += 1;
        }
      }
      const touched = new Set<string>();
      for (const msg of messages) {
        if (!isRecord(msg)) continue;
        const mid = validId(msg.mid);
        if (!mid) {
          rejected.push({ mid: String(msg.mid ?? "").slice(0, 80), reason: "bad_mid" });
          continue;
        }
        const cid = validId(msg.cid);
        if (!cid) {
          rejected.push({ mid, reason: "bad_cid" });
          continue;
        }
        const redirectedTo = redirected.get(cid);
        if (redirectedTo) {
          rejected.push({ mid, reason: "main_exists", cid_main: redirectedTo });
          continue;
        }
        const deleted = Boolean(msg.deleted);
        const row = c.get("SELECT deleted FROM sync_messages WHERE account_id=? AND mid=?", accountId, mid);
        if (row) {
          if (deleted && !row.deleted) {
            const seq = this.nextSeq(c, accountId);
            c.run(
              "UPDATE sync_messages SET deleted=1, deleted_at=?, text='', truncated=0, attachments='[]', seq=? WHERE account_id=? AND mid=?",
              t,
              seq,
              accountId,
              mid,
            );
            accepted += 1;
          }
          continue;
        }
        const conv = c.get("SELECT deleted FROM sync_conversations WHERE account_id=? AND cid=?", accountId, cid);
        if (!conv) {
          rejected.push({ mid, reason: "unknown_cid" });
          continue;
        }
        if (conv.deleted) {
          rejected.push({ mid, reason: "conversation_deleted" });
          continue;
        }
        const role = String(msg.role ?? "");
        if (!ROLES.has(role)) {
          rejected.push({ mid, reason: "bad_role" });
          continue;
        }
        const [text, truncated] = cutText(msg.text);
        const seq = this.nextSeq(c, accountId);
        c.run(
          `INSERT INTO sync_messages(account_id, mid, cid, seq, device, role, text, truncated, attachments, created_at, deleted, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          accountId,
          mid,
          cid,
          seq,
          device,
          role,
          deleted ? "" : text,
          deleted ? 0 : truncated ? 1 : 0,
          deleted ? "[]" : JSON.stringify(cleanAttachments(msg.attachments)),
          timestamp(msg.created_at, t),
          deleted ? 1 : 0,
          deleted ? t : null,
        );
        touched.add(cid);
        accepted += 1;
      }
      if (touched.size) this.retain(c, accountId, touched);
      return { cursor: this.cursor(c, accountId), accepted, rejected };
    });
  }

  deleteConversation(accountId: string, cid: string): { cursor: number; deleted: true } {
    const cidOk = validId(cid);
    if (!cidOk) throw new SyncError(400, "bad_cid", "That is not a conversation id");
    return this.tx((c) => {
      if (!this.enabled(c, accountId)) {
        throw new SyncError(409, "sync_off", "Conversation sync is off for this account");
      }
      const row = c.get("SELECT deleted FROM sync_conversations WHERE account_id=? AND cid=?", accountId, cidOk);
      if (!row) throw new SyncError(404, "no_conversation", "No synced conversation with that id");
      if (!row.deleted) this.tombstone(c, accountId, cidOk, Math.floor(this.clock()));
      return { cursor: this.cursor(c, accountId), deleted: true as const };
    });
  }

  adminTotals(): Record<string, unknown> {
    return this.tx((c) => {
      const acc = c.get(
        `SELECT SUM(CASE WHEN sync_enabled=1 THEN 1 ELSE 0 END) AS on_,
                SUM(CASE WHEN sync_enabled=0 THEN 1 ELSE 0 END) AS off
         FROM accounts`,
      );
      const convs = Number(c.get("SELECT COUNT(*) AS n FROM sync_conversations WHERE deleted=0")?.n ?? 0);
      const msgs = c.get(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS bytes FROM sync_messages WHERE deleted=0",
      );
      const accountsWith = Number(
        c.get("SELECT COUNT(DISTINCT account_id) AS n FROM sync_messages WHERE deleted=0")?.n ?? 0,
      );
      return {
        accounts_enabled: Number(acc?.on_ ?? 0),
        accounts_disabled: Number(acc?.off ?? 0),
        accounts_with_data: accountsWith,
        conversations: convs,
        messages: Number(msgs?.n ?? 0),
        bytes: Number(msgs?.bytes ?? 0),
        limits: { messages: LIMITS.messages, text_bytes: LIMITS.textBytes, conversations: LIMITS.conversations },
      };
    });
  }

  private tx<T>(fn: (c: Query) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn(new Query(this.db));
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureAccount(c: Query, accountId: string): void {
    c.run("INSERT OR IGNORE INTO accounts(id, sync_enabled) VALUES (?, 1)", accountId);
  }

  private enabled(c: Query, accountId: string): boolean {
    this.ensureAccount(c, accountId);
    return Boolean(c.get("SELECT sync_enabled FROM accounts WHERE id=?", accountId)?.sync_enabled);
  }

  private cursor(c: Query, accountId: string): number {
    return Number(c.get("SELECT seq FROM sync_cursors WHERE account_id=?", accountId)?.seq ?? 0);
  }

  private nextSeq(c: Query, accountId: string): number {
    c.run("INSERT OR IGNORE INTO sync_cursors(account_id, seq) VALUES (?, 0)", accountId);
    c.run("UPDATE sync_cursors SET seq=seq+1 WHERE account_id=?", accountId);
    return this.cursor(c, accountId);
  }

  private readState(c: Query, accountId: string): SyncState {
    this.ensureAccount(c, accountId);
    const row = c.get("SELECT sync_enabled FROM accounts WHERE id=?", accountId);
    const convs = Number(c.get("SELECT COUNT(*) AS n FROM sync_conversations WHERE account_id=? AND deleted=0", accountId)?.n ?? 0);
    const msgs = Number(c.get("SELECT COUNT(*) AS n FROM sync_messages WHERE account_id=? AND deleted=0", accountId)?.n ?? 0);
    return {
      enabled: Boolean(row?.sync_enabled),
      cursor: this.cursor(c, accountId),
      counts: { conversations: convs, messages: msgs },
      limits: { messages: LIMITS.messages, text_bytes: LIMITS.textBytes, conversations: LIMITS.conversations },
      working: this.presence.working(accountId).map((item) => ({ ...item, working: true })),
    };
  }

  private wipeRows(c: Query, accountId: string): void {
    c.run("DELETE FROM sync_messages WHERE account_id=?", accountId);
    c.run("DELETE FROM sync_conversations WHERE account_id=?", accountId);
    this.presence.forget(accountId);
  }

  private deviceNames(c: Query, accountId: string): Map<string, string> {
    const rows = c.all("SELECT id, name FROM devices WHERE account_id=?", accountId);
    return new Map(rows.map((row) => [String(row.id), String(row.name)]));
  }

  private liveConversations(c: Query, accountId: string): number {
    return Number(
      c.get("SELECT COUNT(*) AS n FROM sync_conversations WHERE account_id=? AND kind='side' AND deleted=0", accountId)?.n ?? 0,
    );
  }

  private tombstone(c: Query, accountId: string, cid: string, t: number): number {
    const seq = this.nextSeq(c, accountId);
    c.run(
      "UPDATE sync_conversations SET deleted=1, deleted_at=?, title='', updated_at=?, seq=? WHERE account_id=? AND cid=?",
      t,
      t,
      seq,
      accountId,
      cid,
    );
    c.run("DELETE FROM sync_messages WHERE account_id=? AND cid=?", accountId, cid);
    return seq;
  }

  private retain(c: Query, accountId: string, keep: Set<string>): void {
    let count = Number(c.get("SELECT COUNT(*) AS n FROM sync_messages WHERE account_id=? AND deleted=0", accountId)?.n ?? 0);
    if (count <= LIMITS.messages) return;
    const rows = c.all(
      `SELECT sc.cid AS cid, COUNT(sm.mid) AS n FROM sync_conversations sc
       JOIN sync_messages sm ON sm.account_id=sc.account_id AND sm.cid=sc.cid AND sm.deleted=0
       WHERE sc.account_id=? GROUP BY sc.cid ORDER BY sc.updated_at, sc.seq`,
      accountId,
    );
    for (const row of rows) {
      if (count <= LIMITS.messages) return;
      if (keep.has(String(row.cid))) continue;
      c.run("DELETE FROM sync_messages WHERE account_id=? AND cid=? AND deleted=0", accountId, String(row.cid));
      count -= Number(row.n);
    }
    if (count > LIMITS.messages) {
      c.run(
        `DELETE FROM sync_messages WHERE account_id=? AND deleted=0 AND rowid IN (
           SELECT rowid FROM sync_messages WHERE account_id=? AND deleted=0 ORDER BY created_at, seq LIMIT ?)`,
        accountId,
        accountId,
        count - LIMITS.messages,
      );
    }
  }

  private sweep(c: Query, t: number): void {
    const cutoff = t - TOMBSTONE_DAYS * 86_400;
    c.run("DELETE FROM sync_messages WHERE deleted=1 AND deleted_at IS NOT NULL AND deleted_at<?", cutoff);
    c.run("DELETE FROM sync_conversations WHERE deleted=1 AND deleted_at IS NOT NULL AND deleted_at<?", cutoff);
  }
}

class Query {
  constructor(private readonly db: DatabaseSync) {}

  run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
}

export function validId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return ID.test(id) ? id : null;
}

export function cutText(text: unknown, limit = LIMITS.textBytes): [string, boolean] {
  if (typeof text !== "string") return ["", false];
  const raw = Buffer.from(text, "utf8");
  if (raw.length <= limit) return [text, false];
  let end = limit;
  while (end > 0 && (raw[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const lead = raw[end - 1]!;
    const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (lead >= 0x80 && end - 1 + need > limit) end -= 1;
  }
  return [raw.subarray(0, Math.max(0, end)).toString("utf8"), true];
}

export function cleanAttachments(value: unknown): Array<{ name: string; mime: string; size: number }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ name: string; mime: string; size: number }> = [];
  for (const item of value.slice(0, MAX_ATTACHMENTS)) {
    if (!isRecord(item)) continue;
    const name = String(item.name ?? "").slice(0, 200);
    const mime = String(item.mime ?? "").slice(0, 100);
    const parsed = Number(item.size ?? 0);
    const size = Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    if (name || mime || size) out.push({ name, mime, size });
  }
  return out;
}

function timestamp(value: unknown, fallback: number, ceiling?: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  let t = Math.trunc(parsed);
  if (t > 10_000_000_000) t = Math.trunc(t / 1000);
  const cap = (ceiling ?? fallback) + 7 * 86_400;
  if (t <= 0 || t > cap) return fallback;
  return t;
}

const METADATA_LIMITS = { project_id: 64, project_name: 200, execution_device: 80, session_id: 64 } as const;

function readMetadata(conv: Record<string, unknown>, device: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, limit] of Object.entries(METADATA_LIMITS)) {
    if (!(key in conv)) continue;
    const value = conv[key];
    if (typeof value !== "string" || !value.length || value.length > limit) return null;
    if ((key === "project_id" || key === "session_id") && validId(value) !== value) return null;
    if (key === "execution_device" && value !== device) return null;
    out[key] = value;
  }
  return out;
}

function conversationRow(row: Row, names: Map<string, string>): Record<string, unknown> {
  return {
    cid: row.cid,
    kind: row.kind,
    title: row.title,
    device: row.device,
    device_name: names.get(String(row.device)) ?? "",
    ...Object.fromEntries(Object.keys(METADATA_LIMITS).filter((key) => typeof row[key] === "string").map((key) => [key, row[key]])),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    deleted: Boolean(row.deleted),
    seq: Number(row.seq),
  };
}

function messageRow(row: Row, names: Map<string, string>): Record<string, unknown> {
  let attachments: unknown = [];
  try {
    attachments = JSON.parse(String(row.attachments || "[]"));
  } catch {
    attachments = [];
  }
  return {
    mid: row.mid,
    cid: row.cid,
    seq: Number(row.seq),
    device: row.device,
    device_name: names.get(String(row.device)) ?? "",
    role: row.role,
    text: row.text,
    truncated: Boolean(row.truncated),
    attachments: Array.isArray(attachments) ? attachments : [],
    created_at: Number(row.created_at),
    deleted: Boolean(row.deleted),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  sync_enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS devices (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  account_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_conversations (
  account_id TEXT NOT NULL,
  cid TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (account_id, cid)
);
CREATE INDEX IF NOT EXISTS sync_conversations_seq ON sync_conversations(account_id, seq);
CREATE INDEX IF NOT EXISTS sync_conversations_tombstones ON sync_conversations(deleted_at) WHERE deleted=1;
CREATE TABLE IF NOT EXISTS sync_messages (
  account_id TEXT NOT NULL,
  mid TEXT NOT NULL,
  cid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  PRIMARY KEY (account_id, mid)
);
CREATE INDEX IF NOT EXISTS sync_messages_seq ON sync_messages(account_id, seq);
CREATE INDEX IF NOT EXISTS sync_messages_cid ON sync_messages(account_id, cid);
CREATE INDEX IF NOT EXISTS sync_messages_tombstones ON sync_messages(deleted_at) WHERE deleted=1;
`;

