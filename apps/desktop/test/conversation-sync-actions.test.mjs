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

test("cancelled native calls do not write or open anything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sync-action-cancel-"));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runRemoteAction("file.put", { path: join(dir, "cancelled.txt"), content: "must not be written" }, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(readFile(join(dir, "cancelled.txt")), { code: "ENOENT" });
    let opened = false;
    await assert.rejects(runRemoteAction("open", { path: dir }, { signal: controller.signal, open: async () => { opened = true; return ""; } }), { name: "AbortError" });
    assert.equal(opened, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelling a shell terminates its child tree before its deadline", { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const result = await runRemoteAction("shell", { command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`, timeout: 5 }, { signal: controller.signal });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.timed_out, false);
    assert.notEqual(result.exit_code, 0);
  } finally {
    clearTimeout(timer);
  }
});
