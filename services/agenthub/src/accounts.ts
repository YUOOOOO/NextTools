import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { HubError } from './types.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const credentials = z.strictObject({ identifier: z.string().trim().min(3).max(254).transform(value => value.toLowerCase()), password: z.string().min(1).max(1024) });
const refreshInput = z.strictObject({ refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const accountId = z.string().uuid();
interface Account { id: string; identifier: string; salt: string; password_hash: string; disabled: number }
interface Session { id: string; account_id: string; access_hash: string; refresh_hash: string; access_expires: number; refresh_expires: number }

/** Account sessions authorize enrollment, never device-key recovery or relay traffic. */
export function createAccounts(db: DatabaseSync, registrationEnabled: boolean) {
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, identifier TEXT NOT NULL UNIQUE, salt TEXT NOT NULL,
    password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS account_sessions (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT NOT NULL UNIQUE,
    access_expires INTEGER NOT NULL, refresh_expires INTEGER NOT NULL
  );`);
  const attempts = new Map<string, { count: number; until: number }>();
  let hashing = 0;
  async function passwordHash(password: string, salt: string): Promise<Buffer> {
    if (hashing >= 4) throw new HubError('ACCOUNT_RATE_LIMIT', 429);
    hashing++;
    try {
      return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
    } finally { hashing--; }
  }
  function active(id: string): Account {
    const account = db.prepare('SELECT * FROM accounts WHERE id=? AND disabled=0').get(id) as unknown as Account | undefined;
    if (!account) throw new HubError('ACCOUNT_AUTH_REQUIRED', 401);
    return account;
  }
  function session(request: IncomingMessage): { account: Account; session: Session } {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 256) throw new HubError('ACCOUNT_AUTH_REQUIRED', 401);
    const row = db.prepare('SELECT * FROM account_sessions WHERE access_hash=? AND access_expires>?').get(digest(authorization.slice(7)), Date.now()) as unknown as Session | undefined;
    if (!row) throw new HubError('ACCOUNT_AUTH_REQUIRED', 401);
    return { account: active(row.account_id), session: row };
  }
  function issue(id: string, replace?: string) {
    active(id);
    const accessToken = randomBytes(32).toString('base64url'), refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 5 * 60_000;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM account_sessions WHERE refresh_expires<=?').run(Date.now());
      if (replace) db.prepare('DELETE FROM account_sessions WHERE id=?').run(replace);
      const count = db.prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE account_id=?').get(id) as { n: number };
      if (count.n >= 64) throw new HubError('ACCOUNT_SESSION_LIMIT', 429);
      db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?,?,?)').run(randomUUID(), id, digest(accessToken), digest(refreshToken), expiresAt, Date.now() + 30 * 86400_000);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { accountId: id, accessToken, refreshToken, expiresAt: Math.floor(expiresAt / 1000) };
  }
  return {
    active,
    session,
    scope(request: IncomingMessage): string {
      const value = request.headers['x-agenthub-account'];
      const parsed = accountId.safeParse(value);
      if (!parsed.success) throw new HubError('ACCOUNT_SCOPE_REQUIRED', 401);
      return active(parsed.data).id;
    },
    authorizeEnrollment(request: IncomingMessage, id: string): void {
      if (session(request).account.id !== id) throw new HubError('ACCOUNT_SCOPE_MISMATCH', 403);
    },
    async handle(request: IncomingMessage, path: string, body: unknown) {
      if (request.method === 'GET' && path === '/api/auth/me') {
        const { account } = session(request);
        return { accountId: account.id, identifier: account.identifier };
      }
      if (request.method !== 'POST') throw new HubError('NOT_FOUND', 404);
      if (path === '/api/auth/logout') {
        const current = session(request);
        db.prepare('DELETE FROM account_sessions WHERE id=?').run(current.session.id);
        return { loggedOut: true };
      }
      if (!['/api/auth/register', '/api/auth/login', '/api/auth/refresh'].includes(path)) throw new HubError('NOT_FOUND', 404);
      // Only the actual socket peer is trusted; arbitrary forwarding headers cannot bypass throttling.
      const key = request.socket.remoteAddress ?? 'unknown';
      for (const [address, value] of attempts) if (value.until <= Date.now()) attempts.delete(address);
      let attempt = attempts.get(key);
      if (!attempt) {
        if (attempts.size >= 4096) throw new HubError('ACCOUNT_RATE_LIMIT', 429);
        attempt = { count: 0, until: Date.now() + 60_000 }; attempts.set(key, attempt);
      }
      if (++attempt.count > 20) throw new HubError('ACCOUNT_RATE_LIMIT', 429);
      if (path === '/api/auth/refresh') {
        const input = refreshInput.safeParse(body);
        if (!input.success) throw new HubError('ACCOUNT_AUTH_REQUIRED', 401);
        const current = db.prepare('SELECT * FROM account_sessions WHERE refresh_hash=? AND refresh_expires>?').get(digest(input.data.refreshToken), Date.now()) as unknown as Session | undefined;
        if (!current) throw new HubError('ACCOUNT_AUTH_REQUIRED', 401);
        return issue(current.account_id, current.id);
      }
      const parsed = credentials.safeParse(body);
      if (!parsed.success) throw new HubError('ACCOUNT_CREDENTIALS_INVALID', 400);
      const { identifier, password } = parsed.data;
      if (path === '/api/auth/register') {
        if (!registrationEnabled) throw new HubError('ACCOUNT_REGISTRATION_DISABLED', 403);
        if (password.length < 12) throw new HubError('ACCOUNT_PASSWORD_WEAK', 400);
        const total = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
        if (total.n >= 10000) throw new HubError('ACCOUNT_CAPACITY', 429);
        const salt = randomBytes(16).toString('hex'), hash = await passwordHash(password, salt), id = randomUUID();
        try { db.prepare('INSERT INTO accounts(id,identifier,salt,password_hash) VALUES(?,?,?,?)').run(id, identifier, salt, hash.toString('hex')); }
        catch (error) {
          if (db.prepare('SELECT id FROM accounts WHERE identifier=?').get(identifier)) throw new HubError('ACCOUNT_EXISTS', 409);
          throw error;
        }
        return issue(id);
      }
      const account = db.prepare('SELECT * FROM accounts WHERE identifier=?').get(identifier) as unknown as Account | undefined;
      const hash = await passwordHash(password, account?.salt ?? 'agenthub-unknown-account');
      if (!account || !timingSafeEqual(hash, Buffer.from(account.password_hash, 'hex')) || account.disabled) throw new HubError('ACCOUNT_CREDENTIALS_INVALID', 401);
      return issue(account.id);
    },
  };
}
