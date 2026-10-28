import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationSync, toSyncChanges, validateBaseUrl } from "../electron/main/conversation-sync-client.mjs";

test("conversation sync login accepts the server URL", () => {
  assert.equal(validateBaseUrl("http://127.0.0.1:8788"), "http://127.0.0.1:8788");
  assert.equal(validateBaseUrl("http://sync.example:8788"), "http://sync.example:8788");
  assert.equal(validateBaseUrl("127.0.0.1:8788"), "http://127.0.0.1:8788");
  assert.throws(() => validateBaseUrl("file:///tmp"), /server URL/);
});

test("conversation sync maps user and assistant text and signs in", async () => {
  const changes = toSyncChanges([{
    id: "11111111-1111-4111-8111-111111111111",
    title: "Home",
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [
      { id: "22222222-2222-4222-8222-222222222222", role: "user", content: [{ type: "text", text: "hello" }] },
      { id: "tool-call", role: "tool", text: "skip" },
    ],
  }]);
  assert.equal(changes.conversations.length, 1);
  assert.equal(changes.messages[0].text, "hello");
  assert.equal(changes.messages.length, 1);

  const dir = mkdtempSync(join(tmpdir(), "conversation-sync-"));
  const seen = [];
  const sync = createConversationSync({
    filePath: join(dir, "session.json"),
    encrypt: (plain) => `enc:${plain}`,
    decrypt: (encoded) => encoded.slice(4),
    encryptionAvailable: () => true,
    listSessions: async () => [{
      id: "11111111-1111-4111-8111-111111111111",
      title: "Home",
      messages: [{ id: "22222222-2222-4222-8222-222222222222", role: "user", text: "hello" }],
    }],
    fetchImpl: async (url, init) => {
      seen.push({ url, authorization: init.headers.authorization, body: init.body });
      if (String(url).endsWith("/v1/auth/login")) {
        return { ok: true, json: async () => ({ token: "issued-token", account: "alice" }) };
      }
      return {
        ok: true,
        json: async () => url.endsWith("/v1/sync/state")
          ? { enabled: true, cursor: 2, counts: { conversations: 1, messages: 1 } }
          : { accepted: 2, cursor: 2 },
      };
    },
  });
  const signed = await sync.signIn({ baseUrl: "http://127.0.0.1:8788/", account: "alice", password: "secret1" });
  assert.equal(signed.account, "alice");
  const pushed = await sync.push();
  assert.equal(pushed.accepted, 2);
  const pushedBody = seen.map((item) => item.body).filter(Boolean).at(-1);
  assert.equal(JSON.parse(pushedBody).messages[0].text, "hello");
  rmSync(dir, { recursive: true, force: true });
});

test("desktop login dials the typed server and reads api_key", async () => {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/v1/auth/login") {
        const body = JSON.parse(raw);
        assert.equal(body.identifier, "alice");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ api_key: "issued-token", account: { id: "alice", hint: "alice" } }));
        return;
      }
      assert.equal(req.headers.authorization, "Bearer issued-token");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ enabled: true, cursor: 0, counts: { conversations: 0, messages: 0 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const dir = mkdtempSync(join(tmpdir(), "conversation-sync-direct-"));
  try {
    const sync = createConversationSync({
      filePath: join(dir, "session.json"),
      encrypt: (plain) => `enc:${plain}`,
      decrypt: (encoded) => encoded.slice(4),
      encryptionAvailable: () => true,
      listSessions: async () => [],
    });
    const signed = await sync.signIn({
      baseUrl: `127.0.0.1:${address.port}`,
      account: "alice",
      password: "secret1",
    });
    assert.equal(signed.signedIn, true);
    assert.equal(signed.account, "alice");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("signout during transcript loading prevents any stale upload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-sync-stale-"));
  let resolveSessions;
  const bodies = [];
  const sync = createConversationSync({
    filePath: join(dir, "session.json"), encrypt: (x) => x, decrypt: (x) => x, encryptionAvailable: () => true,
    listSessions: () => new Promise((resolve) => { resolveSessions = resolve; }),
    fetchImpl: async (url, init) => {
      if (url.endsWith("/v1/auth/login")) return { ok: true, json: async () => ({ token: "token", account: "alice" }) };
      if (init.method === "POST") bodies.push(init.body);
      return { ok: true, json: async () => ({ enabled: true }) };
    },
  });
  try {
    await sync.signIn({ baseUrl: "http://127.0.0.1:8788", account: "alice", password: "secret1" });
    const pending = sync.push();
    await sync.signOut();
    resolveSessions([{ id: "session-stale", messages: [{ id: "message-stale", role: "user", content: "do not upload" }] }]);
    await assert.rejects(pending, { code: "signed_out" });
    assert.equal(bodies.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("streaming assistant checkpoints are uploaded only after becoming final", () => {
  const session = { id: "stream-session", messages: [{ id: "stream-message", role: "assistant", status: "streaming", content: "partial" }] };
  assert.equal(toSyncChanges([session]).messages.length, 0);
  session.messages[0] = { ...session.messages[0], status: "complete", content: "final answer" };
  assert.equal(toSyncChanges([session]).messages[0].text, "final answer");
});

test("server-rejected messages are observable sync failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conversation-sync-rejected-"));
  const sync = createConversationSync({
    filePath: join(dir, "session.json"), encrypt: (x) => x, decrypt: (x) => x, encryptionAvailable: () => true,
    listSessions: async () => [{ id: "test-session", messages: [{ id: "test-message", role: "user", content: "hello" }] }],
    fetchImpl: async (url) => ({ ok: true, json: async () => url.endsWith("/v1/auth/login") ? { token: "token", account: "alice" }
      : url.endsWith("/v1/sync/changes") ? { accepted: 0, rejected: [{ mid: "test-message", reason: "conversation_limit" }] } : { enabled: true } }),
  });
  try {
    await sync.signIn({ baseUrl: "http://127.0.0.1:8788", account: "alice", password: "secret1" });
    await assert.rejects(sync.push(), { code: "sync_rejected" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
