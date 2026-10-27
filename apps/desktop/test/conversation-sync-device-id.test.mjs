import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOrCreateSyncDeviceId } from "../electron/main/conversation-sync-device-id.mjs";

test("desktop installs keep different identities across restarts and sign-outs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sync-device-"));
  try {
    const first = loadOrCreateSyncDeviceId(join(dir, "first"));
    const second = loadOrCreateSyncDeviceId(join(dir, "second"));
    assert.notEqual(first, second);
    assert.equal(loadOrCreateSyncDeviceId(join(dir, "first")), first);
    await writeFile(join(dir, "invalid"), "not-an-id");
    assert.throws(() => loadOrCreateSyncDeviceId(join(dir, "invalid")), /Invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
