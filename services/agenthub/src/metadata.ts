import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  NETWORK_BUDGETS, catalogSchema, membershipMutationSchema, mountMutationSchema,
  deviceNameMutationSchema,
} from '@myagents/agent-network-protocol';
import type { CatalogItem } from '@myagents/agent-network-protocol';
import type { AuthContext, HubConfig, IdentityApi, IdentityDevice, MetadataApi, Presence } from './types.js';
import { HubError } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Row = Record<string, string | number | null>;
type ChangeScope = 'settings' | 'catalog' | 'presence' | 'roster';
interface Catalog { epoch: string; seq: number; syncedAt: number; items: CatalogItem[] }
interface CallableMount { mount: Row; device: IdentityDevice; presence: Presence; item: CatalogItem }

function uuid(value: string): string {
  if (!UUID.test(value)) throw new HubError('NETWORK_REFERENCE_INVALID', 400);
  return value;
}

// Canonical property ordering makes retry identity independent of JSON key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function createMetadata(config: HubConfig, db: DatabaseSync, identity: IdentityApi): MetadataApi {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agenthub_metadata_memberships (
      device_id TEXT NOT NULL, network_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      joined INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(device_id, network_id)
    );
    CREATE TABLE IF NOT EXISTS agenthub_metadata_mounts (
      mount_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, network_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, local_agent_id TEXT NOT NULL, local_workspace_id TEXT NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active',
      icon TEXT, enabled INTEGER NOT NULL DEFAULT 0, enable_revision INTEGER NOT NULL DEFAULT 0,
      description TEXT, description_revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(device_id, local_agent_id)
    );
    CREATE TABLE IF NOT EXISTS agenthub_metadata_catalogs (
      device_id TEXT NOT NULL, connection_epoch TEXT NOT NULL, catalog_seq INTEGER NOT NULL,
      synced_at INTEGER NOT NULL, items_json TEXT NOT NULL,
      PRIMARY KEY(device_id, connection_epoch)
    );
    CREATE TABLE IF NOT EXISTS agenthub_metadata_names (
      device_id TEXT NOT NULL, network_id TEXT NOT NULL, name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(device_id, network_id)
    );
    CREATE TABLE IF NOT EXISTS agenthub_metadata_receipts (
      mutation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, device_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agenthub_metadata_receipts_age ON agenthub_metadata_receipts(created_at);
    CREATE TABLE IF NOT EXISTS agenthub_metadata_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO agenthub_metadata_state VALUES(1,0);
    CREATE TABLE IF NOT EXISTS agenthub_metadata_seen (device_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
  `);

  let presenceProvider: (deviceId: string) => Presence | undefined = () => undefined;
  const revision = () => Number((db.prepare('SELECT revision FROM agenthub_metadata_state WHERE singleton=1').get() as Row).revision);
  function bump(): number {
    db.prepare('UPDATE agenthub_metadata_state SET revision=revision+1 WHERE singleton=1').run();
    return revision();
  }
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function authorize(auth: AuthContext, networkId = config.networkId): void {
    const scope = auth.scope;
    if (networkId !== config.networkId || scope.serviceId !== config.serviceId
      || scope.environment !== config.environment || scope.networkId !== config.networkId
      || scope.principalId !== config.principalId) throw new HubError('NETWORK_SCOPE_MISMATCH', 403);
    if (auth.expiresAt <= Math.floor(Date.now() / 1000)) throw new HubError('TOKEN_EXPIRED', 401);
  }
  function device(deviceId: string): IdentityDevice {
    const found = identity.devices().find((entry) => entry.deviceId === deviceId);
    if (!found) throw new HubError('DEVICE_NOT_FOUND', 404);
    return found;
  }
  function nameDto(deviceId: string) {
    const original = device(deviceId);
    const row = db.prepare('SELECT name FROM agenthub_metadata_names WHERE device_id=? AND network_id=?').get(deviceId, config.networkId) as Row | undefined;
    return { networkId: config.networkId, principalId: config.principalId, deviceId, name: row ? String(row.name) : original.name };
  }
  function membership(deviceId: string) {
    const row = db.prepare('SELECT joined,revision FROM agenthub_metadata_memberships WHERE device_id=? AND network_id=?').get(deviceId, config.networkId) as Row | undefined;
    return { networkId: config.networkId, principalId: config.principalId, deviceId,
      joined: row?.joined === 1, membershipRevision: Number(row?.revision ?? 0) };
  }
  function presence(deviceId: string): Presence | undefined {
    const found = presenceProvider(deviceId);
    if (!found || found.auth.scope.deviceId !== deviceId) return undefined;
    try { authorize(found.auth); } catch (error) {
      if (error instanceof HubError) return undefined;
      throw error;
    }
    db.prepare('INSERT INTO agenthub_metadata_seen VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET seen_at=excluded.seen_at').run(deviceId, Date.now());
    return found;
  }
  function catalog(deviceId: string, epoch?: string): Catalog | undefined {
    const row = (epoch
      ? db.prepare('SELECT * FROM agenthub_metadata_catalogs WHERE device_id=? AND connection_epoch=?').get(deviceId, epoch)
      : db.prepare('SELECT * FROM agenthub_metadata_catalogs WHERE device_id=? ORDER BY synced_at DESC LIMIT 1').get(deviceId)) as Row | undefined;
    return row ? { epoch: String(row.connection_epoch), seq: Number(row.catalog_seq), syncedAt: Number(row.synced_at), items: JSON.parse(String(row.items_json)) as CatalogItem[] } : undefined;
  }
  function mountRow(mountId: string): Row {
    const row = db.prepare('SELECT * FROM agenthub_metadata_mounts WHERE mount_id=? AND network_id=? AND principal_id=?').get(mountId, config.networkId, config.principalId) as Row | undefined;
    if (!row) throw new HubError('MOUNT_NOT_FOUND', 404);
    return row;
  }
  function mountDto(row: Row) {
    return { mountId: String(row.mount_id), networkId: config.networkId, principalId: config.principalId,
      deviceId: String(row.device_id), localAgentId: String(row.local_agent_id), enabled: row.enabled === 1,
      enableRevision: Number(row.enable_revision), description: row.description === null ? null : String(row.description),
      descriptionRevision: Number(row.description_revision) };
  }
  function callableMount(mountId: string): CallableMount | undefined {
    const mount = mountRow(mountId);
    const deviceId = String(mount.device_id);
    if (!membership(deviceId).joined || mount.enabled !== 1 || mount.lifecycle !== 'active') return undefined;
    const current = presence(deviceId);
    if (!current?.ready) return undefined;
    const item = catalog(deviceId, current.connectionEpoch)?.items.find((candidate) => candidate.localAgentId === mount.local_agent_id && candidate.lifecycle === 'active');
    if (!item) return undefined;
    // A revoked identity can remain in old metadata but must never resolve as a target.
    const currentDevice = identity.devices().find((entry) => entry.deviceId === deviceId);
    return currentDevice ? { mount, device: currentDevice, presence: current, item } : undefined;
  }
  function callableDto(found: CallableMount) {
    return { mountId: String(found.mount.mount_id), localAgentId: found.item.localAgentId, name: found.item.name,
      ...(found.item.icon === undefined ? {} : { icon: found.item.icon }), description: found.mount.description,
      deviceId: found.device.deviceId, deviceName: nameDto(found.device.deviceId).name, platform: found.device.platform.slice(0, 256),
      membershipRevision: membership(found.device.deviceId).membershipRevision, enableRevision: Number(found.mount.enable_revision),
      selector: `ma-agent:1:${config.serviceId}:${config.networkId}:${String(found.mount.mount_id)}`, isLocal: false,
      source: { serviceId: config.serviceId, networkId: config.networkId }, connectionEpoch: found.presence.connectionEpoch,
      keyGeneration: found.presence.auth.scope.keyGeneration, signedBinding: found.presence.auth.signedBinding || null };
  }
  function pagination(url: URL) {
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? NETWORK_BUDGETS.pageSize : Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NETWORK_BUDGETS.pageMax) throw new HubError('PAGINATION_INVALID', 400);
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && !UUID.test(cursor)) throw new HubError('PAGINATION_INVALID', 400);
    return { limit, cursor };
  }
  function page<T>(entries: T[], getId: (entry: T) => string, url: URL) {
    const { limit, cursor } = pagination(url);
    const remaining = entries.filter((entry) => cursor === null || getId(entry) > cursor).sort((a, b) => getId(a) < getId(b) ? -1 : getId(a) > getId(b) ? 1 : 0);
    const items: T[] = [];
    let bytes = 128;
    for (const entry of remaining) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (items.length === limit || bytes + size > NETWORK_BUDGETS.objectBytes - 1024) break;
      items.push(entry);
      bytes += size + 1;
    }
    const nextCursor = remaining.length > items.length ? getId(items[items.length - 1]!) : null;
    return { items, nextCursor, complete: nextCursor === null };
  }
  // Mutation state, revision and replay receipt commit together: no successful unreceipted writes.
  function mutate(auth: AuthContext, operation: string, input: { mutationId: string }, scope: ChangeScope, apply: () => unknown): unknown {
    const hash = createHash('sha256').update(canonical({ operation, input })).digest('hex');
    let changedRevision: number | undefined;
    const result = transaction(() => {
      const old = db.prepare('SELECT * FROM agenthub_metadata_receipts WHERE mutation_id=?').get(input.mutationId) as Row | undefined;
      if (old) {
        if (old.principal_id !== auth.scope.principalId || old.device_id !== auth.scope.deviceId) throw new HubError('MUTATION_UNAUTHORIZED', 403);
        if (old.payload_hash !== hash) throw new HubError('MUTATION_ID_REUSE', 409);
        return JSON.parse(String(old.result_json)) as unknown;
      }
      db.prepare('DELETE FROM agenthub_metadata_receipts WHERE created_at<?').run(Date.now() - NETWORK_BUDGETS.mutationMs);
      const count = Number((db.prepare('SELECT count(*) AS n FROM agenthub_metadata_receipts').get() as Row).n);
      if (count >= 100_000) throw new HubError('MUTATION_CAPACITY_EXCEEDED', 429);
      const value = apply();
      changedRevision = bump();
      db.prepare('INSERT INTO agenthub_metadata_receipts VALUES(?,?,?,?,?,?)').run(input.mutationId, auth.scope.principalId, auth.scope.deviceId, hash, JSON.stringify(value), Date.now());
      return value;
    });
    if (changedRevision !== undefined) api.onChange?.(scope, changedRevision);
    return result;
  }

  const api: MetadataApi = {
    setPresenceProvider(provider) { presenceProvider = provider; },
    membershipRevision(deviceId) { return membership(deviceId).membershipRevision; },
    catalogSeq(deviceId, connectionEpoch) { return catalog(deviceId, connectionEpoch)?.seq ?? 0; },
    resolveMount(mountId) {
      const found = callableMount(uuid(mountId));
      if (!found) throw new HubError('MOUNT_NOT_CALLABLE', 404);
      return { mountId, deviceId: found.device.deviceId,
        membershipRevision: membership(found.device.deviceId).membershipRevision, enableRevision: Number(found.mount.enable_revision) };
    },
    handle(auth, request, url, body) {
      authorize(auth);
      const method = request.method ?? 'GET';
      const path = url.pathname;
      if (method === 'GET' && path === '/v1/me/network') {
        return { serviceId: config.serviceId, environment: config.environment, networkId: config.networkId,
          principalId: config.principalId, name: config.name, revision: revision(), protocol: 1,
          capabilities: ['tls13-mtls', 'typed-rpc', 'permit-v1', 'return-v1', 'return-resume-v1'] };
      }
      if (method === 'GET' && path === '/v1/devices') {
        const entries = identity.devices().map((entry) => {
          const current = presence(entry.deviceId);
          const snapshot = current ? catalog(entry.deviceId, current.connectionEpoch) : catalog(entry.deviceId);
          const seen = db.prepare('SELECT seen_at FROM agenthub_metadata_seen WHERE device_id=?').get(entry.deviceId) as Row | undefined;
          const enabled = db.prepare("SELECT local_agent_id FROM agenthub_metadata_mounts WHERE device_id=? AND enabled=1 AND lifecycle='active'").all(entry.deviceId) as Row[];
          const onlineAgentCount = current?.ready && snapshot && membership(entry.deviceId).joined
            ? enabled.filter((mount) => snapshot.items.some((item) => item.localAgentId === mount.local_agent_id && item.lifecycle === 'active')).length
            : current && !snapshot ? null : 0;
          return { ...membership(entry.deviceId), name: nameDto(entry.deviceId).name,
            platform: entry.platform.slice(0, 256), osVersion: entry.osVersion.slice(0, 256), appVersion: entry.appVersion.slice(0, 128),
            lastAccountSeenAt: entry.lastAccountSeenAt.slice(0, 128), lastNetworkSeenAt: seen ? Number(seen.seen_at) : null,
            rosterRevision: String(revision()), catalogEpoch: snapshot?.epoch ?? null, catalogSeq: snapshot?.seq ?? 0,
            catalogSyncedAt: snapshot?.syncedAt ?? null, connectionState: current?.ready ? 'ready' : current ? 'syncing' : 'offline', onlineAgentCount };
        });
        return page(entries, (entry) => entry.deviceId, url);
      }
      const agents = /^\/v1\/devices\/([^/]+)\/agents$/.exec(path);
      if (method === 'GET' && agents) {
        const deviceId = uuid(agents[1]!);
        device(deviceId);
        const snapshot = catalog(deviceId);
        const rows = db.prepare("SELECT * FROM agenthub_metadata_mounts WHERE device_id=? AND network_id=? AND lifecycle='active'").all(deviceId, config.networkId) as Row[];
        const entries = rows.map((row) => ({ ...mountDto(row), localWorkspaceId: String(row.local_workspace_id),
          name: String(row.name), path: String(row.path), lifecycle: 'active', icon: row.icon,
          catalogRevision: snapshot?.items.find((item) => item.localAgentId === row.local_agent_id)?.exposureRevision ?? 0 }));
        return page(entries, (entry) => entry.mountId, url);
      }
      if (method === 'PUT' && path === '/v1/devices/self/catalog') {
        const parsed = catalogSchema.safeParse(body);
        if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > NETWORK_BUDGETS.catalogBytes) throw new HubError('CATALOG_INVALID', 400);
        const input = parsed.data;
        if (new Set(input.items.map((item) => item.localAgentId)).size !== input.items.length) throw new HubError('CATALOG_INVALID', 400);
        device(auth.scope.deviceId);
        const current = presence(auth.scope.deviceId);
        if (!current || current.connectionEpoch !== input.connectionEpoch || current.auth.sessionHandle !== auth.sessionHandle
          || current.auth.scope.keyGeneration !== auth.scope.keyGeneration) throw new HubError('CONNECTION_EPOCH_MISMATCH', 409);
        const changed = transaction(() => {
          const old = catalog(auth.scope.deviceId, input.connectionEpoch);
          if (old && input.catalogSeq <= old.seq) {
            if (input.catalogSeq === old.seq && canonical(old.items) === canonical(input.items)) return undefined;
            throw new HubError('CATALOG_SEQUENCE_STALE', 409);
          }
          db.prepare('DELETE FROM agenthub_metadata_catalogs WHERE device_id=?').run(auth.scope.deviceId);
          db.prepare('INSERT INTO agenthub_metadata_catalogs VALUES(?,?,?,?,?)').run(auth.scope.deviceId, input.connectionEpoch, input.catalogSeq, Date.now(), JSON.stringify(input.items));
          db.prepare("UPDATE agenthub_metadata_mounts SET lifecycle='removed' WHERE device_id=?").run(auth.scope.deviceId);
          const upsert = db.prepare(`INSERT INTO agenthub_metadata_mounts
            (mount_id,device_id,network_id,principal_id,local_agent_id,local_workspace_id,name,path,lifecycle,icon)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,local_agent_id) DO UPDATE SET
            local_workspace_id=excluded.local_workspace_id,name=excluded.name,path=excluded.path,lifecycle=excluded.lifecycle,icon=excluded.icon`);
          for (const item of input.items) {
            upsert.run(randomUUID(), auth.scope.deviceId, config.networkId, config.principalId,
              item.localAgentId, item.localWorkspaceId, item.name, item.path, item.lifecycle, item.icon ?? null);
          }
          return bump();
        });
        if (changed !== undefined) api.onChange?.('catalog', changed);
        return { connectionEpoch: input.connectionEpoch, catalogSeq: input.catalogSeq };
      }
      const callable = /^\/v1\/networks\/([^/]+)\/callable-agents(?:\/([^/]+))?$/.exec(path);
      if (method === 'GET' && callable) {
        authorize(auth, uuid(callable[1]!));
        if (callable[2]) {
          const found = callableMount(uuid(callable[2]));
          if (!found) throw new HubError('MOUNT_NOT_CALLABLE', 404);
          return callableDto(found);
        }
        const rows = db.prepare("SELECT mount_id FROM agenthub_metadata_mounts WHERE network_id=? AND enabled=1 AND lifecycle='active'").all(config.networkId) as Row[];
        const entries = [];
        for (const row of rows) {
          const found = callableMount(String(row.mount_id));
          if (found) entries.push(callableDto(found));
        }
        return page(entries, (entry) => entry.mountId, url);
      }
      const member = /^\/v1\/networks\/([^/]+)\/devices\/([^/]+)\/(join|leave)$/.exec(path);
      if (method === 'POST' && member) {
        authorize(auth, uuid(member[1]!));
        const deviceId = uuid(member[2]!);
        const parsed = membershipMutationSchema.safeParse(body);
        if (!parsed.success) throw new HubError('MUTATION_INVALID', 400);
        return mutate(auth, `${method}:${path}`, parsed.data, 'settings', () => {
          device(deviceId);
          const current = membership(deviceId);
          if (current.membershipRevision !== parsed.data.expectedMembershipRevision) throw new HubError('MEMBERSHIP_REVISION_CONFLICT', 409);
          const joined = member[3] === 'join';
          db.prepare('INSERT INTO agenthub_metadata_memberships VALUES(?,?,?,?,?) ON CONFLICT(device_id,network_id) DO UPDATE SET joined=excluded.joined,revision=excluded.revision')
            .run(deviceId, config.networkId, config.principalId, joined ? 1 : 0, current.membershipRevision + 1);
          if (!joined) db.prepare('UPDATE agenthub_metadata_mounts SET enabled=0,enable_revision=enable_revision+1 WHERE device_id=? AND enabled=1').run(deviceId);
          return membership(deviceId);
        });
      }
      const mount = /^\/v1\/networks\/([^/]+)\/mounts\/([^/]+)$/.exec(path);
      if (method === 'PATCH' && mount) {
        authorize(auth, uuid(mount[1]!));
        const mountId = uuid(mount[2]!);
        const parsed = mountMutationSchema.safeParse(body);
        if (!parsed.success) throw new HubError('MUTATION_INVALID', 400);
        const input = parsed.data;
        if ('description' in input && input.description !== null && Buffer.byteLength(input.description) > NETWORK_BUDGETS.descriptionBytes) throw new HubError('MUTATION_INVALID', 400);
        return mutate(auth, `${method}:${path}`, input, 'settings', () => {
          const row = mountRow(mountId);
          device(String(row.device_id));
          const memberState = membership(String(row.device_id));
          if (memberState.membershipRevision !== input.expectedMembershipRevision) throw new HubError('MEMBERSHIP_REVISION_CONFLICT', 409);
          if ('enabled' in input) {
            if (Number(row.enable_revision) !== input.expectedEnableRevision) throw new HubError('REVISION_CONFLICT', 409);
            if (input.enabled && (!memberState.joined || row.lifecycle !== 'active')) throw new HubError('MOUNT_NOT_CALLABLE', 409);
            db.prepare('UPDATE agenthub_metadata_mounts SET enabled=?,enable_revision=enable_revision+1 WHERE mount_id=?').run(input.enabled ? 1 : 0, mountId);
          } else {
            if (Number(row.description_revision) !== input.expectedDescriptionRevision) throw new HubError('REVISION_CONFLICT', 409);
            db.prepare('UPDATE agenthub_metadata_mounts SET description=?,description_revision=description_revision+1 WHERE mount_id=?').run(input.description, mountId);
          }
          return mountDto(mountRow(mountId));
        });
      }
      const receipt = /^\/v1\/mutations\/([^/]+)$/.exec(path);
      if (method === 'GET' && receipt) {
        const row = db.prepare('SELECT * FROM agenthub_metadata_receipts WHERE mutation_id=?').get(uuid(receipt[1]!)) as Row | undefined;
        if (!row || row.principal_id !== auth.scope.principalId || row.device_id !== auth.scope.deviceId) throw new HubError('MUTATION_NOT_FOUND', 404);
        return JSON.parse(String(row.result_json)) as unknown;
      }
      const named = /^\/v1\/networks\/([^/]+)\/devices\/([^/]+)\/name$/.exec(path);
      if (named && (method === 'GET' || method === 'PATCH')) {
        authorize(auth, uuid(named[1]!));
        const deviceId = uuid(named[2]!);
        if (method === 'GET') return nameDto(deviceId);
        const parsed = deviceNameMutationSchema.safeParse(body);
        if (!parsed.success) throw new HubError('MUTATION_INVALID', 400);
        return mutate(auth, `${method}:${path}`, parsed.data, 'roster', () => {
          const current = nameDto(deviceId);
          if (current.name !== parsed.data.expectedName) {
            const error = new HubError('REVISION_CONFLICT', 409);
            Object.assign(error, { details: current });
            throw error;
          }
          db.prepare(`INSERT INTO agenthub_metadata_names VALUES(?,?,?,1) ON CONFLICT(device_id,network_id)
            DO UPDATE SET name=excluded.name,revision=agenthub_metadata_names.revision+1`).run(deviceId, config.networkId, parsed.data.name);
          return nameDto(deviceId);
        });
      }
      throw new HubError('NOT_FOUND', 404);
    },
  };
  return api;
}
