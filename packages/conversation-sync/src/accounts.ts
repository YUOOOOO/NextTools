import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SyncError } from "./store.js";

const NAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const PHONE = /^(?:\+?86)?1[3-9]\d{9}$/;
const CODE_ONLY = "code-only";

export interface AccountId {
  id: string;
  channel: "account" | "email" | "phone";
}

export interface Session {
  token: string;
  account: string;
  channel: AccountId["channel"];
  created?: boolean;
}

export interface StoredDevice {
  id: string;
  name: string;
  kind: string;
  os: string;
  version: string;
  actions: string[];
  last_seen: number;
}

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
      CREATE TABLE IF NOT EXISTS login_codes (
        identifier TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        account_id TEXT PRIMARY KEY,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        device TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS hub_devices (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        os TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        actions TEXT NOT NULL DEFAULT '[]',
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (account_id, id)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(login_accounts)").all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "channel")) {
      this.db.exec("ALTER TABLE login_accounts ADD COLUMN channel TEXT NOT NULL DEFAULT 'account'");
    }
  }

  register(account: unknown, password: unknown): Session {
    const id = normalizeAccount(account);
    const secret = normalizePassword(password);
    if (this.row(id.id)) throw new SyncError(409, "account_exists", "这个账号已经注册过了");
    this.insert(id, hashPassword(secret));
    return { token: this.issue(id.id), account: id.id, channel: id.channel, created: true };
  }

  login(account: unknown, password: unknown): Session {
    const id = normalizeAccount(account);
    const secret = normalizePassword(password);
    const row = this.row(id.id);
    if (!row?.password_hash || row.password_hash === CODE_ONLY || !verifyPassword(secret, row.password_hash)) {
      throw new SyncError(401, "bad_credentials", "账号或密码不正确");
    }
    return { token: this.issue(id.id), account: id.id, channel: id.channel };
  }

  requestCode(account: unknown): void {
    const id = normalizeAccount(account);
    if (id.channel === "account") {
      throw new SyncError(400, "bad_identifier", "验证码只发给手机号或邮箱");
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.db.prepare("INSERT INTO login_codes(identifier, code, expires_at) VALUES (?, ?, ?) ON CONFLICT(identifier) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at")
      .run(id.id, code, now() + 600);
    console.info(`[conversation-sync] auth code for ${id.id}: ${code}`);
  }

  verifyCode(account: unknown, code: unknown): Session {
    const id = normalizeAccount(account);
    const given = String(code ?? "").trim();
    if (!/^\d{6}$/.test(given)) throw new SyncError(400, "code_wrong", "验证码是 6 位数字");
    const saved = this.db.prepare("SELECT code, expires_at FROM login_codes WHERE identifier=?").get(id.id) as { code?: string; expires_at?: number } | undefined;
    const expected = String(saved?.code ?? "");
    const matches = expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    if (!saved || Number(saved.expires_at) < now() || !matches) {
      throw new SyncError(401, "code_wrong", "验证码不正确或已过期");
    }
    this.db.prepare("DELETE FROM login_codes WHERE identifier=?").run(id.id);
    const existing = this.row(id.id);
    if (!existing) this.insert(id, CODE_ONLY);
    return { token: this.issue(id.id), account: id.id, channel: id.channel, created: !existing };
  }

  changePassword(token: string, current: unknown, next: unknown): void {
    const accountId = this.accountForToken(token);
    if (!accountId) throw new SyncError(401, "bad_key", "Unknown or revoked key");
    const row = this.row(accountId);
    if (!row) throw new SyncError(401, "bad_key", "Unknown or revoked key");
    const secret = normalizePassword(next);
    if (row.password_hash !== CODE_ONLY) {
      const old = String(current ?? "");
      if (!verifyPassword(old, row.password_hash)) throw new SyncError(401, "bad_credentials", "账号或密码不正确");
    }
    this.db.prepare("UPDATE login_accounts SET password_hash=? WHERE id=?").run(hashPassword(secret), accountId);
  }

  revokeToken(token: string): void {
    this.db.prepare("DELETE FROM login_sessions WHERE token=?").run(token);
  }

  deleteAccount(token: string): string {
    const accountId = this.accountForToken(token);
    if (!accountId) throw new SyncError(401, "bad_key", "Unknown or revoked key");
    this.db.prepare("DELETE FROM login_sessions WHERE account_id=?").run(accountId);
    this.db.prepare("DELETE FROM login_codes WHERE identifier=?").run(accountId);
    this.db.prepare("DELETE FROM hub_devices WHERE account_id=?").run(accountId);
    this.db.prepare("DELETE FROM profiles WHERE account_id=?").run(accountId);
    this.db.prepare("DELETE FROM login_accounts WHERE id=?").run(accountId);
    return accountId;
  }

  accountForToken(token: string): string | null {
    const row = this.db.prepare("SELECT account_id FROM login_sessions WHERE token=?").get(token) as { account_id?: string } | undefined;
    return row?.account_id ? String(row.account_id) : null;
  }

  channelFor(accountId: string): AccountId["channel"] {
    const row = this.row(accountId);
    return row?.channel === "email" || row?.channel === "phone" ? row.channel : "account";
  }

  profile(accountId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT rev, device, body FROM profiles WHERE account_id=?").get(accountId) as { rev?: number; device?: string; body?: string } | undefined;
    const body = parseBody(row?.body);
    return {
      rev: Number(row?.rev ?? 0),
      device: String(row?.device ?? ""),
      name: String(body.name ?? accountId),
      avatar: "emoji",
      emoji: String(body.emoji ?? ""),
      color: String(body.color ?? ""),
      style: String(body.style ?? ""),
      description: String(body.description ?? ""),
      has_face: false,
      face_id: "",
      connectors: [],
    };
  }

  saveProfile(accountId: string, patch: Record<string, unknown>, device: string): Record<string, unknown> {
    const current = this.profile(accountId);
    const next = {
      name: clip(patch.name ?? current.name, 60),
      emoji: clip(patch.emoji ?? current.emoji, 16),
      color: clip(patch.color ?? current.color, 32),
      style: clip(patch.style ?? current.style, 32),
      description: clip(patch.description ?? current.description, 280),
    };
    const rev = Number(current.rev ?? 0) + 1;
    this.db.prepare("INSERT INTO profiles(account_id, rev, updated_at, device, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET rev=excluded.rev, updated_at=excluded.updated_at, device=excluded.device, body=excluded.body")
      .run(accountId, rev, now(), device.slice(0, 80), JSON.stringify(next));
    return this.profile(accountId);
  }

  rememberDevice(input: { accountId: string; id: string; name: string; kind: string; os: string; version: string; actions: string[] }): void {
    this.db.prepare(`INSERT INTO hub_devices(account_id, id, name, kind, os, version, actions, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, id) DO UPDATE SET name=excluded.name, kind=excluded.kind, os=excluded.os, version=excluded.version, actions=excluded.actions, last_seen=excluded.last_seen`)
      .run(input.accountId, input.id, input.name, input.kind, input.os, input.version, JSON.stringify(input.actions), now());
  }

  listDevices(accountId: string): StoredDevice[] {
    const rows = this.db.prepare("SELECT id, name, kind, os, version, actions, last_seen FROM hub_devices WHERE account_id=? ORDER BY last_seen DESC").all(accountId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind),
      os: String(row.os ?? ""),
      version: String(row.version ?? ""),
      actions: parseActions(row.actions),
      last_seen: Number(row.last_seen ?? 0),
    }));
  }

  forgetDevice(accountId: string, deviceId: string): boolean {
    const result = this.db.prepare("DELETE FROM hub_devices WHERE account_id=? AND id=?").run(accountId, deviceId);
    return Number(result.changes) > 0;
  }

  renameDevice(accountId: string, deviceId: string, name: string): boolean {
    const result = this.db.prepare("UPDATE hub_devices SET name=? WHERE account_id=? AND id=?").run(name, accountId, deviceId);
    return Number(result.changes) > 0;
  }

  private insert(id: AccountId, passwordHash: string): void {
    this.db.prepare("INSERT INTO login_accounts(id, password_hash, created_at, channel) VALUES (?, ?, ?, ?)").run(id.id, passwordHash, now(), id.channel);
  }

  private row(id: string): { password_hash: string; channel: string } | undefined {
    return this.db.prepare("SELECT password_hash, channel FROM login_accounts WHERE id=?").get(id) as { password_hash: string; channel: string } | undefined;
  }

  private issue(accountId: string): string {
    const token = randomBytes(24).toString("hex");
    this.db.prepare("INSERT INTO login_sessions(token, account_id, created_at) VALUES (?, ?, ?)").run(token, accountId, now());
    return token;
  }
}

export function normalizeAccount(value: unknown): AccountId {
  const raw = String(value ?? "").trim().toLowerCase();
  const phone = raw.replace(/[\s-]/g, "");
  if (PHONE.test(phone)) return { id: phone.replace(/^\+?86/, ""), channel: "phone" };
  if (raw.length <= 120 && EMAIL.test(raw)) return { id: raw, channel: "email" };
  if (NAME.test(raw)) return { id: raw, channel: "account" };
  throw new SyncError(400, "bad_account", "账号用 3–32 位字母数字，或填写手机号、邮箱");
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

function parseBody(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseActions(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").map(String) : [];
  } catch {
    return [];
  }
}

function clip(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
