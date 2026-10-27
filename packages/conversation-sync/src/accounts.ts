import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SyncError } from "./store.js";

const NAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export class AccountBook {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS login_accounts (
        id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_sessions (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  register(account: unknown, password: unknown): { token: string; account: string } {
    const id = normalizeAccount(account);
    const secret = normalizePassword(password);
    const existing = this.db.prepare("SELECT id FROM login_accounts WHERE id=?").get(id);
    if (existing) throw new SyncError(409, "account_exists", "这个账号已经注册过了");
    this.db.prepare("INSERT INTO login_accounts(id, password_hash, created_at) VALUES (?, ?, ?)").run(id, hashPassword(secret), now());
    return { token: this.issue(id), account: id };
  }

  login(account: unknown, password: unknown): { token: string; account: string } {
    const id = normalizeAccount(account);
    const secret = normalizePassword(password);
    const row = this.db.prepare("SELECT password_hash FROM login_accounts WHERE id=?").get(id) as { password_hash?: string } | undefined;
    if (!row?.password_hash || !verifyPassword(secret, row.password_hash)) {
      throw new SyncError(401, "bad_credentials", "账号或密码不正确");
    }
    return { token: this.issue(id), account: id };
  }

  accountForToken(token: string): string | null {
    const row = this.db.prepare("SELECT account_id FROM login_sessions WHERE token=?").get(token) as { account_id?: string } | undefined;
    return row?.account_id ? String(row.account_id) : null;
  }

  private issue(accountId: string): string {
    const token = randomBytes(24).toString("hex");
    this.db.prepare("INSERT INTO login_sessions(token, account_id, created_at) VALUES (?, ?, ?)").run(token, accountId, now());
    return token;
  }
}

export function normalizeAccount(value: unknown): string {
  const id = String(value ?? "").trim().toLowerCase();
  if (!NAME.test(id)) throw new SyncError(400, "bad_account", "账号用 3–32 位字母、数字、点、下划线或短横线");
  return id;
}

function normalizePassword(value: unknown): string {
  const password = String(value ?? "");
  if (password.length < 6 || password.length > 128) {
    throw new SyncError(400, "bad_password", "密码用 6–128 位");
  }
  return password;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const actual = scryptSync(password, Buffer.from(salt, "base64"), 32);
  const expected = Buffer.from(hash, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
