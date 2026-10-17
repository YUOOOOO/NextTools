import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature, webcrypto } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { SignJWT, calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify, compactVerify, type JWK, type JWTPayload } from 'jose';
import { BasicConstraintsExtension, ExtendedKeyUsage, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, Pkcs10CertificateRequest, SubjectAlternativeNameExtension, SubjectKeyIdentifierExtension, X509Certificate, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509';
import { accessClaimsSchema, signedPeerClaimsSchema, peerBindingSchema, type PeerBinding } from '@myagents/agent-network-protocol';
import { z } from 'zod';
import { HubError, type AuthContext, type HubConfig, type IdentityApi, type IdentityDevice } from './types.js';

const crypto = webcrypto as unknown as Crypto;
cryptoProvider.set(crypto);
const now = () => Math.floor(Date.now() / 1000);
const hash = (value: string | Uint8Array | ArrayBuffer) => createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value as Uint8Array)).digest('base64url');
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deviceInfo = z.strictObject({ deviceName: z.string().min(1).max(512), platform: z.string().max(128), osVersion: z.string().max(512), appVersion: z.string().max(128) });
const enrollSchema = z.strictObject({ deviceId: uuid, csr: z.string().min(1).max(16384), expectedKeyGeneration: generation.nullable(), deviceInfo });
const challengeSchema = z.strictObject({ deviceId: uuid, operation: z.enum(['recover-query', 'renew', 'revoke', 'revoke-query', 'rotate']), targetFingerprint: fingerprint, expectedKeyGeneration: generation });
const proofFields = { deviceId: uuid, expectedKeyGeneration: generation, challengeId: uuid, proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/) };
const querySchema = z.strictObject({ ...proofFields, keyFingerprint: fingerprint });
const certificateSchema = z.strictObject({ ...proofFields, csr: z.string().min(1).max(16384) });
const rotateSchema = z.strictObject({ ...proofFields, csr: z.string().min(1).max(16384), deviceInfo });
const ACCESS_SECONDS = 3600;
const CERTIFICATE_SECONDS = 7 * 86400;
const PEER_AUDIENCE = 'nexttools-agent-peer';
const peerClaimsSchema = signedPeerClaimsSchema;
interface DeviceRecord { deviceId: string; generation: number; bindingId: string; spki: string; jwk: JWK; fingerprint: string; thumbprint: string; certificate: string; certificateFingerprint: string; certificateExpiresAt: number; signedBinding: string; info: z.infer<typeof deviceInfo>; lastSeen: string; revoked: boolean }
interface ChallengeRecord { id: string; device: string; generation: number; operation: string; target: string; nonce: string; expires: number }
interface Secrets { issuer: string; serviceId: string; principalId: string; networkId: string; environment: string; caPrivate: JWK; caCertificate: string; intermediatePrivate: JWK; intermediateCertificate: string; issuerPrivate: JWK; kid: string }
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw new HubError('IDENTITY_REQUEST_INVALID'); return parsed.data; }
function fail(code = 'NETWORK_SIGNED_IDENTITY_INVALID'): never { throw new HubError(code, 401); }
function secretEqual(a: string, b: string): boolean { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()); }

/** 私钥只在服务端数据库中保存；客户端提交的 CSR 永远不能控制证书用途或 SAN。 */
export async function createIdentity(config: HubConfig, db: DatabaseSync): Promise<IdentityApi> {
  db.exec(`CREATE TABLE IF NOT EXISTS identity_secrets (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_devices (device TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_retired (device TEXT NOT NULL, generation INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(device,generation));
    CREATE TABLE IF NOT EXISTS identity_sessions (handle TEXT PRIMARY KEY, device TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_challenges (id TEXT PRIMARY KEY, device TEXT NOT NULL, generation INTEGER NOT NULL, operation TEXT NOT NULL, target TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_dpop (jti TEXT PRIMARY KEY, expires INTEGER NOT NULL);`);
  const saved = db.prepare('SELECT value FROM identity_secrets WHERE id=1').get() as { value: string } | undefined;
  let secrets: Secrets;
  if (saved) {
    secrets = JSON.parse(saved.value) as Secrets;
    for (const field of ['issuer', 'serviceId', 'principalId', 'networkId', 'environment'] as const) {
      if (secrets[field] !== config[field]) throw new Error(`Persistent identity configuration mismatch: ${field}`);
    }
  } else {
    const ca = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const issuer = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const root = await X509CertificateGenerator.createSelfSigned({ name: `CN=AgentHub ${config.serviceId}`, keys: ca,
      serialNumber: randomBytes(16).toString('hex'), notBefore: new Date((now() - 30) * 1000), notAfter: new Date((now() + 10 * 366 * 86400) * 1000),
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, extensions: [new BasicConstraintsExtension(true, 1, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true), await SubjectKeyIdentifierExtension.create(ca.publicKey)] });
    const intermediate = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const intermediateCertificate = await X509CertificateGenerator.create({ subject: `CN=AgentHub Device CA ${config.serviceId}`, issuer: root.subject,
      publicKey: intermediate.publicKey, signingKey: ca.privateKey, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, serialNumber: randomBytes(16).toString('hex'),
      notBefore: new Date((now() - 30) * 1000), notAfter: new Date((now() + 5 * 366 * 86400) * 1000),
      extensions: [new BasicConstraintsExtension(true, 0, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true), await SubjectKeyIdentifierExtension.create(intermediate.publicKey)] });
    secrets = { issuer: config.issuer, serviceId: config.serviceId, principalId: config.principalId, networkId: config.networkId, environment: config.environment,
      caPrivate: await crypto.subtle.exportKey('jwk', ca.privateKey) as JWK, caCertificate: root.toString('pem'), intermediatePrivate: await crypto.subtle.exportKey('jwk', intermediate.privateKey) as JWK,
      intermediateCertificate: intermediateCertificate.toString('pem'), issuerPrivate: await crypto.subtle.exportKey('jwk', issuer.privateKey) as JWK, kid: randomUUID() };
    db.prepare('INSERT INTO identity_secrets(id,value) VALUES(1,?)').run(JSON.stringify(secrets));
  }
  const issuerKey = await importJWK(secrets.issuerPrivate, 'ES256');
  const signingJwk: JWK = { kty: 'EC', crv: 'P-256', x: secrets.issuerPrivate.x, y: secrets.issuerPrivate.y, kid: secrets.kid, use: 'sig', alg: 'ES256' };
  const verifyKey = await importJWK(signingJwk, 'ES256');
  const caKey = await crypto.subtle.importKey('jwk', secrets.intermediatePrivate as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const intermediate = new X509Certificate(secrets.intermediateCertificate);
  const descriptor = { serviceId: config.serviceId, environment: config.environment, principalId: config.principalId, networkId: config.networkId, name: config.name, issuer: config.issuer,
    protocol: 1, capabilities: ['tls13-mtls', 'typed-rpc', 'permit-v1', 'return-v1'], rootCertificate: secrets.caCertificate, jwks: { keys: [signingJwk] } };
  const load = (id: string): DeviceRecord | undefined => { const row = db.prepare('SELECT value FROM identity_devices WHERE device=?').get(id) as { value: string } | undefined; return row ? JSON.parse(row.value) as DeviceRecord : undefined; };
  const persist = (device: DeviceRecord) => db.prepare('INSERT INTO identity_devices(device,value) VALUES(?,?) ON CONFLICT(device) DO UPDATE SET value=excluded.value').run(device.deviceId, JSON.stringify(device));
  const active = (id: string, expected: number) => { const device = load(id); if (!device) fail('DEVICE_NOT_FOUND'); if (device.generation !== expected) fail('NETWORK_CREDENTIAL_GENERATION_CONFLICT'); if (device.revoked) fail('DEVICE_REVOKED'); return device; };
  const sign = (claims: JWTPayload, typ: string) => new SignJWT(claims).setProtectedHeader({ alg: 'ES256', typ, kid: secrets.kid }).sign(issuerKey);
  const locks = new Map<string, Promise<unknown>>();
  async function exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action); locks.set(id, next);
    try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
  }
  async function csr(value: string) {
    try {
      if (!/^-----BEGIN CERTIFICATE REQUEST-----[\s\S]+-----END CERTIFICATE REQUEST-----\s*$/.test(value)) fail('NETWORK_CSR_INVALID');
      const request = new Pkcs10CertificateRequest(value);
      if (request.signatureAlgorithm.name !== 'ECDSA' || request.signatureAlgorithm.hash.name !== 'SHA-256' || !await request.verify()) fail('NETWORK_CSR_INVALID');
      const key = await request.publicKey.export({ name: 'ECDSA', namedCurve: 'P-256' }, ['verify']);
      const jwk = await crypto.subtle.exportKey('jwk', key) as JWK;
      if (jwk.crv !== 'P-256' || jwk.kty !== 'EC') fail('NETWORK_CSR_INVALID');
      const spki = Buffer.from(request.publicKey.rawData).toString('base64');
      return { request, jwk, spki, fingerprint: hash(Buffer.from(spki, 'base64')), thumbprint: await calculateJwkThumbprint(jwk) };
    } catch { throw new HubError('NETWORK_CSR_INVALID'); }
  }
  async function issueCertificate(device: DeviceRecord) {
    const issued = now();
    const san = `${device.bindingId}.devices.${config.serviceId}.invalid`;
    const cert = await X509CertificateGenerator.create({ subject: `CN=${device.bindingId}`, issuer: intermediate.subject,
      publicKey: Buffer.from(device.spki, 'base64'), signingKey: caKey, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      serialNumber: randomBytes(16).toString('hex'), notBefore: new Date((issued - 30) * 1000), notAfter: new Date((issued + CERTIFICATE_SECONDS) * 1000),
      extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth, ExtendedKeyUsage.clientAuth]), new SubjectAlternativeNameExtension([{ type: 'dns', value: san }])] });
    device.certificate = cert.toString('pem'); device.certificateFingerprint = hash(cert.rawData); device.certificateExpiresAt = issued + CERTIFICATE_SECONDS;
    const binding: PeerBinding = { serviceId: config.serviceId, environment: config.environment, principalId: config.principalId, deviceId: device.deviceId, keyGeneration: device.generation,
      identityBindingId: device.bindingId, certificateFingerprint: device.certificateFingerprint, certificate: device.certificate, san, expiresAt: device.certificateExpiresAt };
    device.signedBinding = await sign({ iss: config.issuer, aud: PEER_AUDIENCE, sub: config.principalId, iat: issued, nbf: issued, exp: device.certificateExpiresAt, jti: randomUUID(), binding }, 'ma-network-peer+jwt');
  }
  function peer(device: DeviceRecord) { return { deviceId: device.deviceId, keyGeneration: device.generation, identityBindingId: device.bindingId, certificate: device.certificate,
    certificateChain: [secrets.intermediateCertificate, secrets.caCertificate], certificateFingerprint: device.certificateFingerprint, signedBinding: device.signedBinding, certificateExpiresAt: device.certificateExpiresAt }; }
  async function tokens(device: DeviceRecord) {
    const issued = now(), expires = issued + ACCESS_SECONDS, handle = randomUUID();
    const claims = { iss: config.issuer, aud: config.serviceId, sub: config.principalId, iat: issued, nbf: issued, exp: expires, jti: randomUUID(), environment: config.environment,
      deviceId: device.deviceId, keyGeneration: device.generation, sessionHandle: handle, cnf: { jkt: device.thumbprint } };
    const accessToken = await sign(claims, 'ma-network-access+jwt');
    const bootstrapGrant = await sign({ ...claims, jti: randomUUID(), networkUrl: config.issuer, rootCertificate: secrets.caCertificate }, 'ma-network-bootstrap+jwt');
    db.prepare('DELETE FROM identity_sessions WHERE expires<=?').run(issued);
    const sessions = db.prepare('SELECT COUNT(*) AS count FROM identity_sessions WHERE device=?').get(device.deviceId) as { count: number };
    if (sessions.count >= 64) throw new HubError('NETWORK_SESSION_LIMIT', 429);
    db.prepare('INSERT INTO identity_sessions(handle,device,generation,expires) VALUES(?,?,?,?)').run(handle, device.deviceId, device.generation, expires);
    device.lastSeen = new Date().toISOString(); persist(device);
    return { ...peer(device), accessToken, accessTokenExpiresAt: expires, bootstrapGrant };
  }
  /** 挑战只能使用一次；消费后验签，失败也不能重放同一个挑战。 */
  function consume(body: z.infer<typeof querySchema> | z.infer<typeof certificateSchema>, operation: string, target: string, allowRevoked = false): DeviceRecord {
    const challenge = db.prepare('DELETE FROM identity_challenges WHERE id=? RETURNING *').get(body.challengeId) as unknown as ChallengeRecord | undefined;
    if (!challenge || challenge.expires <= now() || challenge.device !== body.deviceId || challenge.generation !== body.expectedKeyGeneration || challenge.operation !== operation || challenge.target !== target) fail('NETWORK_PROOF_INVALID');
    let device = load(body.deviceId);
    if (device?.generation !== body.expectedKeyGeneration && allowRevoked) {
      const row = db.prepare('SELECT value FROM identity_retired WHERE device=? AND generation=?').get(body.deviceId, body.expectedKeyGeneration) as { value: string } | undefined;
      device = row ? JSON.parse(row.value) as DeviceRecord : undefined;
    }
    if (!device || device.generation !== body.expectedKeyGeneration) fail('NETWORK_CREDENTIAL_GENERATION_CONFLICT');
    if (device.revoked && !allowRevoked) fail('DEVICE_REVOKED');
    const message = Buffer.concat([Buffer.from(`NextTools Agent Network PoP v1\n${challenge.id}\n`), Buffer.from(challenge.nonce, 'base64url')]);
    if (!verifySignature('sha256', message, { key: createPublicKey({ key: Buffer.from(device.spki, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(body.proof, 'base64url'))) fail('NETWORK_PROOF_INVALID');
    return device;
  }
  async function verified(token: string, typ: string, audience: string) {
    try {
      if (token.length > 32768) fail();
      const header = decodeProtectedHeader(token);
      if (header.kid !== secrets.kid || header.typ !== typ || header.alg !== 'ES256' || Object.keys(header).some(k => !['kid', 'typ', 'alg'].includes(k))) fail();
      const result = await jwtVerify(token, verifyKey, { algorithms: ['ES256'], issuer: config.issuer, audience, clockTolerance: 0, requiredClaims: ['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti'] });
      if (result.payload.sub !== config.principalId) fail();
      return result.payload;
    } catch { return fail(); }
  }
  const api: IdentityApi = {
    descriptor: () => descriptor,
    devices: () => (db.prepare('SELECT value FROM identity_devices ORDER BY device').all() as { value: string }[]).map(row => JSON.parse(row.value) as DeviceRecord).filter(d => !d.revoked).map((d): IdentityDevice => ({ deviceId: d.deviceId, name: d.info.deviceName, platform: d.info.platform, osVersion: d.info.osVersion, appVersion: d.info.appVersion, lastAccountSeenAt: d.lastSeen })),
    async verifyAccess(token) {
      const claims = parse(accessClaimsSchema, await verified(token, 'ma-network-access+jwt', config.serviceId));
      if (claims.environment !== config.environment || claims.exp - claims.iat > ACCESS_SECONDS || claims.exp <= claims.iat || claims.iat > now() + 30) fail();
      const device = active(claims.deviceId, claims.keyGeneration);
      const session = db.prepare('SELECT * FROM identity_sessions WHERE handle=?').get(claims.sessionHandle) as { device: string; generation: number; expires: number } | undefined;
      if (!session || session.device !== device.deviceId || session.generation !== device.generation || session.expires !== claims.exp || claims.cnf.jkt !== device.thumbprint) fail();
      return { scope: { serviceId: config.serviceId, environment: config.environment, networkId: config.networkId, principalId: config.principalId, deviceId: device.deviceId, keyGeneration: device.generation }, sessionHandle: claims.sessionHandle,
        keyFingerprint: device.fingerprint, certificateFingerprint: device.certificateFingerprint, signedBinding: device.signedBinding, expiresAt: claims.exp };
    },
    async verifyBinding(token) {
      const claims = parse(peerClaimsSchema, await verified(token, 'ma-network-peer+jwt', PEER_AUDIENCE));
      const binding = parse(peerBindingSchema, claims.binding);
      active(binding.deviceId, binding.keyGeneration);
      if (binding.serviceId !== config.serviceId || binding.environment !== config.environment || binding.principalId !== config.principalId || binding.expiresAt !== claims.exp || claims.exp - claims.iat > CERTIFICATE_SECONDS || binding.san !== `${binding.identityBindingId}.devices.${config.serviceId}.invalid`) fail();
      return binding;
    },
    async authenticate(request: IncomingMessage): Promise<AuthContext> {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ') || authorization.length > 32775) fail('NETWORK_AUTH_REQUIRED');
      const token = authorization.slice(7), proof = request.headers.dpop;
      if (typeof proof !== 'string' || proof.length > 8192) fail('NETWORK_DPOP_INVALID');
      const auth = await api.verifyAccess(token);
      try {
        const header = decodeProtectedHeader(proof);
        if (header.alg !== 'ES256' || header.typ !== 'dpop+jwt' || !header.jwk || Object.keys(header).some(k => !['alg', 'typ', 'jwk'].includes(k))) fail();
        const jwk = header.jwk;
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk || Object.keys(jwk).some(k => !['kty', 'crv', 'x', 'y'].includes(k))) fail();
        const device = active(auth.scope.deviceId, auth.scope.keyGeneration);
        if (await calculateJwkThumbprint(jwk) !== device.thumbprint) fail();
        const result = await compactVerify(proof, await importJWK(jwk, 'ES256'), { algorithms: ['ES256'] });
        const claims = parse(z.strictObject({ jti: uuid, iat: z.number().int().positive(), htm: z.string(), htu: z.string().max(4096), ath: fingerprint, nonce: z.string().max(256).optional() }), JSON.parse(Buffer.from(result.payload).toString('utf8')));
        const url = new URL(request.url ?? '/', config.issuer); url.search = ''; url.hash = '';
        if (url.origin !== config.issuer || claims.htm !== request.method || claims.htu !== url.href || claims.ath !== hash(token) || Math.abs(now() - claims.iat) > 30) fail();
        db.prepare('DELETE FROM identity_dpop WHERE expires<=?').run(now());
        const total = db.prepare('SELECT COUNT(*) AS count FROM identity_dpop').get() as { count: number };
        if (total.count >= 100000) throw new HubError('NETWORK_DPOP_LIMIT', 429);
        try { db.prepare('INSERT INTO identity_dpop(jti,expires) VALUES(?,?)').run(claims.jti, claims.iat + 31); } catch { fail(); }
        return auth;
      } catch { return fail('NETWORK_DPOP_INVALID'); }
    },
    async handle(request, url, body) {
      const path = url.pathname, method = request.method;
      if (method === 'GET' && path === '/api/agent-network/descriptor') return descriptor;
      if (method === 'GET' && path === '/api/agent-network/jwks') return descriptor.jwks;
      if (method === 'GET' && path === '/api/agent-network/identity/state') {
        const deviceId = parse(uuid, url.searchParams.get('deviceId')), device = load(deviceId);
        return { serviceId: config.serviceId, environment: config.environment, deviceId, keyGeneration: device?.generation ?? null, keyFingerprint: device?.fingerprint ?? null };
      }
      if (method !== 'POST') throw new HubError('NOT_FOUND', 404);
      if (path === '/api/agent-network/challenge') {
        const input = parse(challengeSchema, body); let device = load(input.deviceId);
        if (input.operation === 'revoke-query' && device?.generation !== input.expectedKeyGeneration) {
          const retired = db.prepare('SELECT value FROM identity_retired WHERE device=? AND generation=?').get(input.deviceId, input.expectedKeyGeneration) as { value: string } | undefined;
          device = retired ? JSON.parse(retired.value) as DeviceRecord : undefined;
        }
        if (!device || device.generation !== input.expectedKeyGeneration) fail('NETWORK_CREDENTIAL_GENERATION_CONFLICT');
        if (device.revoked && input.operation !== 'revoke-query') fail('DEVICE_REVOKED');
        if (input.operation !== 'rotate' && input.targetFingerprint !== device.fingerprint) fail('IDENTITY_KEY_MISMATCH');
        db.prepare('DELETE FROM identity_challenges WHERE expires<=?').run(now());
        const count = db.prepare('SELECT COUNT(*) AS count FROM identity_challenges WHERE device=?').get(input.deviceId) as { count: number };
        if (count.count >= 32) throw new HubError('NETWORK_CHALLENGE_LIMIT', 429);
        const id = randomUUID(), nonce = randomBytes(32).toString('base64url'), expires = now() + 60;
        db.prepare('INSERT INTO identity_challenges VALUES(?,?,?,?,?,?,?)').run(id, input.deviceId, input.expectedKeyGeneration, input.operation, input.targetFingerprint, nonce, expires);
        return { challengeId: id, nonce, expiresAt: expires };
      }
      if (path === '/api/agent-network/identity') {
        const input = parse(enrollSchema, body);
        const key = request.headers['x-agenthub-key'];
        if (typeof key !== 'string' || !secretEqual(key, config.enrollmentKey)) fail('NETWORK_ENROLLMENT_KEY_INVALID');
        const publicKey = await csr(input.csr);
        return exclusive(input.deviceId, async () => {
          const previous = load(input.deviceId);
          if (previous && !previous.revoked) fail('DEVICE_ALREADY_ENROLLED');
          if ((previous?.generation ?? null) !== input.expectedKeyGeneration) fail('NETWORK_CREDENTIAL_GENERATION_CONFLICT');
          const total = db.prepare('SELECT COUNT(*) AS count FROM identity_devices').get() as { count: number };
          if (!previous && total.count >= 10000) throw new HubError('NETWORK_DEVICE_LIMIT', 429);
          const device: DeviceRecord = { deviceId: input.deviceId, generation: previous ? previous.generation + 1 : 1, bindingId: randomUUID(), spki: publicKey.spki, jwk: publicKey.jwk, fingerprint: publicKey.fingerprint, thumbprint: publicKey.thumbprint,
            certificate: '', certificateFingerprint: '', certificateExpiresAt: 0, signedBinding: '', info: input.deviceInfo, lastSeen: new Date().toISOString(), revoked: false };
          await issueCertificate(device);
          if (previous) db.prepare('INSERT OR REPLACE INTO identity_retired VALUES(?,?,?)').run(previous.deviceId, previous.generation, JSON.stringify(previous));
          persist(device); return tokens(device);
        });
      }
      if (path === '/api/agent-network/identity/current') {
        const input = parse(querySchema, body);
        return exclusive(input.deviceId, async () => { const device = consume(input, 'recover-query', input.keyFingerprint); return tokens(device); });
      }
      if (path === '/api/agent-network/certificate') {
        const input = parse(certificateSchema, body), publicKey = await csr(input.csr);
        return exclusive(input.deviceId, async () => { const device = consume(input, 'renew', publicKey.fingerprint); if (publicKey.fingerprint !== device.fingerprint) fail('IDENTITY_KEY_MISMATCH'); await issueCertificate(device); persist(device); return peer(device); });
      }
      if (path === '/api/agent-network/identity/rotate') {
        // Selfhost 没有独立账户 recovery 凭据，不能把 recovery:true 当作身份认证。
        const input = parse(rotateSchema, body), publicKey = await csr(input.csr);
        return exclusive(input.deviceId, async () => {
          const previous = consume(input, 'rotate', publicKey.fingerprint);
          if (previous.fingerprint === publicKey.fingerprint) fail('IDENTITY_KEY_MISMATCH');
          const device: DeviceRecord = { ...previous, generation: previous.generation + 1, bindingId: randomUUID(), spki: publicKey.spki, jwk: publicKey.jwk, fingerprint: publicKey.fingerprint, thumbprint: publicKey.thumbprint, info: input.deviceInfo };
          await issueCertificate(device);
          db.prepare('INSERT OR REPLACE INTO identity_retired VALUES(?,?,?)').run(previous.deviceId, previous.generation, JSON.stringify({ ...previous, revoked: true }));
          db.prepare('DELETE FROM identity_sessions WHERE device=?').run(device.deviceId); persist(device); api.onRevoke?.(device.deviceId); return tokens(device);
        });
      }
      if (path === '/api/agent-network/revoke' || path === '/api/agent-network/revoke-state') {
        const input = parse(querySchema, body), query = path.endsWith('revoke-state');
        return exclusive(input.deviceId, async () => {
          const device = consume(input, query ? 'revoke-query' : 'revoke', input.keyFingerprint, query);
          if (!query) { device.revoked = true; persist(device); db.prepare('DELETE FROM identity_sessions WHERE device=?').run(device.deviceId); api.onRevoke?.(device.deviceId); }
          return { revoked: device.revoked };
        });
      }
      throw new HubError('NOT_FOUND', 404);
    },
  };
  return api;
}
