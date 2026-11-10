import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

/** The external SDK edge only; plugin client and entry are real modules. */
export function cloudFixture(options = {}) {
  const events = new EventEmitter(), credentials = options.credentials || new Map();
  const requests = [], frames = [], calls = [], cancelled = [], sockets = new Map();
  let next = 0, resetCount = 0;
  const emit = (type, value) => events.emit(type, value);
  const pi = {
    credentials: { async get(key) { return credentials.get(key) || null; }, async set(key, value) { credentials.set(key, value); }, async remove(key) { credentials.delete(key); } },
    events: { on(type, handler) { events.on(type, handler); return () => events.off(type, handler); } },
    remoteSessions: {
      async getDevice() { return { id:'desktop-one', name:'Fixture', os:'test' }; },
      list: options.list || (async () => [{ id:'local-session', createdAt:1, messages:[{ id:'message-one', role:'user', text:'hello', createdAt:1 }] }]),
      isDeleted: options.isDeleted || (async () => false),
      async invoke(input) { calls.push(input); return options.invoke ? options.invoke(input, emit) : { text:'answer' }; },
      async cancel(id) { cancelled.push(id); await options.cancel?.(id); },
      async reset() { resetCount++; await options.reset?.(); }
    },
    net: {
      async fetch(input) {
        requests.push(input);
        const body = options.fetch ? await options.fetch(input) : input.url.includes('/auth/') ? { token:'FIXTURE_TOKEN', account:JSON.parse(input.body).account }
          : input.url.endsWith('/state') ? { enabled:true, counts:{ conversations:1, messages:1 } }
          : input.url.endsWith('/conversations') ? { conversations:[] } : { accepted:2 };
        return { status:200, headers:{}, bodyText:JSON.stringify(body) };
      },
      websocket: {
        async connect({url}) { const id='socket-'+(++next); sockets.set(id,url); queueMicrotask(() => emit('net:websocket:open',{socketId:id})); return { socketId:id }; },
        async send({socketId,data}) { assert(sockets.has(socketId)); frames.push({ socketId, ...JSON.parse(data) }); },
        async close({socketId}) { sockets.delete(socketId); emit('net:websocket:close',{socketId}); }
      }
    },
    shell: { async openExternal(url) { return url; } },
    services: { register(service) { pi.service = service; } }
  };
  return { pi, events, emit, credentials, requests, frames, calls, cancelled, sockets, get resetCount() { return resetCount; },
    call(id, action='task', args={}) { emit('net:websocket:message', { socketId:[...sockets.keys()].at(-1), data:JSON.stringify({ type:'call', id, action, args, from:{ id:'web-one', kind:'web' } }) }); } };
}
