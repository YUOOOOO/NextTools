import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { HubError } from './types.js';
import { runNexoWorker, type WorkerEvent } from './nexo-worker.js';

const credentialInput = z.strictObject({ apiKey: z.string().trim().min(1).max(4096) });
const createThreadInput = z.strictObject({ title: z.string().trim().min(1).max(160).optional() });
const sendMessageInput = z.strictObject({ content: z.string().trim().min(1).max(200_000), model: z.string().regex(/^claude-[a-zA-Z0-9._-]{1,100}$/).default('claude-sonnet-4-5-20250929') });
const threadIdSchema = z.string().uuid();
interface ThreadRow { id: string; title: string; created_at: number; updated_at: number; runtime_session_id: string | null }
interface MessageRow { id: string; role: 'user' | 'assistant'; content: string; created_at: number }

/** Per-account Nexo storage. Credentials are envelope-encrypted with an instance key and account-bound AAD. */
export function createNexo(db: DatabaseSync, accountId: string, encryptionKey: Buffer) {
  if (encryptionKey.length !== 32) throw new Error('AGENTHUB_CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes');
  db.exec(`CREATE TABLE IF NOT EXISTS nexo_credentials (
    provider TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL,
    tag BLOB NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nexo_threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, runtime_session_id TEXT
  );
  CREATE TABLE IF NOT EXISTS nexo_messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES nexo_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS nexo_messages_thread_created ON nexo_messages(thread_id, created_at, id);`);
  const threadColumns = db.prepare('PRAGMA table_info(nexo_threads)').all() as { name: string }[];
  if (!threadColumns.some(column => column.name === 'runtime_session_id')) db.exec('ALTER TABLE nexo_threads ADD COLUMN runtime_session_id TEXT');

  function encryptCredential(value: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`agenthub:nexo:${accountId}:anthropic:v1`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { nonce, ciphertext, tag: cipher.getAuthTag() };
  }

  function decryptCredential(row: { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }): string {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, row.nonce);
    decipher.setAAD(Buffer.from(`agenthub:nexo:${accountId}:anthropic:v1`));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  function requireOwnedThread(id: string): ThreadRow {
    const parsed = threadIdSchema.safeParse(id);
    if (!parsed.success) throw new HubError('NEXO_THREAD_NOT_FOUND', 404);
    const row = db.prepare('SELECT id,title,created_at,updated_at,runtime_session_id FROM nexo_threads WHERE id=?').get(parsed.data) as unknown as ThreadRow | undefined;
    if (!row) throw new HubError('NEXO_THREAD_NOT_FOUND', 404);
    return row;
  }

  return {
    async handle(request: IncomingMessage, url: URL, input: unknown): Promise<unknown> {
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/nexo/credential') {
        const row = db.prepare('SELECT updated_at FROM nexo_credentials WHERE provider=?').get('anthropic') as { updated_at: number } | undefined;
        return { configured: Boolean(row), updatedAt: row ? new Date(row.updated_at).toISOString() : null };
      }
      if (request.method === 'PUT' && path === '/api/nexo/credential') {
        const parsed = credentialInput.safeParse(input);
        if (!parsed.success) throw new HubError('NEXO_CREDENTIAL_INVALID', 400);
        const encrypted = encryptCredential(parsed.data.apiKey);
        db.prepare(`INSERT INTO nexo_credentials(provider,nonce,ciphertext,tag,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(provider) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag,updated_at=excluded.updated_at`)
          .run('anthropic', encrypted.nonce, encrypted.ciphertext, encrypted.tag, Date.now());
        return { configured: true };
      }
      if (request.method === 'DELETE' && path === '/api/nexo/credential') {
        db.prepare('DELETE FROM nexo_credentials WHERE provider=?').run('anthropic');
        return { configured: false };
      }
      if (request.method === 'GET' && path === '/api/nexo/threads') {
        const rows = db.prepare(`SELECT t.id,t.title,t.created_at,t.updated_at,
          (SELECT count(*) FROM nexo_messages m WHERE m.thread_id=t.id) AS message_count
          FROM nexo_threads t ORDER BY t.updated_at DESC,t.id LIMIT 100`).all() as unknown as (ThreadRow & { message_count: number })[];
        return { items: rows.map(({ created_at, updated_at, ...row }) => ({ ...row, createdAt: new Date(created_at).toISOString(), updatedAt: new Date(updated_at).toISOString() })) };
      }
      if (request.method === 'POST' && path === '/api/nexo/threads') {
        const parsed = createThreadInput.safeParse(input);
        if (!parsed.success) throw new HubError('NEXO_THREAD_INVALID', 400);
        const id = randomUUID(), now = Date.now(), title = parsed.data.title ?? 'New Nexo chat';
        db.prepare('INSERT INTO nexo_threads(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, title, now, now);
        return { id, title, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), messages: [] };
      }
      const sendMatch = /^\/api\/nexo\/threads\/([^/]+)\/messages$/.exec(path);
      if (sendMatch && request.method === 'POST') {
        const thread = requireOwnedThread(sendMatch[1]);
        const parsed = sendMessageInput.safeParse(input);
        if (!parsed.success) throw new HubError('NEXO_MESSAGE_INVALID', 400);
        const apiKey = this.getProviderCredential();
        let assistantText = '', sessionId: string | undefined;
        await runNexoWorker(accountId, {
          prompt: parsed.data.content, apiKey, model: parsed.data.model,
          ...(thread.runtime_session_id ? { resume: thread.runtime_session_id } : {}),
        }, (event: WorkerEvent) => {
          if (event.type === 'session' && event.sessionId) sessionId = event.sessionId;
          if (event.type === 'assistant' && event.text) {
            if (assistantText.length + event.text.length > 500_000) throw new HubError('NEXO_MESSAGE_TOO_LARGE', 413);
            assistantText += event.text;
          }
        });
        if (!assistantText.trim() || !sessionId) throw new HubError('NEXO_WORKER_FAILED', 502);
        this.persistTurn(thread.id, parsed.data.content, assistantText, sessionId);
        return { assistant: assistantText, sessionId };
      }
      const match = /^\/api\/nexo\/threads\/([^/]+)$/.exec(path);
      if (match && request.method === 'GET') {
        const thread = requireOwnedThread(match[1]);
        const messages = db.prepare('SELECT id,role,content,created_at FROM nexo_messages WHERE thread_id=? ORDER BY created_at,id LIMIT 500')
          .all(thread.id) as unknown as MessageRow[];
        return {
          id: thread.id, title: thread.title,
          createdAt: new Date(thread.created_at).toISOString(), updatedAt: new Date(thread.updated_at).toISOString(),
          messages: messages.map(({ created_at, ...message }) => ({ ...message, createdAt: new Date(created_at).toISOString() })),
        };
      }
      if (match && request.method === 'DELETE') {
        const thread = requireOwnedThread(match[1]);
        db.prepare('DELETE FROM nexo_threads WHERE id=?').run(thread.id);
        return { deleted: true };
      }
      throw new HubError('NOT_FOUND', 404);
    },

    /** Decrypt only inside the trusted account worker handoff; never part of API responses. */
    getProviderCredential(): string {
      const row = db.prepare('SELECT nonce,ciphertext,tag FROM nexo_credentials WHERE provider=?').get('anthropic') as
        { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array } | undefined;
      if (!row) throw new HubError('NEXO_CREDENTIAL_REQUIRED', 409);
      try { return decryptCredential(row); }
      catch { throw new HubError('NEXO_CREDENTIAL_UNAVAILABLE', 503); }
    },

    persistTurn(threadId: string, userText: string, assistantText: string, sessionId?: string): void {
      const thread = requireOwnedThread(threadId);
      if (!userText.trim() || userText.length > 200_000 || assistantText.length > 500_000) throw new HubError('NEXO_MESSAGE_INVALID', 400);
      const latest = db.prepare('SELECT MAX(created_at) AS latest FROM nexo_messages WHERE thread_id=?').get(thread.id) as { latest: number | null };
      const now = Math.max(Date.now(), (latest.latest ?? 0) + 1);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO nexo_messages(id,thread_id,role,content,created_at) VALUES(?,?,?,?,?)')
          .run(randomUUID(), thread.id, 'user', userText, now);
        db.prepare('INSERT INTO nexo_messages(id,thread_id,role,content,created_at) VALUES(?,?,?,?,?)')
          .run(randomUUID(), thread.id, 'assistant', assistantText, now + 1);
        db.prepare('UPDATE nexo_threads SET updated_at=?,runtime_session_id=COALESCE(?,runtime_session_id) WHERE id=?').run(now, sessionId ?? null, thread.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

export function readCredentialEncryptionKey(value: string | undefined): Buffer {
  if (!value) throw new Error('AGENTHUB_CREDENTIAL_ENCRYPTION_KEY is required');
  let key: Buffer;
  try { key = Buffer.from(value, 'base64url'); }
  catch { throw new Error('AGENTHUB_CREDENTIAL_ENCRYPTION_KEY must be base64url'); }
  if (key.length !== 32 || key.toString('base64url') !== value) throw new Error('AGENTHUB_CREDENTIAL_ENCRYPTION_KEY must be canonical base64url encoding of 32 bytes');
  return key;
}
