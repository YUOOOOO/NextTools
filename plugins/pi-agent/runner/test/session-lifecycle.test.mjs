import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

test(
  "session commands export data without writing files and restore persisted history",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "nexttools-runner-test-"));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/runner.mjs", import.meta.url))],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const pending = new Map();
    let sequence = 0;
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    t.after(async () => {
      for (const request of pending.values()) clearTimeout(request.timer);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    });
    function rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out: ${stderr}`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(
          `${JSON.stringify({ version: 1, id, method, params })}\n`,
        );
      });
    }

    const models = await rpc("models.list");
    const model = models.find(
      (item) => item.provider === "anthropic" && item.reasoning,
    );
    assert.ok(
      model,
      "pinned catalog must provide a reasoning model for this fixture",
    );
    const sessionId = randomUUID();
    const params = {
      sessionId,
      cwd: root,
      sessionDir: join(root, "sessions"),
      agentDir: root,
      provider: model.provider,
      model: model.id,
      // No prompt is sent to a provider. All credentials stay in memory.
      apiKey: "local-session-test-no-provider-call",
    };
    const created = await rpc("session.create", params);
    await rpc("session.rename", { sessionId, title: "Lifecycle test" });
    assert.equal(
      (await rpc("session.thinking", { sessionId, level: "medium" }))
        .thinkingLevel,
      "medium",
    );
    await assert.rejects(
      rpc("session.thinking", { sessionId, level: "invalid" }),
      /Unsupported thinking level/,
    );

    const beforeExport = await readdir(root);
    const exported = await rpc("session.prompt", {
      sessionId,
      text: "/export",
    });
    assert.equal(exported.accepted, true);
    assert.deepEqual(
      await readdir(root),
      beforeExport,
      "export must not write to the Runner working directory",
    );
    const entries = exported.exportText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries[0].type, "session");
    assert.equal(entries[0].id, created.persistedSessionId);
    assert.ok(
      entries.some(
        (entry) =>
          entry.type === "session_info" && entry.name === "Lifecycle test",
      ),
    );
    assert.equal((await rpc("session.dispose", { sessionId })).disposed, true);
    assert.deepEqual((await rpc("runner.health")).sessions, []);

    // The SDK deliberately does not persist empty conversations. Seed a history
    // fixture to exercise discovery and restoration without calling a provider.
    entries.push({
      type: "message",
      id: "fixture1",
      parentId: entries.at(-1).id ?? null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "Restored fixture" }],
        timestamp: Date.now(),
      },
    });
    await mkdir(params.sessionDir, { recursive: true });
    await writeFile(
      join(params.sessionDir, "fixture.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const listed = await rpc("session.list", params);
    assert.ok(
      listed.some(
        (session) =>
          session.sessionId === created.persistedSessionId &&
          session.title === "Lifecycle test",
      ),
    );
    const restored = await rpc("session.resume", {
      ...params,
      sessionId: randomUUID(),
      persistedSessionId: created.persistedSessionId,
    });
    assert.equal(restored.persistedSessionId, created.persistedSessionId);
    assert.ok(
      restored.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some((item) => item.text === "Restored fixture"),
      ),
    );
    assert.equal(
      (await rpc("session.dispose", { sessionId: restored.sessionId }))
        .disposed,
      true,
    );
  },
);
