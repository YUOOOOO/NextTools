import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
import { cloudFixture } from './helpers/cloud-plugin-fixture.mjs';
import { createConversationSync } from '../resources/plugins/pi.cloud-sync/client.cjs';
import { toSyncChanges, validateBaseUrl } from '../resources/plugins/pi.cloud-sync/sync-data.cjs';
const login = { baseUrl:'http://fixture.invalid', account:'alice', password:'password' };
function setup(t, options) { const f=cloudFixture(options), sync=createConversationSync(f.pi); t.after(() => sync.dispose()); return { ...f, sync }; }

test('typed server URL is validated before transmission', () => {
  assert.equal(validateBaseUrl('127.0.0.1:8788'),'http://127.0.0.1:8788');
  for (const value of ['file:///private', 'https://user:pass@example.com', 'https://example.com/path']) assert.throws(() => validateBaseUrl(value));
});
test('text mapping excludes tools, streaming, attachments and remotely owned sessions', () => {
  const changes=toSyncChanges([{ id:'local-session', createdAt:1, projectPath:'C:/Private/Project', messages:[
    {id:'user-message',role:'user',content:[{type:'text',text:'hello'},{type:'image',data:'SECRET'}]},
    {id:'tool-message',role:'tool',text:'SECRET'}, {id:'stream-message',role:'assistant',status:'streaming',text:'SECRET'}
  ] }, {id:'remote-session',source:'remote'}], 'desktop-one');
  assert.deepEqual(changes.messages.map(row=>row.text),['hello']);
  assert.equal(changes.conversations.length,1); assert.equal(changes.conversations[0].project_name,'Project');
  assert.doesNotMatch(JSON.stringify(changes),/Private|SECRET/);
});
test('login stores credentials asynchronously and idempotent pushes use persisted device identity', async t => {
  const f=setup(t); assert.deepEqual(await f.sync.getState(),{signedIn:false}); assert.equal(f.requests.length,0);
  assert.equal((await f.sync.signIn(login)).account,'alice'); await tick();
  await f.sync.push(); await f.sync.push();
  const bodies=f.requests.filter(row=>row.url.endsWith('/changes')).map(row=>JSON.parse(row.body));
  assert.deepEqual(bodies[0],bodies[1]); assert.equal(bodies[0].device,'desktop-one');
  assert.equal(bodies[0].messages[0].text,'hello');
  assert.equal(f.frames.find(row=>row.type==='hello').device.id,'desktop-one');
  assert.equal(JSON.parse(f.credentials.get('account')).token,'FIXTURE_TOKEN');
  assert.doesNotMatch(JSON.stringify(await f.sync.getState()),/FIXTURE_TOKEN|password/);
});
test('signout during transcript loading prevents stale uploads', async t => {
  let release, entered; const started=new Promise(resolve=>{entered=resolve;});
  const f=setup(t,{list:()=>{entered();return new Promise(resolve=>{release=resolve;});}});
  await f.sync.signIn(login); const pending=f.sync.push(); await started; const rejected=assert.rejects(pending,{code:'signed_out'});
  await f.sync.signOut(); release([{id:'stale-session'}]); await rejected;
  assert.equal(f.requests.filter(row=>row.url.endsWith('/changes')).length,0);
  assert.equal(f.credentials.has('account'),false);
});
test('failed upload never grants remote access and account switching revokes successful grants', async t => {
  let reject=true;
  const f=setup(t,{fetch:async input=>input.url.includes('/auth/')?{token:'token',account:JSON.parse(input.body).account}:input.url.endsWith('/changes')?{accepted:1,rejected:reject?[{}]:[]}:{enabled:true}});
  await f.sync.signIn(login); await tick(); await assert.rejects(f.sync.push(),{code:'sync_rejected'});
  f.call('first'); await tick(); assert.deepEqual(f.calls.at(-1).sharedSessionIds,[]);
  reject=false; await f.sync.push(); f.call('second'); await tick(); assert.deepEqual(f.calls.at(-1).sharedSessionIds,['local-session']);
  await f.sync.signIn({...login,account:'bob'}); await tick(); f.call('third'); await tick(); assert.deepEqual(f.calls.at(-1).sharedSessionIds,[]);
});
test('tombstones persist across restart and cannot delete another device record', async t => {
  const credentials=new Map(); let fail=true; const deleted=[];
  const options={credentials,fetch:async input=>{
    if(input.url.includes('/auth/'))return {token:'token',account:'alice'};
    if(input.method==='DELETE'){if(fail)throw new Error('offline');deleted.push(input.url);return {};}
    if(input.url.endsWith('/conversations'))return {conversations:[{cid:'local-session',execution_device:'desktop-one'}]};return {enabled:true};}};
  const f=setup(t,options);await f.sync.signIn(login);await f.sync.queueDeleted(['local-session']);
  await assert.rejects(f.sync.push(),/offline/);await f.sync.dispose();fail=false;
  const restarted=setup(t,options);await restarted.sync.push();assert.equal(deleted.length,1);
  assert.deepEqual(JSON.parse(credentials.get('account')).pendingDeletes,[]);
  const other=setup(t,{fetch:async input=>input.url.includes('/auth/')?{token:'token',account:'alice'}:{conversations:[{cid:'other-session',execution_device:'desktop-two'}]}});
  await other.sync.signIn(login);await other.sync.queueDeleted(['other-session']);await assert.rejects(other.sync.push(),{code:'sync_delete_owner'});
});
test('real entry wires service lifecycle, exact-call progress and signout cancellation', async t => {
  const require=createRequire(import.meta.url), entryPath=require.resolve('../resources/plugins/pi.cloud-sync/main.js');
  delete require.cache[entryPath]; const f=cloudFixture({invoke:()=>new Promise(()=>{})});globalThis.pi=f.pi;
  const entry=require(entryPath);t.after(async()=>{await entry.onUnload();delete globalThis.pi;delete require.cache[entryPath];});
  await entry.onLoad();assert.equal(f.requests.length,0);
  await entry.onPanelInvoke('register',login);await tick();f.call('task-one');await tick();
  f.emit('remote-session:event',{requestId:'unrelated',event:{stage:'text',text:'wrong'}});
  f.emit('remote-session:event',{requestId:'task-one',event:{stage:'text',text:'answer'}});await tick();
  assert.deepEqual(f.frames.filter(row=>row.type==='event').map(row=>[row.id,row.body.text]),[['task-one','answer']]);
  await entry.onPanelInvoke('signOut');assert.deepEqual(f.cancelled,['task-one']);assert.equal(f.sockets.size,0);
  const count=f.frames.length;f.emit('remote-session:event',{requestId:'task-one',event:{stage:'text'}});await tick();assert.equal(f.frames.length,count);
});

test('disabled accounts do not inspect transcripts or upload data', async t => {
  let listed = false;
  const f = setup(t, { list: async () => { listed = true; return []; }, fetch: async input => input.url.includes('/auth/') ? { token: 'token', account: 'alice' } : { enabled: false } });
  await f.sync.signIn(login);
  const result = await f.sync.push();
  assert.equal(result.state.enabled, false);
  assert.equal(listed, false);
  assert.equal(f.requests.some(input => input.url.endsWith('/changes') || input.url.endsWith('/conversations')), false);
});

test('service failures remain observable as sanitized public state', async t => {
  const require = createRequire(import.meta.url), entryPath = require.resolve('../resources/plugins/pi.cloud-sync/main.js');
  delete require.cache[entryPath];
  let fail = false;
  const f = cloudFixture({ fetch: async input => {
    if (fail) throw new Error('SECRET_TRANSPORT_DETAIL');
    return input.url.includes('/auth/') ? { token: 'FIXTURE_TOKEN', account: 'alice' } : { enabled: true };
  } });
  globalThis.pi = f.pi; const entry = require(entryPath);
  t.after(async () => { await entry.onUnload(); delete globalThis.pi; delete require.cache[entryPath]; });
  await entry.onLoad(); await entry.onPanelInvoke('signIn', login); fail = true;
  const state = await entry.onPanelInvoke('getState');
  assert.equal(state.signedIn, true); assert.equal(state.lastError, 'sync_failed');
  assert.doesNotMatch(JSON.stringify(state), /SECRET|FIXTURE_TOKEN/);
});

test('a successful tombstone is never reuploaded from the same round stale snapshot', async t => {
  const deleted = new Set(), uploads = [];
  const f = setup(t, { fetch: async input => {
    if (input.url.includes('/auth/')) return { token: 'token', account: 'alice' };
    if (input.url.endsWith('/conversations')) return { conversations: deleted.size ? [] : [{ cid: 'local-session', execution_device: 'desktop-one' }] };
    if (input.method === 'DELETE') { deleted.add('local-session'); return { deleted: true }; }
    if (input.url.endsWith('/changes')) {
      const body = JSON.parse(input.body); uploads.push(body);
      return { accepted: body.conversations.length + body.messages.length,
        rejected: body.conversations.filter(row => deleted.has(row.cid)).map(row => ({ cid: row.cid, reason: 'conversation_deleted' })) };
    }
    return { enabled: true };
  } });
  await f.sync.signIn(login); await f.sync.push(); await tick();
  await f.sync.queueDeleted(['local-session']);
  const result = await f.sync.push();
  assert.equal(result.accepted, 0);
  assert.deepEqual([...deleted], ['local-session']);
  assert.equal(uploads.length, 1, 'the unchanged stale transcript must not be submitted again');
  assert.deepEqual(JSON.parse(f.credentials.get('account')).pendingDeletes, []);
  f.call('after-delete'); await tick();
  assert.deepEqual(f.calls.at(-1).sharedSessionIds, []);
});
