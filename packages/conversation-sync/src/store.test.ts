import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncServer } from "./http.js";
import { cutText, LIMITS, SyncStore } from "./store.js";

function open(): SyncStore {
  return new SyncStore(new DatabaseSync(":memory:"), undefined, () => 1_700_000_000);
}

const conv = (cid: string, kind = "side", extra: Record<string, unknown> = {}) => ({
  cid,
  kind,
  title: cid,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  ...extra,
});
const msg = (mid: string, cid: string, text = "hello", extra: Record<string, unknown> = {}) => ({
  mid,
  cid,
  role: "user",
  text,
  created_at: 1_700_000_000,
  ...extra,
});

describe("conversation sync save effect", () => {
  it("cuts text at 16 KB without splitting a character", () => {
    const text = `${"a".repeat(LIMITS.textBytes - 1)}你`;
    const [cut, truncated] = cutText(text);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(LIMITS.textBytes);
    expect(cut.endsWith("你")).toBe(false);
    expect(cutText("ok")).toEqual(["ok", false]);
  });

  it("keeps one main, stores truncated text and attachment metadata, and is idempotent", () => {
    const store = open();
    store.rememberDevice("acc", "phone-1", "Phone");
    const long = "你".repeat(20_000);
    const first = store.push("acc", "phone-1", [conv("main-0001", "main", { title: "Home" })], [
      msg("msg-0001", "main-0001", long, {
        attachments: [
          { name: "shot.png", mime: "image/png", size: 12, bytes: "secret" },
          ...Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, mime: "text/plain", size: 1 })),
        ],
      }),
    ]);
    expect(first.accepted).toBe(2);
    expect(first.rejected).toEqual([]);
    const secondMain = store.push("acc", "other-1", [conv("main-0002", "main")], [msg("msg-0002", "main-0002")]);
    expect(secondMain.accepted).toBe(0);
    expect(secondMain.rejected).toEqual([
      { cid: "main-0002", reason: "main_exists", cid_main: "main-0001" },
      { mid: "msg-0002", reason: "main_exists", cid_main: "main-0001" },
    ]);
    const again = store.push("acc", "phone-1", [], [msg("msg-0001", "main-0001", "changed")]);
    expect(again.accepted).toBe(0);
    const page = store.changes("acc", 0) as {
      messages: Array<{ text: string; truncated: boolean; attachments: unknown[]; device_name: string }>;
    };
    expect(page.messages[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(page.messages[0]!.text)).toBeLessThanOrEqual(LIMITS.textBytes);
    expect(page.messages[0]?.attachments).toHaveLength(20);
    expect(page.messages[0]?.attachments[0]).toEqual({ name: "shot.png", mime: "image/png", size: 12 });
    expect(page.messages[0]?.device_name).toBe("Phone");
  });

  it("tombstones a chat, wipes texts, and does not rewind the cursor", () => {
    const store = open();
    store.push("acc", "phone-1", [conv("side-0001")], [msg("msg-0001", "side-0001")]);
    const deleted = store.deleteConversation("acc", "side-0001");
    expect(deleted.deleted).toBe(true);
    const page = store.changes("acc", 0) as { conversations: Array<{ deleted: boolean; title: string }>; messages: unknown[] };
    expect(page.conversations[0]).toMatchObject({ deleted: true, title: "" });
    expect(page.messages).toEqual([]);
    const cursor = store.state("acc").cursor;
    const wiped = store.wipe("acc");
    expect(wiped.enabled).toBe(true);
    expect(wiped.cursor).toBe(cursor);
    expect(wiped.counts).toEqual({ conversations: 0, messages: 0 });
    const off = store.setEnabled("acc", false);
    expect(off.enabled).toBe(false);
    expect(() => store.push("acc", "phone-1", [conv("side-0002")], [])).toThrowError(/sync is off/i);
  });

  it("renames only when updated_at is not older, and a tail pull includes the main row", () => {
    const store = open();
    store.push("acc", "phone-1", [conv("main-0001", "main", { title: "Old", updated_at: 1_700_000_100 })], []);
    store.push("acc", "phone-1", [conv("main-0001", "main", { title: "Older", updated_at: 1_700_000_050 })], []);
    store.push("acc", "phone-1", [conv("main-0001", "main", { title: "New", updated_at: 1_700_000_200 })], [
      msg("msg-0009", "main-0001"),
    ]);
    const tail = store.changes("acc", 0, 500, "all", 1) as {
      conversations: Array<{ cid: string; title: string }>;
      messages: Array<{ mid: string }>;
      skipped: number;
      more: boolean;
    };
    expect(tail.more).toBe(false);
    expect(tail.messages.map((row) => row.mid)).toEqual(["msg-0009"]);
    expect(tail.conversations.find((row) => row.cid === "main-0001")?.title).toBe("New");
  });

  it("refuses a side conversation past the cap and drops oldest messages past the message cap", () => {
    const store = open();
    const conversations = Array.from({ length: LIMITS.conversations }, (_, i) => conv(`side-${String(i).padStart(4, "0")}`));
    for (let i = 0; i < conversations.length; i += 200) {
      const batch = conversations.slice(i, i + 200);
      const pushed = store.push("acc", "phone-1", batch, []);
      expect(pushed.rejected).toEqual([]);
    }
    const overflow = store.push("acc", "phone-1", [conv("side-overflow")], [msg("msg-over", "side-overflow")]);
    expect(overflow.rejected.map((row) => row.reason)).toEqual(["conversation_limit", "unknown_cid"]);

    const many = Array.from({ length: 200 }, (_, i) => msg(`bulk-${String(i).padStart(4, "0")}`, "side-0000", "x"));
    store.push("acc", "phone-1", [], many);
    const before = store.state("acc").counts.messages;
    expect(before).toBe(200);
    const extra = Array.from({ length: 50 }, (_, i) =>
      msg(`keep-${String(i).padStart(4, "0")}`, "side-0001", "y", { created_at: 1_700_000_500 }),
    );
    Object.assign(LIMITS, { messages: 40 });
    try {
      store.push("acc", "phone-1", [conv("side-0001", "side", { updated_at: 1_700_000_400 })], extra);
      expect(store.state("acc").counts.messages).toBeLessThanOrEqual(40);
      const page = store.changes("acc", 0, 1000) as { messages: Array<{ cid: string }> };
      expect(page.messages.some((row) => row.cid === "side-0000")).toBe(false);
    } finally {
      Object.assign(LIMITS, { messages: 20_000 });
    }
  });
});

describe("sync HTTP", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it("pushes and pulls with the bearer account", async () => {
    const db = new DatabaseSync(":memory:");
    const server = createSyncServer({ db, accounts: new Map([["nm_test", "acc"]]) });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const denied = await fetch(`${base}/v1/sync/state`);
    expect(denied.status).toBe(401);
    const headers = { authorization: "Bearer nm_test", "content-type": "application/json" };
    const pushed = await fetch(`${base}/v1/sync/changes`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        device: "phone-1",
        conversations: [conv("main-0001", "main")],
        messages: [msg("msg-0001", "main-0001", "saved")],
      }),
    });
    expect(pushed.status).toBe(200);
    const body = (await pushed.json()) as { accepted: number };
    expect(body.accepted).toBe(2);
    const pulled = await fetch(`${base}/v1/sync/changes?since=0`, { headers });
    const page = (await pulled.json()) as { messages: Array<{ text: string }> };
    expect(page.messages[0]?.text).toBe("saved");
  });
});
