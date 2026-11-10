const { validateBaseUrl, toSyncChanges } = require('./sync-data.cjs');
const ID = /^[a-z0-9][a-z0-9._:-]{3,63}$/;
const ACCOUNT_KEY = 'account';
const ACTIONS = ['info', 'sessions.list', 'chat.send', 'task', 'stop', 'interactive.list', 'interactive.resolve', 'shell', 'files', 'file.get', 'file.put', 'open', 'screen'];

function createConversationSync(pi) {
  let saved = null, device, generation = 0, disposed = false, socketId = null;
  let connecting = null, reconnectTimer = null, retry = 0, pushFlight = null;
  let storage = Promise.resolve();
  let lastError = null, lastStatus;
  function recordError() { lastError = 'sync_failed'; }
  const shared = new Set(), pending = new Map(), opened = new Set(), unsubscribe = [];
  const ready = pi.credentials.get(ACCOUNT_KEY).then((raw) => {
    if (!raw) return;
    const value = JSON.parse(raw);
    if (!value || typeof value.token !== 'string' || !value.token || typeof value.account !== 'string') throw failure('bad_credentials');
    saved = { baseUrl: validateBaseUrl(value.baseUrl), account: value.account, token: value.token,
      pendingDeletes: Array.isArray(value.pendingDeletes) ? value.pendingDeletes.filter(id => typeof id === 'string' && ID.test(id)) : [] };
  });
  function failure(code) { return Object.assign(new Error(code), { code }); }
  function check(epoch) { if (disposed || generation !== epoch || !saved) throw failure('signed_out'); }
  function persist() {
    const value = saved ? JSON.stringify(saved) : null;
    storage = storage.catch(recordError).then(() => value === null ? pi.credentials.remove(ACCOUNT_KEY) : pi.credentials.set(ACCOUNT_KEY, value));
    return storage;
  }
  async function getDevice() { return device ??= await pi.remoteSessions.getDevice(); }
  async function request(account, path, options = {}) {
    const response = await pi.net.fetch({ url: account.baseUrl + path, method: options.method || 'GET', redirect: 'error',
      headers: { ...(account.token ? { authorization: `Bearer ${account.token}`, 'x-nanomuse-device': (await getDevice()).id } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    let body;
    try { body = JSON.parse(response.bodyText); } catch { throw failure('invalid_response'); }
    if (response.status < 200 || response.status >= 300) throw failure(typeof body?.error?.code === 'string' ? body.error.code : 'upstream');
    return body;
  }
  function publicState(state, accepted) {
    if (state !== undefined) lastStatus = state;
    return { signedIn: !!saved, ...(saved ? { baseUrl: saved.baseUrl, account: saved.account, state: state ?? lastStatus } : {}), ...(accepted === undefined ? {} : { accepted }), ...(lastError ? { lastError } : {}) };
  }
  async function send(id, frame) { if (id !== socketId || disposed) return; await pi.net.websocket.send({ socketId: id, data: JSON.stringify(frame) }); }
  async function hello(id) {
    if (!saved || id !== socketId) return;
    const identity = await getDevice();
    if (!saved || id !== socketId) return;
    await send(id, { type: 'hello', key: saved.token, device: { ...identity, kind: 'computer', actions: ACTIONS } });
  }
  async function cancelCalls(reset = false) {
    const calls = [...pending.keys()]; pending.clear();
    await Promise.all(calls.map(id => pi.remoteSessions.cancel(id)));
    if (reset) await pi.remoteSessions.reset();
  }
  async function closeHub() {
    generation++;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const previous = socketId; socketId = null; opened.clear(); connecting = null;
    try { if (previous) await pi.net.websocket.close({ socketId: previous }); } finally { await cancelCalls(true); }
  }
  function reconnect(id) {
    opened.delete(id);
    if (id !== socketId || disposed) return;
    recordError();
    socketId = null;
    const epoch = generation;
    void cancelCalls().catch(recordError);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (generation === epoch) void ensureHub().catch(recordError); }, Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)));
    reconnectTimer.unref?.();
  }
  async function ensureHub() {
    if (!saved || disposed || socketId || connecting || reconnectTimer) return connecting;
    const epoch = generation, account = saved;
    connecting = (async () => {
      await getDevice(); check(epoch);
      const result = await pi.net.websocket.connect({ url: account.baseUrl.replace(/^http/, 'ws') + '/v1/hub' });
      if (disposed || generation !== epoch) { await pi.net.websocket.close(result); return; }
      socketId = result.socketId;
      if (opened.delete(socketId)) await hello(socketId);
    })();
    try { await connecting; } catch (error) {
      if (!disposed && generation === epoch) { socketId = '__connecting__'; reconnect(socketId); }
      throw error;
    } finally { if (generation === epoch) connecting = null; }
  }
  async function message(event) {
    if (event.socketId !== socketId || !saved) return;
    let frame; try { frame = JSON.parse(String(event.data)); } catch { return; }
    if (frame.type !== 'call' || typeof frame.id !== 'string' || !frame.id || pending.has(frame.id)) return;
    const epoch = generation, id = socketId;
    const caller = frame.from;
    if (!caller || !['web', 'computer', 'phone'].includes(caller.kind) || typeof caller.id !== 'string') return;
    pending.set(frame.id, id);
    try {
      const body = await pi.remoteSessions.invoke({ requestId: frame.id, scope: JSON.stringify([saved.baseUrl, saved.account]),
        caller: { id: caller.id, kind: caller.kind }, action: String(frame.action || ''),
        args: frame.args && typeof frame.args === 'object' && !Array.isArray(frame.args) ? frame.args : {}, sharedSessionIds: [...shared] });
      if (generation === epoch) await send(id, { type: 'result', id: frame.id, ok: true, body });
    } catch (error) {
      if (generation === epoch) await send(id, { type: 'result', id: frame.id, ok: false, error: typeof error?.code === 'string' ? error.code : 'failed', message: 'Remote request failed' });
    } finally { if (pending.get(frame.id) === id) pending.delete(frame.id); }
  }
  unsubscribe.push(pi.events.on('net:websocket:open', event => {
    retry = 0;
    if (event.socketId === socketId) void hello(socketId).catch(() => reconnect(event.socketId));
    else if (connecting) opened.add(event.socketId);
  }));
  unsubscribe.push(pi.events.on('net:websocket:message', event => { void message(event).catch(recordError); }));
  for (const type of ['close', 'error']) unsubscribe.push(pi.events.on('net:websocket:' + type, event => reconnect(event.socketId)));
  unsubscribe.push(pi.events.on('remote-session:event', payload => {
    const id = pending.get(payload.requestId);
    if (id) void send(id, { type: 'event', id: payload.requestId, body: payload.event }).catch(() => reconnect(id));
  }));
  async function authenticate(input, path) {
    await ready;
    const account = String(input?.account || '').trim(), password = String(input?.password || '');
    if (!account || !password) throw failure('bad_credentials');
    await closeHub(); shared.clear();
    const epoch = generation;
    const baseUrl = validateBaseUrl(input.baseUrl);
    const result = await request({ baseUrl }, path, { method: 'POST', body: { account, identifier: account, password } });
    if (disposed || generation !== epoch) throw failure('signed_out');
    const token = result.token || result.api_key;
    if (typeof token !== 'string' || !token) throw failure('bad_key');
    const label = typeof result.account === 'string' ? result.account : result.account?.id || result.account?.hint || account;
    lastStatus = undefined; lastError = null;
    saved = { baseUrl, token, account: String(label), pendingDeletes: saved?.baseUrl === baseUrl && saved.account === String(label) ? saved.pendingDeletes : [] };
    await persist(); check(epoch);
    return getState();
  }
  async function getState() {
    await ready;
    if (!saved || disposed) return { signedIn: false };
    const epoch = generation, account = saved;
    void ensureHub().catch(recordError);
    const state = await request(account, '/v1/sync/state'); check(epoch);
    return publicState(state);
  }
  async function pushRound() {
    await ready; if (!saved) throw failure('signed_out');
    const epoch = generation, account = saved, identity = await getDevice(); check(epoch);
    const before = await request(account, '/v1/sync/state'); check(epoch);
    if (before.enabled === false) return publicState(before, 0);
    const directory = await request(account, '/v1/sync/conversations'); check(epoch);
    const processedDeletes = new Set();
    for (const cid of [...account.pendingDeletes]) {
      const row = directory.conversations?.find(item => item.cid === cid);
      if (row && (row.execution_device || row.device) !== identity.id) throw failure('sync_delete_owner');
      if (row) await request(account, '/v1/sync/conversations/' + encodeURIComponent(cid), { method: 'DELETE' });
      check(epoch);
      processedDeletes.add(cid);
      shared.delete(row?.session_id || cid);
      check(epoch); saved.pendingDeletes = saved.pendingDeletes.filter(id => id !== cid); await persist(); check(epoch);
    }
    const sessions = await pi.remoteSessions.list(); check(epoch);
    const live = new Set(sessions.map(session => session?.id));
    for (const row of directory.conversations || []) {
      const id = row.session_id || row.cid;
      if (processedDeletes.has(row.cid) || (row.execution_device || row.device) !== identity.id || live.has(id) || !ID.test(id)) continue;
      if (await pi.remoteSessions.isDeleted(id)) { check(epoch); saved.pendingDeletes = [...new Set([...saved.pendingDeletes, row.cid])]; shared.delete(id); }
      check(epoch);
    }
    await persist(); check(epoch);
    const tombstones = new Set([...saved.pendingDeletes, ...processedDeletes]);
    const changes = toSyncChanges(sessions.filter(session => !tombstones.has(session?.id)), identity.id);
    let accepted = 0;
    for (let index = 0; index < Math.max(changes.conversations.length, changes.messages.length); index += 200) {
      check(epoch);
      const result = await request(account, '/v1/sync/changes', { method: 'POST', body: { device: identity.id,
        conversations: changes.conversations.slice(index, index + 200), messages: changes.messages.slice(index, index + 200) } });
      check(epoch); if (result.rejected?.length) throw failure('sync_rejected'); accepted += Number(result.accepted || 0);
    }
    const state = await request(account, '/v1/sync/state'); check(epoch);
    for (const row of changes.conversations) if (!saved.pendingDeletes.includes(row.cid)) shared.add(row.session_id);
    void ensureHub().catch(recordError);
    return publicState(state, accepted);
  }
  return {
    getState,
    recordError,
    clearError() { lastError = null; },
    getCachedState() { return publicState(); },
    register: input => authenticate(input, '/v1/auth/register'),
    signIn: input => authenticate(input, '/v1/auth/login'),
    async signOut() { await ready; saved = null; shared.clear(); const closing = closeHub(); await persist(); await closing; return { signedIn: false }; },
    async queueDeleted(ids) { await ready; if (!saved || disposed) return; const valid = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && ID.test(id));
      saved.pendingDeletes = [...new Set([...saved.pendingDeletes, ...valid])]; for (const id of valid) shared.delete(id); await persist(); },
    push() { if (!pushFlight) pushFlight = pushRound().finally(() => { pushFlight = null; }); return pushFlight; },
    async openConsole() { await ready; await pi.shell.openExternal((saved?.baseUrl || 'http://127.0.0.1:8788') + '/'); },
    async dispose() { disposed = true; await closeHub(); for (const off of unsubscribe) if (typeof off === 'function') off(); await storage; },
  };
}
module.exports = { createConversationSync };
