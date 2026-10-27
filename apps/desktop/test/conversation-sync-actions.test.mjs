import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runRemoteAction } from "../electron/main/conversation-sync-actions.mjs";

test("lists a directory and writes a file only at the given path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sync-actions-"));
  try {
    const listed = await runRemoteAction("files", { path: dir });
    assert.equal(listed.path, dir);
    const written = await runRemoteAction("file.put", { path: join(dir, "note.txt"), content: "hello" });
    assert.equal(written.size, 5);
    assert.equal(await readFile(join(dir, "note.txt"), "utf8"), "hello");
    await assert.rejects(() => runRemoteAction("shell", { command: "   " }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
