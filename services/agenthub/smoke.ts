import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto, X509Certificate as NodeCertificate } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { Duplex } from 'node:stream';
import { connect, TLSSocket, createSecureContext } from 'node:tls';
import { once } from 'node:events';
import WebSocket from 'ws';
import { SignJWT, decodeJwt } from 'jose';
import * as x509 from '@peculiar/x509';
import { NETWORK_SUBPROTOCOL, NETWORK_BUDGETS, clientControlSchema, serverControlSchema, encodeTlsFrame, decodeTlsFrame } from '@myagents/agent-network-protocol';

// 每次使用独立 CA、数据库与随机端口；绝不关闭证书校验。
const crypto = webcrypto as unknown as Crypto;
x509.cryptoProvider.set(crypto);
const root = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'agenthub-smoke-'));
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('base64url');
const deadline = <T>(promise: Promise<T>, label: string, ms = 12000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
type Data = Record<string, any>;
let child: ChildProcess | undefined;
const sockets = new Set<WebSocket>();
const tlsSockets = new Set<TLSSocket>();
let origin = '';
let serverCa = '';
const enrollmentKey = randomUUID();

async function json(method: string, path: string, body?: unknown, device?: Device, override?: string): Promise<Data> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-agenthub-key': enrollmentKey };
  if (device) { headers.authorization = `Bearer ${device.identity.accessToken}`; headers.dpop = override ?? await device.dpop(method, path); }
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return deadline(new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { method, headers, ca: serverCa, minVersion: 'TLSv1.3' }, res => {
      const buffers: Buffer[] = [];
      res.on('data', chunk => buffers.push(Buffer.from(chunk)));
      res.on('end', () => {
        try { const result = JSON.parse(Buffer.concat(buffers).toString()); resolve({ ...result, status: res.statusCode }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(encoded);
  }), `${method} ${path}`);
}
async function api(method: string, path: string, body?: unknown, device?: Device): Promise<Data> {
  const result = await json(method, path, body, device);
  assert.equal(result.success, true, `${method} ${path}: ${JSON.stringify(result)}`);
  return result.data;
}
async function start(): Promise<void> {
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/index.ts'], { cwd: root, env: { ...process.env,
    AGENTHUB_DATA_DIR: join(temporary, 'data'), AGENTHUB_ISSUER: origin, AGENTHUB_ENROLLMENT_KEY: enrollmentKey,
    AGENTHUB_TLS_KEY: join(temporary, 'https.key'), AGENTHUB_TLS_CERT: join(temporary, 'https.pem'),
    HOST: '127.0.0.1', PORT: new URL(origin).port }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  await deadline(new Promise<void>((resolve, reject) => {
    child!.stdout!.on('data', chunk => { output += chunk; if (output.includes(`AgentHub listening on ${origin}`)) resolve(); });
    child!.stderr!.on('data', chunk => { output += chunk; });
    child!.once('exit', code => reject(new Error(`Server exited ${code}: ${output}`)));
    child!.once('error', reject);
  }), 'server readiness');
}
async function stop(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  await deadline(exited, 'server shutdown'); child = undefined;
}
class Device {
  id = randomUUID(); identity: Data = {}; keys!: CryptoKeyPair; jwk!: JsonWebKey; csr = ''; key = ''; fingerprint = '';
  constructor(readonly name: string) {}
  async initialize() {
    this.keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as CryptoKeyPair;
    const exported = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    // DPoP proof headers deliberately carry only the public EC key members.
    // WebCrypto may add `ext`/`key_ops`, which the protocol rejects as ambiguity.
    const { kty, crv, x, y } = exported;
    this.jwk = { kty, crv, x, y };
    this.fingerprint = hash(Buffer.from(await crypto.subtle.exportKey('spki', this.keys.publicKey)));
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', this.keys.privateKey));
    this.key = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    this.csr = (await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${this.name}`, keys: this.keys, signingAlgorithm: algorithm })).toString('pem');
    this.identity = await api('POST', '/api/agent-network/identity', { deviceId: this.id, csr: this.csr, expectedKeyGeneration: null,
      deviceInfo: { deviceName: this.name, platform: 'smoke', osVersion: process.platform, appVersion: '1.2' } });
  }
  async dpop(method: string, path: string) {
    const url = new URL(path, origin); url.search = ''; url.hash = '';
    return new SignJWT({ jti: randomUUID(), iat: Math.floor(Date.now() / 1000), htm: method, htu: url.href, ath: hash(this.identity.accessToken) })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: this.jwk as any }).sign(this.keys.privateKey);
  }
  async proof(operation: string, target = this.fingerprint) {
    const challenge = await api('POST', '/api/agent-network/challenge', { deviceId: this.id, operation, targetFingerprint: target, expectedKeyGeneration: this.identity.keyGeneration });
    const message = Buffer.concat([Buffer.from(`NextTools Agent Network PoP v1\n${challenge.challengeId}\n`), Buffer.from(challenge.nonce, 'base64url')]);
    const proof = Buffer.from(await crypto.subtle.sign(algorithm, this.keys.privateKey, message)).toString('base64url');
    return { deviceId: this.id, expectedKeyGeneration: this.identity.keyGeneration, challengeId: challenge.challengeId, proof };
  }
}
class Peer {
  ws!: WebSocket; hello!: Data; controls: Data[] = []; wake: (() => void) | undefined;
  transports = new Map<string, Duplex>(); credits = new Map<string, { bytes: number; sequence: number }>();
  constructor(readonly device: Device) {}
  async open(previousConnection?: Data) {
    this.ws = new WebSocket(origin.replace('https:', 'wss:') + '/v1/ws', NETWORK_SUBPROTOCOL, {
      ca: serverCa, minVersion: 'TLSv1.3', headers: { authorization: `Bearer ${this.device.identity.accessToken}`, dpop: await this.device.dpop('GET', '/v1/ws') } });
    sockets.add(this.ws);
    this.ws.on('message', (raw, binary) => {
      const bytes = Buffer.from(raw as Buffer);
      if (binary) {
        const frame = decodeTlsFrame(bytes); const transport = this.transports.get(frame.channelId);
        assert.ok(transport, 'TLS channel must be installed before handshake'); transport.push(Buffer.from(frame.payload));
        const credit = this.credits.get(frame.channelId) ?? { bytes: 0, sequence: 0 }; credit.bytes += bytes.length; credit.sequence++;
        this.credits.set(frame.channelId, credit); this.send('credit.release', { channelId: frame.channelId, sequence: credit.sequence, receivedBytes: credit.bytes });
      } else { this.controls.push(serverControlSchema.parse(JSON.parse(bytes.toString()))); this.wake?.(); }
    });
    await deadline(once(this.ws, 'open'), 'WSS open'); assert.equal(this.ws.protocol, NETWORK_SUBPROTOCOL);
    this.send('hello', { clientVersion: 'agenthub-smoke', capabilities: ['tls13-mtls', 'typed-rpc', 'permit-v1', 'return-v1', 'return-resume-v1'], ...(previousConnection ? { previousConnection } : {}) });
    this.hello = await this.wait('hello.result');
    await api('PUT', '/v1/devices/self/catalog', { version: 1, connectionEpoch: this.hello.connectionEpoch, catalogSeq: 1,
      items: [{ localAgentId: 'smoke-agent', localWorkspaceId: 'smoke-workspace', name: this.device.name, path: '/private/smoke', lifecycle: 'active', exposureRevision: 1, icon: null }] }, this.device);
    this.send('ready', { catalogSeq: 1 }); await this.wait('ready.result');
  }
  send(type: string, fields: Data = {}) {
    const scope = type === 'hello' ? {} : { serviceId: this.hello.serviceId, networkId: this.hello.networkId, bootEpoch: this.hello.bootEpoch, connectionEpoch: this.hello.connectionEpoch };
    const control = clientControlSchema.parse({ version: 1, controlId: randomUUID(), ...scope, type, ...fields });
    this.ws.send(JSON.stringify(control)); return control.controlId;
  }
  async wait(type: string, predicate: (value: Data) => boolean = () => true): Promise<Data> {
    return deadline((async () => {
      for (;;) {
        const index = this.controls.findIndex(value => value.type === type && predicate(value));
        if (index >= 0) return this.controls.splice(index, 1)[0]!;
        const error = this.controls.find(value => value.type === 'error');
        if (type !== 'error' && error) throw new Error(`Relay error: ${JSON.stringify(error)}`);
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    })(), `control ${type}`);
  }
  transport(channelId: string): Duplex {
    const transport = new Duplex({ read() {}, write: (chunk: Buffer, _encoding, callback) => {
      for (let offset = 0; offset < chunk.length; offset += NETWORK_BUDGETS.tlsChunkBytes) {
        this.ws.send(encodeTlsFrame(channelId, chunk.subarray(offset, offset + NETWORK_BUDGETS.tlsChunkBytes)), { binary: true });
      }
      callback();
    } });
    this.transports.set(channelId, transport); return transport;
  }
  async close() { if (this.ws.readyState === WebSocket.CLOSED) return; const closed = once(this.ws, 'close'); this.ws.close(); await deadline(closed, 'WSS close'); sockets.delete(this.ws); }
}
async function channel(a: Peer, b: Peer, ca: string) {
  const channelId = randomUUID();
  a.send('channel.open', { channelId, targetDeviceId: b.device.id, targetKeyGeneration: b.device.identity.keyGeneration, targetConnectionEpoch: b.hello.connectionEpoch, targetBinding: b.device.identity.signedBinding });
  await Promise.all([a.wait('channel.offer'), b.wait('channel.offer')]);
  a.send('channel.accept', { channelId, signedBinding: a.device.identity.signedBinding }); b.send('channel.accept', { channelId, signedBinding: b.device.identity.signedBinding });
  await Promise.all([a.wait('channel.accepted'), b.wait('channel.accepted')]);
  const wireA = a.transport(channelId), wireB = b.transport(channelId);
  const credentials = (device: Device) => ({ cert: device.identity.certificate + '\n' + device.identity.certificateChain.join('\n'), key: device.key, ca, minVersion: 'TLSv1.3' as const, maxVersion: 'TLSv1.3' as const });
  const server = new TLSSocket(wireB, { isServer: true, secureContext: createSecureContext(credentials(b.device)), requestCert: true, rejectUnauthorized: true });
  const san = (decodeJwt(b.device.identity.signedBinding).binding as Data).san;
  const client = connect({ socket: wireA, ...credentials(a.device), servername: san, rejectUnauthorized: true });
  tlsSockets.add(server); tlsSockets.add(client);
  // 服务端 TLSSocket 不经 tls.Server，需显式确认链校验结果及证书指纹。
  await deadline(Promise.all([once(client, 'secureConnect'), once(server, 'secure')]), 'TLS 1.3 mutual handshake');
  assert.equal(client.authorized, true); assert.equal(server.getProtocol(), 'TLSv1.3');
  assert.equal(server.getPeerCertificate().fingerprint256, new NodeCertificate(a.device.identity.certificate).fingerprint256);
  assert.equal(client.getPeerCertificate().fingerprint256, new NodeCertificate(b.device.identity.certificate).fingerprint256);
  a.send('channel.ready', { channelId }); b.send('channel.ready', { channelId });
  await Promise.all([a.wait('channel.ready'), b.wait('channel.ready')]);
  const received = once(server, 'data'); client.write('encrypted-request'); assert.equal((await deadline(received, 'TLS request'))[0].toString(), 'encrypted-request');
  const response = once(client, 'data'); server.write('encrypted-response'); assert.equal((await deadline(response, 'TLS response'))[0].toString(), 'encrypted-response');
  await Promise.all([a.wait('credit.available'), b.wait('credit.available')]);
  return channelId;
}

try {
  const portProbe = createTcpServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = (portProbe.address() as { port: number }).port; await new Promise<void>(resolve => portProbe.close(() => resolve())); origin = `https://127.0.0.1:${port}`;
  const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({ name: 'CN=AgentHub smoke HTTPS', keys, signingAlgorithm: algorithm,
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 86400000),
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true), new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: '127.0.0.1' }])] });
  serverCa = cert.toString('pem');
  const key = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  await writeFile(join(temporary, 'https.key'), `-----BEGIN PRIVATE KEY-----\n${key.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
  await writeFile(join(temporary, 'https.pem'), serverCa);
  await start();
  const descriptor = await api('GET', '/api/agent-network/descriptor');
  await assert.rejects(new Promise((resolve, reject) => { const req = request(origin + '/api/agent-network/descriptor', resolve); req.on('error', reject); req.end(); }), /certificate|self.signed/i);
  const a = new Device('smoke-A'), b = new Device('smoke-B'); await a.initialize(); await b.initialize();
  const proof = { ...await a.proof('recover-query'), keyFingerprint: a.fingerprint };
  a.identity = await api('POST', '/api/agent-network/identity/current', proof);
  assert.equal((await json('POST', '/api/agent-network/identity/current', proof)).code, 'NETWORK_PROOF_INVALID');
  const replay = await a.dpop('GET', '/v1/devices'); const firstReplayResponse = await json('GET', '/v1/devices', undefined, a, replay); assert.equal(firstReplayResponse.success, true, JSON.stringify(firstReplayResponse));
  assert.equal((await json('GET', '/v1/devices', undefined, a, replay)).code, 'NETWORK_DPOP_INVALID');
  assert.equal((await json('GET', '/v1/devices', undefined, a, 'invalid')).code, 'NETWORK_DPOP_INVALID');
  let pa = new Peer(a); const pb = new Peer(b); await pa.open(); await pb.open();
  const network = `/v1/networks/${descriptor.networkId}`;
  const joinInput = { expectedMembershipRevision: 0, mutationId: randomUUID() };
  const joined = await api('POST', `${network}/devices/${b.id}/join`, joinInput, a);
  assert.deepEqual(await api('POST', `${network}/devices/${b.id}/join`, joinInput, a), joined);
  assert.deepEqual(await api('GET', `/v1/mutations/${joinInput.mutationId}`, undefined, a), joined);
  assert.equal((await json('POST', `${network}/devices/${b.id}/join`, { ...joinInput, mutationId: randomUUID() }, a)).code, 'MEMBERSHIP_REVISION_CONFLICT');
  const mount = (await api('GET', `/v1/devices/${b.id}/agents`, undefined, a)).items[0]; assert.ok(mount);
  const enabled = await api('PATCH', `${network}/mounts/${mount.mountId}`, { enabled: true, expectedEnableRevision: mount.enableRevision, expectedMembershipRevision: joined.membershipRevision, mutationId: randomUUID() }, a);
  await api('PATCH', `${network}/mounts/${mount.mountId}`, { description: 'smoke persistent description', expectedDescriptionRevision: 0, expectedMembershipRevision: joined.membershipRevision, mutationId: randomUUID() }, a);
  await api('PATCH', `${network}/devices/${b.id}/name`, { name: 'smoke-renamed', expectedName: 'smoke-B', mutationId: randomUUID() }, a);
  const callable = await api('GET', `${network}/callable-agents/${mount.mountId}`, undefined, a); assert.equal(callable.deviceName, 'smoke-renamed'); assert.equal(callable.path, undefined);
  assert.ok((await api('GET', `${network}/callable-agents`, undefined, a)).items.some((entry: Data) => entry.mountId === mount.mountId));
  const channelId = await channel(pa, pb, descriptor.rootCertificate);
  const opId = randomUUID(); pa.send('op.prepare', { channelId, opId, targetMountId: mount.mountId }); await pa.wait('op.prepared');
  pb.send('permit.acquire', { opId, attemptId: randomUUID(), targetMountId: mount.mountId, expectedMembershipRevision: 0, expectedEnableRevision: enabled.enableRevision });
  assert.equal((await pb.wait('error')).code, 'REVISION_CONFLICT');
  pb.send('permit.acquire', { opId, attemptId: randomUUID(), targetMountId: mount.mountId, expectedMembershipRevision: joined.membershipRevision, expectedEnableRevision: enabled.enableRevision });
  const permit = await pb.wait('permit.result'); const route = await pa.wait('route.opened'); assert.equal(permit.returnRouteId, route.returnRouteId);
  const previousConnection = { connectionEpoch: pa.hello.connectionEpoch, connectorNonce: pa.hello.connectorNonce };
  await pa.close(); await pb.wait('route.suspended'); pa = new Peer(a); await pa.open(previousConnection);
  pa.send('route.resume', { returnRouteId: route.returnRouteId }); await Promise.all([pa.wait('route.resumed'), pb.wait('route.resumed')]);
  const reboundChannel = await channel(pa, pb, descriptor.rootCertificate);
  pb.send('route.rebind', { returnRouteId: route.returnRouteId, channelId: reboundChannel }); await pb.wait('route.rebound');
  pb.send('route.close', { returnRouteId: route.returnRouteId, reason: 'smoke-complete' }); await Promise.all([pa.wait('route.closed'), pb.wait('route.closed')]);
  await pa.close(); await pb.close();
  for (const socket of tlsSockets) socket.destroy(); tlsSockets.clear();
  await stop(); await start();
  assert.equal((await api('GET', `/api/agent-network/identity/state?deviceId=${a.id}`)).keyFingerprint, a.fingerprint);
  assert.equal((await api('GET', `${network}/devices/${b.id}/name`, undefined, a)).name, 'smoke-renamed');
  const persisted = (await api('GET', `/v1/devices/${b.id}/agents`, undefined, a)).items[0]; assert.equal(persisted.enabled, true); assert.equal(persisted.description, 'smoke persistent description');
  assert.equal((await api('GET', '/v1/devices', undefined, a)).items.find((entry: Data) => entry.deviceId === b.id).joined, true);
  assert.deepEqual(await api('GET', `/v1/mutations/${joinInput.mutationId}`, undefined, a), joined);
  console.log('AgentHub smoke PASS: verified HTTPS/WSS, two identities, PoP/DPoP replay rejection, catalog/CAS/receipts, callable metadata, TLS1.3 mTLS encrypted bidirectional relay, credit, permits, route recovery/rebind/close, restart persistence.');
} finally {
  for (const socket of tlsSockets) socket.destroy();
  for (const socket of sockets) socket.terminate();
  await stop(); await rm(temporary, { recursive: true, force: true });
}
