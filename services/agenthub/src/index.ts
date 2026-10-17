import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createAccounts } from './accounts.js';
import { createIdentity } from './identity.js';
import { createMetadata } from './metadata.js';
import { createRelay } from './relay.js';
import { HubError, type HubConfig } from './types.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.AGENTHUB_DATA_DIR ?? join(root, 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const settingsPath = join(dataDir, 'instance.json');
const saved = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<HubConfig> : {};
const config: Omit<HubConfig, 'principalId' | 'networkId'> = {
  issuer: process.env.AGENTHUB_ISSUER ?? 'https://localhost:8443',
  name: process.env.AGENTHUB_NAME ?? 'NextTools AgentHub',
  environment: process.env.AGENTHUB_ENVIRONMENT === 'production' ? 'production' : 'development',
  serviceId: process.env.AGENTHUB_SERVICE_ID ?? saved.serviceId ?? randomUUID(),
  dataDir,
};
const issuer = new URL(config.issuer);
if (issuer.protocol !== 'https:' || issuer.origin !== config.issuer || issuer.username || issuer.password) throw new Error('AGENTHUB_ISSUER must be an HTTPS origin');
if (saved.serviceId && saved.serviceId !== config.serviceId) throw new Error('Instance service ID cannot change in an existing data directory');
writeFileSync(settingsPath, JSON.stringify(config), { mode: 0o600 });
const db = new DatabaseSync(join(dataDir, 'accounts.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
const accounts = createAccounts(db, process.env.AGENTHUB_REGISTRATION_ENABLED !== 'false');

// Existing protocol owners are single-principal. Give each local account its own
// durable partition and relay, rather than letting instance-wide state cross accounts.
async function openHub(accountId: string) {
  const accountDb = new DatabaseSync(join(dataDir, `account-${accountId}.sqlite`));
  accountDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  try {
    const scoped: HubConfig = { ...config, principalId: accountId, networkId: accountId };
    const identity = await createIdentity(scoped, accountDb, request => accounts.authorizeEnrollment(request, accountId));
    const metadata = createMetadata(scoped, accountDb, identity);
    const relay = createRelay(scoped, identity, metadata);
    return { identity, metadata, relay, db: accountDb };
  } catch (error) { accountDb.close(); throw error; }
}
const hubs = new Map<string, ReturnType<typeof openHub>>();
function hubFor(request: IncomingMessage) {
  const id = accounts.scope(request);
  let pending = hubs.get(id);
  if (!pending) {
    if (hubs.size >= 256) throw new HubError('ACCOUNT_CONNECTION_CAPACITY', 503);
    pending = openHub(id); hubs.set(id, pending);
    void pending.catch(() => { if (hubs.get(id) === pending) hubs.delete(id); });
  }
  return pending;
}

function json(res: ServerResponse, status: number, value: unknown, requestId: string): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), 'x-request-id': requestId });
  res.end(body);
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const item = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += item.length;
    if (size > 1_048_576) throw new HubError('MESSAGE_TOO_LARGE', 413);
    chunks.push(item);
  }
  if (!size) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HubError('REQUEST_INVALID', 400); }
}
function errorResponse(error: unknown): { status: number; payload: unknown } {
  if (error instanceof HubError) return { status: error.status, payload: { success: false, code: error.code, ...('details' in error ? { details: error.details } : {}) } };
  console.error('[agenthub]', error instanceof Error ? error.message : error);
  return { status: 500, payload: { success: false, code: 'INTERNAL_ERROR' } };
}
async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestId = randomUUID();
  let networkRequest = false;
  try {
    const url = new URL(request.url ?? '/', config.issuer);
    networkRequest = url.pathname.startsWith('/v1/');
    const input = request.method === 'GET' ? undefined : await body(request);
    if (url.pathname.startsWith('/api/auth/')) {
      return json(response, 200, { success: true, data: await accounts.handle(request, url.pathname, input) }, requestId);
    }
    if (url.pathname.startsWith('/api/agent-network/') || url.pathname.startsWith('/v1/')) {
      const hub = await hubFor(request);
      accounts.scope(request); // Account may have been disabled while its partition was opening.
      const result = url.pathname.startsWith('/api/agent-network/')
        ? await hub.identity.handle(request, url, input)
        : hub.metadata.handle(await hub.identity.authenticate(request), request, url, input);
      return json(response, 200, networkRequest ? { ok: true, data: result, requestId } : { success: true, data: result }, requestId);
    }
    throw new HubError('NOT_FOUND', 404);
  } catch (error) {
    const result = errorResponse(error);
    json(response, result.status, networkRequest ? { ok: false, error: { code: error instanceof HubError ? error.code : 'INTERNAL_ERROR', retryable: result.status === 429 || result.status >= 500, ...(error instanceof HubError && error.details !== undefined ? { details: error.details } : {}) }, requestId } : result.payload, requestId);
  }
}
const tlsKey = process.env.AGENTHUB_TLS_KEY;
const tlsCert = process.env.AGENTHUB_TLS_CERT;
if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error('Set both AGENTHUB_TLS_KEY and AGENTHUB_TLS_CERT');
if (!tlsKey && process.env.AGENTHUB_BEHIND_TLS_PROXY !== 'true') throw new Error('HTTPS certificates or AGENTHUB_BEHIND_TLS_PROXY=true are required');
const server = tlsKey && tlsCert
  ? createHttpsServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert), minVersion: 'TLSv1.2' }, handler)
  : createServer(handler);
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 1000;
server.maxConnections = 512;
server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url ?? '/', config.issuer).pathname !== '/v1/ws') return socket.destroy();
  void (async () => {
    const hub = await hubFor(request);
    accounts.scope(request);
    await hub.relay.upgrade(request, socket, head);
  })().catch(() => socket.destroy());
});
const port = Number(process.env.PORT ?? 8443);
server.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`AgentHub listening on ${config.issuer}`));
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const drained = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const deadline = setTimeout(() => server.closeAllConnections(), 10_000);
  deadline.unref();
  try {
    for (const pending of hubs.values()) {
      const hub = await pending;
      await hub.relay.close(); hub.db.close();
    }
    await drained;
  } finally { clearTimeout(deadline); db.close(); }
};
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
