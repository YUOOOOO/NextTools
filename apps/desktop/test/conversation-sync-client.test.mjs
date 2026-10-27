import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationSync, toSyncChanges, validateBaseUrl } from "../electron/main/conversation-sync-client.mjs";

test("conversation sync login accepts the server URL", () => {
  assert.equal(validateBaseUrl("http://127.0.0.1:8788"), "http://127.0.0.1:8788");
  assert.equal(validateBaseUrl("http://sync.example:8788"), "http://sync.example:8788");
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
