import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AccountBook, Session } from "./accounts.js";
import { SyncError } from "./store.js";

/** Account-console data, separate from password verification and sync storage. */
export class AccountPortal {
  constructor(private readonly db: DatabaseSync, private readonly accounts: AccountBook) {
    db.exec(`CREATE TABLE IF NOT EXISTS cloud_portal_schema (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_session_details (
        token TEXT PRIMARY KEY, device TEXT NOT NULL, via TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
        ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_events_owner ON account_events(account_id, id);
      INSERT INTO cloud_portal_schema(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM cloud_portal_schema);`);
  }

  authenticated(session: Session, device: unknown, via: string): void {
    this.db.prepare("INSERT INTO login_session_details(token, device, via) VALUES (?, ?, ?)")
      .run(session.token, String(device ?? "").trim().slice(0, 80), via);
    if (session.created) this.event(session.account, "account.created");
    this.event(session.account, via === "password" ? "sign_in.password" : "sign_in.code");
  }

  me(accountId: string) {
    const row = this.db.prepare("SELECT password_hash, created_at FROM login_accounts WHERE id=?").get(accountId) as { password_hash: string; created_at: number } | undefined;
    const count = this.db.prepare("SELECT count(*) AS n FROM login_sessions WHERE account_id=?").get(accountId) as { n: number };
    return {
      account: {
        id: accountId, hint: accountId, channel: this.accounts.channelFor(accountId), member: false,
        created_at: row?.created_at ?? 0, has_password: !!row && row.password_hash !== "code-only", sessions: count.n,
      },
      capabilities: { billing: false, contribution: false, password_removal: false },
    };
  }

  sessions(accountId: string, current: string) {
    const rows = this.db.prepare(`SELECT s.token, s.created_at, d.device, d.via
      FROM login_sessions s LEFT JOIN login_session_details d ON d.token=s.token
      WHERE s.account_id=? ORDER BY s.created_at DESC`).all(accountId) as Array<{ token: string; created_at: number; device: string | null; via: string | null }>;
    return rows.map((row) => ({ prefix: sessionId(row.token), created_at: row.created_at,
      device: row.device || "Pilot", via: row.via || "password", current: row.token === current }));
  }

  revoke(accountId: string, id: string): void {
    const rows = this.db.prepare("SELECT token FROM login_sessions WHERE account_id=?").all(accountId) as Array<{ token: string }>;
    const found = rows.find((row) => sessionId(row.token) === id);
    if (!found) throw new SyncError(404, "no_session", "That sign-in no longer exists");
    this.accounts.revokeToken(found.token);
    this.db.prepare("DELETE FROM login_session_details WHERE token=?").run(found.token);
    this.event(accountId, "sign_out");
  }

  revokeAll(accountId: string): void {
    this.db.prepare("DELETE FROM login_session_details WHERE token IN (SELECT token FROM login_sessions WHERE account_id=?)").run(accountId);
    this.db.prepare("DELETE FROM login_sessions WHERE account_id=?").run(accountId);
    this.event(accountId, "sign_out.all");
  }

  signedOut(accountId: string, token: string): void {
    this.accounts.revokeToken(token);
    this.db.prepare("DELETE FROM login_session_details WHERE token=?").run(token);
    this.event(accountId, "sign_out");
  }

  events(accountId: string, limit: number) {
    return this.db.prepare("SELECT ts, kind, detail FROM account_events WHERE account_id=? ORDER BY id DESC LIMIT ?")
      .all(accountId, Math.max(1, Math.min(limit || 12, 100)));
  }

  event(accountId: string, kind: string): void {
    this.db.prepare("INSERT INTO account_events(account_id, ts, kind, detail) VALUES (?, ?, ?, '')")
      .run(accountId, Math.floor(Date.now() / 1000), kind);
  }

  deleteData(accountId: string): void {
    this.db.prepare("DELETE FROM login_session_details WHERE token IN (SELECT token FROM login_sessions WHERE account_id=?)").run(accountId);
    this.db.prepare("DELETE FROM account_events WHERE account_id=?").run(accountId);
  }
}
function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}
