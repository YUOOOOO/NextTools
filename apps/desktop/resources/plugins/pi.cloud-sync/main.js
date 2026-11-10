const { createConversationSync } = require('./client.cjs');
const { createConversationAutoSync } = require('./auto-sync.cjs');
const METHODS = new Set(['getState', 'register', 'signIn', 'signOut', 'push', 'openConsole']);
let sync, scheduler, offDeleted;
function initialize() {
  if (sync) return;
  sync = createConversationSync(pi);
  scheduler = createConversationAutoSync({ sync, onError: () => sync?.recordError() });
  offDeleted = pi.events.on('session:deleted', payload => {
    void sync.queueDeleted(payload?.ids).then(() => scheduler.request()).catch(() => sync?.recordError());
  });
}
async function onLoad() {
  initialize();
  pi.services.register({ id: 'sync', start() { initialize(); scheduler.start(); }, stop() { return stop(); } });
}
async function stop() {
  scheduler?.dispose();
  offDeleted?.(); offDeleted = null;
  const previous = sync; sync = null;
  if (previous) await previous.dispose();
}
async function invoke(method, payload) {
  if (!METHODS.has(method)) throw Object.assign(new Error('Unsupported cloud sync action'), { code: 'UNSUPPORTED' });
  initialize();
  try {
    const result = await sync[method](payload);
    if (method === 'register' || method === 'signIn') scheduler.request();
    if (method !== 'getState') sync.clearError();
    return { ...result, lastError: sync.getCachedState().lastError || null };
  } catch (error) {
    sync.recordError();
    if (method === 'getState') return sync.getCachedState();
    throw Object.assign(new Error('Cloud sync failed'), { code: 'sync_failed' });
  }
}
module.exports = { onLoad, onUnload: stop, onPanelInvoke: invoke };
