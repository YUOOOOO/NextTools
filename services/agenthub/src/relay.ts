import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { clientControlSchema, serverControlSchema, decodeTlsFrame, NETWORK_BUDGETS as B, NETWORK_SUBPROTOCOL, type ClientControl } from '@myagents/agent-network-protocol';
import { HubError, type AuthContext, type HubConfig, type IdentityApi, type MetadataApi } from './types.js';

type Control = ClientControl;
type Flow = { sent: number; released: number; sequence: number; blockedAt?: number };
type Peer = {
  ws: WebSocket; auth: AuthContext; epoch: string; nonce: string; hello: boolean; ready: boolean;
  recovery: boolean; ancestry: Set<string>; created: number; lastSeen: number; busy: boolean;
  inbox: Array<{ data: Buffer; binary: boolean }>; inboxBytes: number;
  controls: Map<string, number>; pingAt: number; rateAt: number; rateCount: number; closed: boolean;
};
type Channel = {
  id: string; a: Peer; b: Peer; accepted: Set<Peer>; ready: Set<Peer>;
  bindings: Map<Peer, string>; flows: Map<Peer, Flow>; created: number; activity: number;
};
type Prepared = {
  id: string; source: Peer; target: Peer; channel: Channel; mount: string; created: number;
  admitted: boolean; admittedAt?: number; attempts: Set<string>;
};
type Route = {
  id: string; op: string; source: AuthContext; target: AuthContext; sourceEpoch: string;
  targetEpoch: string; mount: string; recoverable: boolean; suspendedUntil?: number;
};
type Previous = { nonce: string; auth: AuthContext; ancestry: Set<string>; until: number };

// 路由恢复只能延续原认证主体，不能通过续签令牌换会话、密钥或证书。
function sameOwner(a: AuthContext, b: AuthContext): boolean {
  return sameScope(a, b) && a.scope.deviceId === b.scope.deviceId && a.scope.keyGeneration === b.scope.keyGeneration
    && a.sessionHandle === b.sessionHandle && a.keyFingerprint === b.keyFingerprint
    && a.certificateFingerprint === b.certificateFingerprint;
}
function sameScope(a: AuthContext, b: AuthContext): boolean {
  const x = a.scope; const y = b.scope;
  return x.serviceId === y.serviceId && x.networkId === y.networkId
    && x.environment === y.environment && x.principalId === y.principalId;
}
function fail(code: string): never { throw new HubError(code); }

export function createRelay(config: HubConfig, identity: IdentityApi, metadata: MetadataApi) {
  const bootEpoch = randomUUID();
  const peers = new Set<Peer>();
  const current = new Map<string, Peer>();
  const channels = new Map<string, Channel>();
  const prepared = new Map<string, Prepared>();
  const routes = new Map<string, Route>();
  const previous = new Map<string, Previous>();
  const retiredOps = new Map<string, number>();
  let stopping = false;
  let presenceRevision = 0;
  let pendingUpgrades = 0;
  const wss = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: B.controlBytes + 22,
    handleProtocols(protocols) { return protocols.has(NETWORK_SUBPROTOCOL) ? NETWORK_SUBPROTOCOL : false; },
  });
  const scope = (p: Peer) => ({ serviceId: config.serviceId, networkId: config.networkId, bootEpoch, connectionEpoch: p.epoch });
  const online = (auth: AuthContext): Peer | undefined => {
    const p = current.get(auth.scope.deviceId);
    return p && p.hello && p.ready && !p.closed && sameOwner(auth, p.auth) ? p : undefined;
  };
  // 保守统计驻留控制元数据，包括证书绑定字符串；密文由独立字节信用限制。
  function metadataBytes(): number {
    let size = prepared.size * 512 + retiredOps.size * 128 + routes.size * 1024;
    for (const p of peers) size += 1024 + p.controls.size * 128 + Buffer.byteLength(p.auth.signedBinding) + p.ancestry.size * 64;
    for (const c of channels.values()) {
      size += 1024;
      for (const token of c.bindings.values()) size += Buffer.byteLength(token);
    }
    for (const r of routes.values()) size += Buffer.byteLength(r.source.signedBinding) + Buffer.byteLength(r.target.signedBinding);
    for (const old of previous.values()) size += 512 + Buffer.byteLength(old.auth.signedBinding) + old.ancestry.size * 64;
    return size;
  }
  function send(p: Peer, message: Record<string, unknown>, controlId: string = randomUUID()): void {
    if (p.closed || p.ws.readyState !== WebSocket.OPEN) return;
    // 所有出站控制消息都使用协议包校验，避免服务端悄悄发送客户端无法解析的形状。
    const envelope = serverControlSchema.parse({ version: 1, controlId, ...scope(p), ...message });
    const text = JSON.stringify(envelope);
    let queued = Buffer.byteLength(text);
    for (const peer of peers) queued += peer.inboxBytes + peer.ws.bufferedAmount;
    if (queued > B.relayQueueBytes) { disconnect(p, 'NETWORK_BACKPRESSURE'); return; }
    if (Buffer.byteLength(text) > B.controlBytes || p.ws.bufferedAmount + Buffer.byteLength(text) > B.socketQueueBytes) {
      disconnect(p, 'NETWORK_BACKPRESSURE'); return;
    }
    p.ws.send(text, error => { if (error) disconnect(p, 'NETWORK_CONNECTION_CLOSED'); });
  }
  function error(p: Peer, code: string, controlId: string = randomUUID()): void {
    if (p.closed || p.ws.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(serverControlSchema.parse({ version: 1, controlId, type: 'error', code, retryable: ['TARGET_OFFLINE', 'NETWORK_REQUEST_CAPACITY'].includes(code) }));
    let queued = Buffer.byteLength(text);
    for (const peer of peers) queued += peer.inboxBytes + peer.ws.bufferedAmount;
    if (queued > B.relayQueueBytes) { disconnect(p, 'NETWORK_BACKPRESSURE'); return; }
    if (p.ws.bufferedAmount + Buffer.byteLength(text) > B.socketQueueBytes) { disconnect(p, 'NETWORK_BACKPRESSURE'); return; }
    p.ws.send(text, cause => { if (cause) disconnect(p, 'NETWORK_CONNECTION_CLOSED'); });
  }
  function changed(kind: 'settings' | 'catalog' | 'presence' | 'roster', revision: number): void {
    for (const p of peers) if (p.hello) send(p, { type: 'change.available', scope: kind, revision });
  }
  function presenceChanged(): void { changed('presence', ++presenceRevision); }
  function closeRoute(r: Route, reason: string, caller?: Peer, controlId?: string): void {
    if (!routes.delete(r.id)) return;
    for (const p of peers) if (p.hello && (sameOwner(r.source, p.auth) || sameOwner(r.target, p.auth))) {
      send(p, { type: 'route.closed', returnRouteId: r.id, reason }, p === caller ? controlId : undefined);
    }
  }
  function closeChannel(c: Channel, reason: string): void {
    if (!channels.delete(c.id)) return;
    for (const p of [c.a, c.b]) send(p, { type: 'channel.closed', channelId: c.id, reason });
    for (const [id, op] of prepared) if (op.channel === c) { prepared.delete(id); retiredOps.set(id, Date.now() + B.receiptMs); }
  }
  function suspend(r: Route): void {
    if (!r.recoverable) { closeRoute(r, 'RETURN_RESUME_UNSUPPORTED'); return; }
    // 首次离线确定截止时间；对端离线和恢复重试永远不能往后顺延。
    r.suspendedUntil ??= Date.now() + B.returnRecoveryMs;
    const remainingMs = Math.max(0, r.suspendedUntil - Date.now());
    for (const p of peers) if (p.hello && (sameOwner(r.source, p.auth) || sameOwner(r.target, p.auth))) {
      send(p, { type: 'route.suspended', returnRouteId: r.id, remainingMs });
    }
  }
  function disconnect(p: Peer, reason: string): void {
    if (p.closed) return;
    p.closed = true; peers.delete(p);
    if (current.get(p.auth.scope.deviceId) === p) current.delete(p.auth.scope.deviceId);
    if (p.hello && previous.size < 4096 && metadataBytes() + 512 + Buffer.byteLength(p.auth.signedBinding) < B.relayMetadataBytes) previous.set(p.epoch, {
      nonce: p.nonce, auth: p.auth, ancestry: p.ancestry, until: Date.now() + B.returnRecoveryMs,
    });
    for (const c of channels.values()) if (c.a === p || c.b === p) closeChannel(c, reason);
    for (const r of routes.values()) if (r.sourceEpoch === p.epoch || r.targetEpoch === p.epoch) suspend(r);
    p.inbox.length = 0; p.inboxBytes = 0; p.ws.terminate();
    if (p.hello) presenceChanged();
  }
  function channelFor(p: Peer, id: string): Channel {
    const c = channels.get(id);
    if (!c || (c.a !== p && c.b !== p)) fail('CHANNEL_NOT_FOUND');
    return c;
  }
  function routeFor(p: Peer, id: string): Route {
    const r = routes.get(id);
    if (!r || (!sameOwner(r.source, p.auth) && !sameOwner(r.target, p.auth))) fail('RETURN_ROUTE_NOT_FOUND');
    if (r.suspendedUntil !== undefined && r.suspendedUntil <= Date.now()) { closeRoute(r, 'RETURN_RECOVERY_EXPIRED'); fail('RETURN_RECOVERY_EXPIRED'); }
    return r;
  }
  function limitChannels(p: Peer): void {
    const owned = [...channels.values()].filter(c => c.a === p || c.b === p);
    if (owned.length >= B.channels || owned.filter(c => c.ready.size !== 2).length >= B.handshakes) fail('NETWORK_CHANNEL_CAPACITY');
  }
  async function binding(p: Peer, token: string): Promise<void> {
    const value = await identity.verifyBinding(token) as { serviceId: string; environment: string; principalId: string; deviceId: string; keyGeneration: number; certificateFingerprint: string };
    const s = p.auth.scope;
    if (value.serviceId !== s.serviceId || value.environment !== s.environment || value.principalId !== s.principalId
      || value.deviceId !== s.deviceId || value.keyGeneration !== s.keyGeneration
      || value.certificateFingerprint !== p.auth.certificateFingerprint) fail('CHANNEL_SCOPE_MISMATCH');
  }
  function routeCount(auth: AuthContext): number {
    let n = 0; for (const r of routes.values()) if (sameOwner(r.source, auth) || sameOwner(r.target, auth)) n++;
    return n;
  }
  function resume(r: Route, p: Peer, controlId: string): void {
    const source = sameOwner(r.source, p.auth);
    const oldEpoch = source ? r.sourceEpoch : r.targetEpoch;
    if (oldEpoch !== p.epoch && !p.ancestry.has(oldEpoch)) fail('RETURN_IDENTITY_CHANGED');
    if (source) r.sourceEpoch = p.epoch; else r.targetEpoch = p.epoch;
    const a = online(r.source); const b = online(r.target);
    if (!a || !b || a.epoch !== r.sourceEpoch || b.epoch !== r.targetEpoch) {
      suspend(r); return;
    }
    r.suspendedUntil = undefined;
    for (const peer of [a, b]) send(peer, { type: 'route.resumed', returnRouteId: r.id,
      sourceConnectionEpoch: r.sourceEpoch, targetConnectionEpoch: r.targetEpoch }, peer === p ? controlId : undefined);
  }
  async function control(p: Peer, m: Control): Promise<void> {
    if (m.type === 'hello') {
      if (p.hello) fail('CONTROL_UNEXPECTED');
      if (!['tls13-mtls', 'typed-rpc', 'permit-v1', 'return-v1'].every(cap => m.capabilities.includes(cap as typeof m.capabilities[number]))) fail('CAPABILITY_NOT_SUPPORTED');
      if (m.previousConnection) {
        const oldPeer = [...peers].find(peer => peer !== p && peer.epoch === m.previousConnection!.connectionEpoch && peer.hello);
        const old = previous.get(m.previousConnection.connectionEpoch) ?? (oldPeer ? {
          nonce: oldPeer.nonce, auth: oldPeer.auth, ancestry: oldPeer.ancestry, until: Date.now() + B.returnRecoveryMs,
        } : undefined);
        // 服务重启或恢复窗口已过时仍允许新连接；失去的旧路由绝不能因此重新创建。
        if (old && old.until > Date.now()) {
          if (old.nonce !== m.previousConnection.connectorNonce) fail('RETURN_IDENTITY_CHANGED');
          if (sameOwner(old.auth, p.auth)) {
            const relevant = new Set<string>();
            for (const r of routes.values()) { relevant.add(r.sourceEpoch); relevant.add(r.targetEpoch); }
            p.ancestry = new Set([...old.ancestry].filter(epoch => relevant.has(epoch)));
            p.ancestry.add(m.previousConnection.connectionEpoch);
          }
          previous.delete(m.previousConnection.connectionEpoch);
        }
      }
      const existing = current.get(p.auth.scope.deviceId);
      if (existing && existing !== p) disconnect(existing, 'CONNECTION_REPLACED');
      current.set(p.auth.scope.deviceId, p); p.hello = true;
      p.recovery = m.capabilities.includes('return-resume-v1');
      send(p, { type: 'hello.result', identity: p.auth.scope, connectorNonce: p.nonce,
        networkRevision: presenceRevision, membershipRevision: metadata.membershipRevision(p.auth.scope.deviceId) }, m.controlId);
      presenceChanged(); return;
    }
    if (!p.hello) fail('HELLO_REQUIRED');
    if (m.serviceId !== config.serviceId || m.networkId !== config.networkId || m.bootEpoch !== bootEpoch || m.connectionEpoch !== p.epoch) fail('CONTROL_SCOPE_MISMATCH');
    if (m.type === 'auth.refresh') {
      const auth = await identity.verifyAccess(m.accessToken);
      if (p.closed) return;
      if (!sameOwner(p.auth, auth)) fail('ACCOUNT_BINDING_CHANGED');
      p.auth = auth; send(p, { type: 'auth.refreshed', expiresAt: auth.expiresAt }, m.controlId); return;
    }
    if (m.type === 'ready') {
      if (metadata.catalogSeq(p.auth.scope.deviceId, p.epoch) !== m.catalogSeq) fail('CATALOG_NOT_CURRENT');
      p.ready = true; send(p, { type: 'ready.result', catalogSeq: m.catalogSeq }, m.controlId); presenceChanged(); return;
    }
    if (!p.ready) fail('CONNECTION_NOT_READY');
    switch (m.type) {
      case 'channel.open': {
        if (channels.has(m.channelId)) fail('CHANNEL_ID_REUSED');
        const target = current.get(m.targetDeviceId);
        if (!target?.ready || target.closed || target === p) fail('TARGET_OFFLINE');
        if (!sameScope(p.auth, target.auth) || target.epoch !== m.targetConnectionEpoch || target.auth.scope.keyGeneration !== m.targetKeyGeneration) fail('CHANNEL_SCOPE_MISMATCH');
        limitChannels(p); limitChannels(target);
        if (channels.size >= 1024) fail('NETWORK_CHANNEL_CAPACITY');
        if (m.targetBinding) await binding(target, m.targetBinding);
        if (p.closed || target.closed || current.get(target.auth.scope.deviceId) !== target) fail('TARGET_OFFLINE');
        if (channels.has(m.channelId)) fail('CHANNEL_ID_REUSED');
        limitChannels(p); limitChannels(target);
        if (metadataBytes() + 1024 > B.relayMetadataBytes) fail('NETWORK_CHANNEL_CAPACITY');
        const c: Channel = { id: m.channelId, a: p, b: target, accepted: new Set(), ready: new Set(), bindings: new Map(),
          flows: new Map([[p, { sent: 0, released: 0, sequence: 0 }], [target, { sent: 0, released: 0, sequence: 0 }]]), created: Date.now(), activity: Date.now() };
        channels.set(c.id, c);
        for (const peer of [p, target]) send(peer, { type: 'channel.offer', channelId: c.id,
          initiator: p.auth.scope, responder: target.auth.scope, initiatorConnectionEpoch: p.epoch,
          responderConnectionEpoch: target.epoch, initiatorBinding: p.auth.signedBinding || null,
          responderBinding: m.targetBinding || target.auth.signedBinding || null }, peer === p ? m.controlId : undefined);
        return;
      }
      case 'channel.accept': {
        const c = channelFor(p, m.channelId);
        if (c.accepted.has(p)) fail('CONTROL_UNEXPECTED');
        await binding(p, m.signedBinding);
        if (!channels.has(c.id) || c.a.closed || c.b.closed) fail('CHANNEL_NOT_FOUND');
        if (metadataBytes() + Buffer.byteLength(m.signedBinding) > B.relayMetadataBytes) fail('NETWORK_CHANNEL_CAPACITY');
        c.accepted.add(p); c.bindings.set(p, m.signedBinding);
        if (c.accepted.size === 2) for (const peer of [c.a, c.b]) send(peer, { type: 'channel.accepted', channelId: c.id,
          initiatorBinding: c.bindings.get(c.a)!, responderBinding: c.bindings.get(c.b)! });
        return;
      }
      case 'channel.ready': {
        const c = channelFor(p, m.channelId);
        if (c.accepted.size !== 2 || c.ready.has(p)) fail('CONTROL_UNEXPECTED');
        c.ready.add(p); c.activity = Date.now();
        if (c.ready.size === 2) for (const peer of [c.a, c.b]) send(peer, { type: 'channel.ready', channelId: c.id });
        return;
      }
      case 'channel.close': closeChannel(channelFor(p, m.channelId), m.reason); return;
      case 'credit.release': {
        const c = channelFor(p, m.channelId); const sender = c.a === p ? c.b : c.a; const flow = c.flows.get(sender)!;
        if (m.sequence !== flow.sequence + 1 || m.receivedBytes <= flow.released || m.receivedBytes > flow.sent) fail('CREDIT_INVALID');
        flow.sequence = m.sequence; flow.released = m.receivedBytes;
        flow.blockedAt = flow.sent > flow.released ? Date.now() : undefined;
        send(sender, { type: 'credit.available', channelId: c.id, sequence: m.sequence, receivedBytes: m.receivedBytes }); return;
      }
      case 'op.prepare': {
        if (prepared.has(m.opId) || retiredOps.has(m.opId)) fail('OP_ID_REUSED');
        const c = channelFor(p, m.channelId); if (c.ready.size !== 2) fail('CHANNEL_NOT_READY');
        const target = c.a === p ? c.b : c.a;
        const mount = metadata.resolveMount(m.targetMountId);
        if (mount.deviceId !== target.auth.scope.deviceId || !online(target.auth)) fail('AGENT_NOT_AVAILABLE');
        if (prepared.size + retiredOps.size >= 8192 || metadataBytes() + 512 > B.relayMetadataBytes
          || [...prepared.values()].filter(op => op.source === p || op.target === p).length >= B.pending) fail('NETWORK_REQUEST_CAPACITY');
        prepared.set(m.opId, { id: m.opId, source: p, target, channel: c, mount: m.targetMountId, created: Date.now(), admitted: false, attempts: new Set() });
        send(p, { type: 'op.prepared', opId: m.opId, targetMountId: m.targetMountId,
          target: target.auth.scope, targetConnectionEpoch: target.epoch }, m.controlId); return;
      }
      case 'op.release': {
        const op = prepared.get(m.opId);
        if (op && op.source !== p) fail('OP_SCOPE_MISMATCH');
        if (op) { prepared.delete(m.opId); retiredOps.set(m.opId, Date.now() + B.receiptMs); } return;
      }
      case 'permit.acquire': {
        const op = prepared.get(m.opId);
        if (!op || op.target !== p || op.mount !== m.targetMountId || op.target.epoch !== p.epoch
          || !online(op.source.auth) || current.get(op.source.auth.scope.deviceId) !== op.source || op.channel.ready.size !== 2) fail('OP_SCOPE_MISMATCH');
        if (op.admitted) fail('PERMIT_ALREADY_CONSUMED');
        if (op.attempts.has(m.attemptId) || op.attempts.size >= B.permitAttempts) fail('PERMIT_ALREADY_CONSUMED');
        op.attempts.add(m.attemptId);
        const mount = metadata.resolveMount(op.mount);
        if (mount.deviceId !== p.auth.scope.deviceId || mount.membershipRevision !== m.expectedMembershipRevision
          || mount.enableRevision !== m.expectedEnableRevision) fail('REVISION_CONFLICT');
        if ([...prepared.values()].filter(item => item.target === p && item.admittedAt !== undefined && Date.now() - item.admittedAt < B.permitMs).length >= B.permits) fail('NETWORK_REQUEST_CAPACITY');
        if (routes.size >= 4096 || routeCount(p.auth) >= B.returns || routeCount(op.source.auth) >= B.returns
          || metadataBytes() + 1024 + Buffer.byteLength(p.auth.signedBinding) + Buffer.byteLength(op.source.auth.signedBinding) > B.relayMetadataBytes) fail('NETWORK_RETURN_CAPACITY');
        const recoverable = op.source.recovery && p.recovery;
        const r: Route = { id: randomUUID(), op: op.id, source: { ...op.source.auth }, target: { ...p.auth },
          sourceEpoch: op.source.epoch, targetEpoch: p.epoch, mount: op.mount, recoverable };
        // 检查和写入之间没有 await：CAS 校验、一次性准入、路由注册属于同一事件循环事务。
        op.admitted = true; op.admittedAt = Date.now(); routes.set(r.id, r);
        const common = { opId: op.id, returnRouteId: r.id, source: r.source.scope, target: r.target.scope,
          sourceConnectionEpoch: r.sourceEpoch, targetConnectionEpoch: r.targetEpoch, targetMountId: r.mount,
          ...(recoverable ? { recoverable: true } : {}) };
        send(op.source, { type: 'route.opened', ...common });
        send(p, { type: 'permit.result', ...common, attemptId: m.attemptId, permitId: randomUUID(),
          membershipRevision: mount.membershipRevision, enableRevision: mount.enableRevision, freshnessMs: B.permitMs }, m.controlId);
        return;
      }
      case 'route.resume': resume(routeFor(p, m.returnRouteId), p, m.controlId); return;
      case 'route.rebind': {
        const r = routeFor(p, m.returnRouteId); const c = channelFor(p, m.channelId);
        if (!sameOwner(r.target, p.auth) || r.suspendedUntil !== undefined || c.ready.size !== 2
          || ![c.a, c.b].some(peer => peer.epoch === r.sourceEpoch && sameOwner(r.source, peer.auth))
          || ![c.a, c.b].some(peer => peer.epoch === r.targetEpoch && sameOwner(r.target, peer.auth))) fail('RETURN_ROUTE_SCOPE_MISMATCH');
        send(p, { type: 'route.rebound', returnRouteId: r.id, channelId: c.id }, m.controlId); return;
      }
      case 'route.close': {
        const r = routes.get(m.returnRouteId);
        if (!r) { send(p, { type: 'route.closed', returnRouteId: m.returnRouteId, reason: m.reason }, m.controlId); return; }
        routeFor(p, m.returnRouteId); closeRoute(r, m.reason, p, m.controlId); return;
      }
    }
  }
  function binary(p: Peer, frame: Buffer): void {
    if (!p.ready) fail('CONNECTION_NOT_READY');
    const { channelId } = decodeTlsFrame(frame); const c = channelFor(p, channelId);
    if (c.accepted.size !== 2) fail('CHANNEL_NOT_ACCEPTED');
    const target = c.a === p ? c.b : c.a; const flow = c.flows.get(p)!;
    let deviceBytes = 0; let relayBytes = 0;
    for (const channel of channels.values()) for (const [sender, f] of channel.flows) {
      relayBytes += f.sent - f.released; if (sender === p) deviceBytes += f.sent - f.released;
    }
    if (flow.sent + frame.length > Number.MAX_SAFE_INTEGER || flow.sent - flow.released + frame.length > B.channelQueueBytes
      || deviceBytes + frame.length > B.socketQueueBytes || relayBytes + frame.length > B.relayQueueBytes) fail('NETWORK_BACKPRESSURE');
    if (target.closed || target.ws.readyState !== WebSocket.OPEN || target.ws.bufferedAmount + frame.length > B.socketQueueBytes) {
      closeChannel(c, 'NETWORK_BACKPRESSURE'); return;
    }
    flow.sent += frame.length; flow.blockedAt ??= Date.now(); c.activity = Date.now();
    // 不解析 TLS 内容、不落盘、不缓存离线密文。字节信用包含原始的 22 字节帧头。
    target.ws.send(frame, { binary: true }, cause => { if (cause) disconnect(target, 'NETWORK_CONNECTION_CLOSED'); });
  }
  async function drain(p: Peer): Promise<void> {
    if (p.busy) return;
    p.busy = true;
    try {
      while (!p.closed && p.inbox.length) {
        const item = p.inbox.shift()!; p.inboxBytes -= item.data.length;
        let controlId: string | undefined;
        try {
          if (p.auth.expiresAt * 1000 <= Date.now()) fail('AUTH_EXPIRED');
          if (item.binary) { binary(p, item.data); continue; }
          if (item.data.length > B.controlBytes) fail('CONTROL_TOO_LARGE');
          const text = item.data.toString('utf8');
          if (text === 'ma-network-ping') {
            if (p.ws.bufferedAmount > B.socketQueueBytes - 32) fail('NETWORK_BACKPRESSURE');
            p.ws.send('ma-network-pong'); continue;
          }
          const m = clientControlSchema.parse(JSON.parse(text)); controlId = m.controlId;
          if (p.controls.has(controlId)) fail('CONTROL_ID_REUSED');
          if (p.controls.size >= B.receipts) p.controls.delete(p.controls.keys().next().value!);
          if (metadataBytes() + 128 > B.relayMetadataBytes) fail('NETWORK_REQUEST_CAPACITY');
          p.controls.set(controlId, Date.now() + B.receiptMs);
          await control(p, m);
        } catch (cause) {
          error(p, cause instanceof HubError ? cause.code : 'CONTROL_INVALID', controlId);
          if (!controlId) disconnect(p, 'CONTROL_INVALID');
        }
      }
    } finally { p.busy = false; }
  }
  const tick = setInterval(() => {
    const now = Date.now();
    for (const p of peers) {
      if (p.auth.expiresAt * 1000 <= now || now - p.lastSeen >= B.offlineMs || (!p.hello && now - p.created >= B.helloMs)) {
        disconnect(p, 'CONNECTION_EXPIRED'); continue;
      }
      for (const [id, until] of p.controls) if (until <= now) p.controls.delete(id);
      if (p.ws.readyState === WebSocket.OPEN && now - p.pingAt >= B.pingMs) {
        p.ws.ping(); p.pingAt = now;
      }
    }
    for (const c of channels.values()) {
      if (c.ready.size !== 2 && now - c.created >= B.handshakeMs) closeChannel(c, 'CHANNEL_HANDSHAKE_TIMEOUT');
      else if (now - c.activity >= B.idleChannelMs) closeChannel(c, 'CHANNEL_IDLE_TIMEOUT');
      else if ([...c.flows.values()].some(f => f.blockedAt !== undefined && now - f.blockedAt >= B.backpressureMs && f.sent > f.released)) closeChannel(c, 'NETWORK_BACKPRESSURE');
    }
    for (const [id, op] of prepared) if (now - op.created >= 225_000) { prepared.delete(id); retiredOps.set(id, now + B.receiptMs); }
    for (const r of routes.values()) if (r.suspendedUntil !== undefined && r.suspendedUntil <= now) closeRoute(r, 'RETURN_RECOVERY_EXPIRED');
    for (const [epoch, old] of previous) if (old.until <= now) previous.delete(epoch);
    for (const [id, until] of retiredOps) if (until <= now) retiredOps.delete(id);
  }, 1000);
  tick.unref();
  metadata.setPresenceProvider(deviceId => {
    const p = current.get(deviceId);
    return p && !p.closed && p.hello ? { auth: p.auth, connectionEpoch: p.epoch, ready: p.ready } : undefined;
  });
  metadata.onChange = changed;
  const priorRevoke = identity.onRevoke;
  const onRevoke = (deviceId: string) => {
    priorRevoke?.(deviceId);
    for (const r of routes.values()) if (r.source.scope.deviceId === deviceId || r.target.scope.deviceId === deviceId) closeRoute(r, 'IDENTITY_REVOKED');
    for (const p of peers) if (p.auth.scope.deviceId === deviceId) disconnect(p, 'IDENTITY_REVOKED');
    for (const [epoch, old] of previous) if (old.auth.scope.deviceId === deviceId) previous.delete(epoch);
  };
  identity.onRevoke = onRevoke;
  return {
    async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
      let reserved = false;
      try {
        if (stopping || peers.size >= 256) throw new HubError('NETWORK_REQUEST_CAPACITY', 503);
        if (pendingUpgrades >= B.permits) throw new HubError('NETWORK_REQUEST_CAPACITY', 503);
        pendingUpgrades++; reserved = true;
        const requested = (request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim());
        if (!requested.includes(NETWORK_SUBPROTOCOL)) throw new HubError('SUBPROTOCOL_REQUIRED', 400);
        const auth = await identity.authenticate(request);
        if (stopping || peers.size >= 256 || socket.destroyed) throw new HubError('NETWORK_REQUEST_CAPACITY', 503);
        if (metadataBytes() + 1024 + Buffer.byteLength(auth.signedBinding) > B.relayMetadataBytes) throw new HubError('NETWORK_REQUEST_CAPACITY', 503);
        if ([...peers].filter(p => p.auth.scope.deviceId === auth.scope.deviceId).length >= 2) throw new HubError('NETWORK_CONNECTION_CAPACITY', 429);
        wss.handleUpgrade(request, socket, head, ws => {
          const p: Peer = { ws, auth, epoch: randomUUID(), nonce: randomUUID(), hello: false, ready: false,
            recovery: false, ancestry: new Set(), created: Date.now(), lastSeen: Date.now(), busy: false,
            inbox: [], inboxBytes: 0, controls: new Map(), pingAt: Date.now(), rateAt: Date.now(), rateCount: 0, closed: false };
          peers.add(p);
          ws.on('pong', () => { p.lastSeen = Date.now(); });
          ws.on('ping', () => { p.lastSeen = Date.now(); });
          ws.on('error', () => disconnect(p, 'NETWORK_CONNECTION_CLOSED'));
          ws.on('close', () => disconnect(p, 'NETWORK_CONNECTION_CLOSED'));
          ws.on('message', (raw, isBinary) => {
            const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw); p.lastSeen = Date.now();
            if (!isBinary) {
              if (Date.now() - p.rateAt >= 1000) { p.rateAt = Date.now(); p.rateCount = 0; }
              if (++p.rateCount > 512) { disconnect(p, 'NETWORK_REQUEST_CAPACITY'); return; }
            }
            let queued = data.length;
            for (const peer of peers) queued += peer.inboxBytes + peer.ws.bufferedAmount;
            if (queued > B.relayQueueBytes) { disconnect(p, 'NETWORK_BACKPRESSURE'); return; }
            if (p.inbox.length >= B.pending || p.inboxBytes + data.length > B.socketQueueBytes) { disconnect(p, 'NETWORK_BACKPRESSURE'); return; }
            p.inbox.push({ data, binary: isBinary }); p.inboxBytes += data.length; void drain(p);
          });
        });
      } catch (cause) {
        if (!socket.destroyed) {
          const status = cause instanceof HubError ? cause.status : 401;
          socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        }
      } finally {
        if (reserved) pendingUpgrades--;
      }
    },
    async close(): Promise<void> {
      stopping = true; clearInterval(tick);
      if (identity.onRevoke === onRevoke) identity.onRevoke = priorRevoke;
      if (metadata.onChange === changed) metadata.onChange = undefined;
      metadata.setPresenceProvider(() => undefined);
      for (const p of peers) disconnect(p, 'SERVER_SHUTDOWN');
      channels.clear(); prepared.clear(); routes.clear(); previous.clear(); retiredOps.clear();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}
