import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbenchServiceRegistry, declaredWorkbenchServiceNames } from "../electron/main/workbench-service.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

async function fixture(t, example = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-workbench-service-"));
  const abortMarker = join(dir, "aborted");
  const manifest = {
    schemaVersion: 1, id: "demo.shared", name: "Shared fixture", version: "0.1.0", main: "main.cjs",
    permissions: ["ui.view", "agent.tool.register"],
    contributes: { workbenchServices: [{ name: "counter", description: "Count shared calls" }] },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "main.cjs"), `let count = 0;
let aborted = 0;
module.exports.onLoad = async () => {
  await pi.workbench.registerService({
    name: "counter", description: "Count shared calls",
    execute: async (args, { signal }) => {
      if (args.wait) {
        const pending = new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted++;
            if (args.markAbort) require("node:fs").writeFileSync(${JSON.stringify(abortMarker)}, "aborted");
            reject(signal.reason);
          }, { once: true });
        });
        console.log("service-ready");
        return pending;
      }
      return { count: ++count, aborted };
    },
  });
};`);
  const ready = [];
  let nextReady;
  const runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        if (!data.includes("service-ready")) return;
        if (nextReady) { nextReady(); nextReady = undefined; }
        else ready.push(true);
      });
      return {
        postMessage: (message) => { if (child.connected) child.send(message); },
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    await runtime.unload(manifest.id);
    rmSync(dir, { recursive: true, force: true });
  });
  const source = example ? fileURLToPath(new URL("../../../examples/plugins/workbench-data-lab/", import.meta.url)) : dir;
  const loadedManifest = example ? JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) : manifest;
  if (example) t.after(() => runtime.unload(loadedManifest.id));
  await runtime.loadFromPath(source, loadedManifest.permissions);
  return {
    runtime,
    tool: runtime.getTools().find((entry) => entry.name === (example ? "data" : "counter")),
    page: (args) => runtime.invokePanelBridge(loadedManifest.id, "workbench.service", { name: example ? "data" : "counter", args }),
    started: () => ready.shift() ? Promise.resolve() : new Promise((resolve) => { nextReady = resolve; }),
    abortMarker,
  };
}

test("Workbench and Agent increment the same counter", { timeout: 15000 }, async (t) => {
  const { tool, page } = await fixture(t, true);
  const context = { sessionId: "fixture-session", mode: "agent" };
  assert.deepEqual(await page({}), { counter: 0, revision: 0 });
  assert.deepEqual(await page({ action: "increment" }), { counter: 1, revision: 1 });
  assert.deepEqual(await tool.execute({ action: "get" }, context), { counter: 1, revision: 1 });
  assert.deepEqual(await tool.execute({ action: "increment" }, context), { counter: 2, revision: 2 });
  assert.deepEqual(await page({}), { counter: 2, revision: 2 });
  await assert.rejects(page({ action: "increment", delta: 1.5 }), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(await page({}), { counter: 2, revision: 2 });
  assert.deepEqual(await page({ action: "reset" }), { counter: 0, revision: 3 });
  assert.deepEqual(await tool.execute({ action: "get" }, context), { counter: 0, revision: 3 });
});

test("page and Agent invoke one plugin handler and unload revokes both entries", { timeout: 15000 }, async (t) => {
  const { runtime, tool, page } = await fixture(t);
  assert.deepEqual(await page({}), { count: 1, aborted: 0 });
  assert.deepEqual(await tool.execute({}, { sessionId: "fixture-session", mode: "agent" }), { count: 2, aborted: 0 });
  assert.deepEqual(await page({}), { count: 3, aborted: 0 });
  await assert.rejects(runtime.invokePanelBridge("demo.shared", "workbench.service", { name: "missing" }), { code: "NOT_FOUND" });
  await runtime.unload("demo.shared");
  assert.equal(runtime.getTools().some((entry) => entry.name === "counter"), false);
  await assert.rejects(page({}), { code: "NOT_FOUND" });
  await assert.rejects(tool.execute({}, { sessionId: "fixture-session" }), { code: "NOT_FOUND" });
});

test("Agent cancellation reaches the shared handler and leaves the page usable", { timeout: 15000 }, async (t) => {
  const { tool, page, started } = await fixture(t);
  const controller = new AbortController();
  const result = tool.execute({ wait: true }, { sessionId: "fixture-session", signal: controller.signal });
  const rejected = assert.rejects(result, /stop shared call/);
  await started();
  controller.abort(new Error("stop shared call"));
  await rejected;
  assert.deepEqual(await page({}), { count: 1, aborted: 1 });
});

test("unload cancels an active page service", { timeout: 15000 }, async (t) => {
  const { runtime, page, started, abortMarker } = await fixture(t);
  const rejected = assert.rejects(page({ wait: true, markAbort: true }));
  await started();
  await runtime.unload("demo.shared");
  await rejected;
  assert.equal(existsSync(abortMarker), true);
});

test("duplicate registration preserves the first handler and clear removes it", () => {
  const registry = createWorkbenchServiceRegistry();
  registry.register("counter", () => "original");
  assert.throws(() => registry.register("counter", () => "replacement"), { code: "CONFLICT" });
  assert.equal(registry.call("counter", {}), "original");
  registry.clear();
  assert.throws(() => registry.call("counter", {}), { code: "NOT_FOUND" });
});

test("declared workbench service names come from the manifest", () => {
  const names = declaredWorkbenchServiceNames({ contributes: { workbenchServices: [{ name: "counter" }, { name: "" }, null] } });
  assert.deepEqual([...names], ["counter"]);
});
