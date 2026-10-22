import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkbenchCommand,
  closeWorkbenchPage,
  createWorkbenchSession,
  openWorkbenchPage,
  restoreWorkbenchSession,
  selectWorkbenchPage,
  setWorkbenchPageStatus,
  parseWorkbenchSlash,
} from "../src/features/workbench/workbench-session.ts";
test("workbench session opens, switches, closes, and recovers pages", () => {
  const initial = createWorkbenchSession();
  const opened = openWorkbenchPage(initial, "example");
  assert.deepEqual(opened.openIds, ["overview", "example"]);
  assert.equal(opened.activeId, "example");

  const selected = selectWorkbenchPage(opened, "overview");
  assert.equal(selected.activeId, "overview");
  const closed = closeWorkbenchPage(selected, "overview");
  assert.deepEqual(closed.openIds, ["example"]);
  assert.equal(closed.pages.overview.status, "ready");

  const disabled = setWorkbenchPageStatus(opened, "example", "disabled");
  assert.equal(disabled.pages.example.status, "disabled");
  const restored = setWorkbenchPageStatus(disabled, "example", "ready");
  assert.equal(restored.pages.example.status, "ready");
  assert.equal(openWorkbenchPage(initial, "missing"), initial);
});

test("workbench restoration keeps page data and drops unknown pages", () => {
  const session = applyWorkbenchCommand(createWorkbenchSession(), {
    action: "open",
    id: "example",
  });
  const disabled = applyWorkbenchCommand(session, {
    action: "setStatus",
    id: "example",
    status: "disabled",
  });
  const restored = restoreWorkbenchSession({
    ...disabled,
    pages: { ...disabled.pages, foreign: { id: "foreign", titleKey: "nope", status: "ready" } },
    openIds: ["foreign", "example"],
    activeId: "foreign",
  });
  assert.equal(restored.pages.foreign, undefined);
  assert.equal(restored.pages.example.status, "disabled");
  assert.deepEqual(restored.openIds, ["example"]);
  assert.equal(restored.activeId, "example");
  assert.equal(restoreWorkbenchSession(null).activeId, "overview");
});

test("workbench slash body uses the same page commands", () => {
  assert.deepEqual(parseWorkbenchSlash(""), { kind: "show" });
  assert.deepEqual(parseWorkbenchSlash("open example"), {
    kind: "command",
    command: { action: "open", id: "example" },
  });
  assert.deepEqual(parseWorkbenchSlash("disable example"), {
    kind: "command",
    command: { action: "setStatus", id: "example", status: "disabled" },
  });
  assert.deepEqual(parseWorkbenchSlash("open foreign"), {
    kind: "command",
    command: { action: "open", id: "foreign" },
  });
  assert.deepEqual(parseWorkbenchSlash("nope"), { kind: "error", error: "missing id" });
});

test("workbench tool uses the same command service and rejects unknown pages", async () => {
  const { executeWorkbenchTool } = await import("../src/features/workbench/workbench-session.ts");
  const opened = executeWorkbenchTool({ action: "open", id: "example" });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.activeId, "example");
  const disabled = executeWorkbenchTool({ action: "setStatus", id: "example", status: "disabled" });
  assert.equal(disabled.ok, true);
  if (!disabled.ok) return;
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(executeWorkbenchTool({ action: "open", id: "foreign" }), {
    ok: false,
    error: "unknown page",
  });
});

test("disabling a workbench page releases its resources and keeps the record", async () => {
  const { executeWorkbenchTool, retainWorkbenchPage } = await import(
    "../src/features/workbench/workbench-session.ts"
  );
  executeWorkbenchTool({ action: "open", id: "example" });
  executeWorkbenchTool({ action: "setStatus", id: "example", status: "ready" });
  let released = 0;
  retainWorkbenchPage("example", () => {
    released += 1;
  });
  const disabled = executeWorkbenchTool({ action: "setStatus", id: "example", status: "disabled" });
  assert.equal(disabled.ok, true);
  assert.equal(released, 1);
  const again = executeWorkbenchTool({ action: "setStatus", id: "example", status: "disabled" });
  assert.equal(again.ok, true);
  assert.equal(released, 1);
});

test("workbench host session is authoritative and local fallback remains", async () => {
  const {
    disconnectWorkbenchHost,
    hydrateWorkbenchFromHost,
    runWorkbenchCommand,
    WORKBENCH_SESSION_KEY,
  } = await import("../src/features/workbench/workbench-session.ts");
  const memory = new Map();
  const store = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  memory.set(
    WORKBENCH_SESSION_KEY,
    JSON.stringify({
      pages: {
        overview: { id: "overview", status: "ready" },
        example: { id: "example", status: "disabled" },
      },
      openIds: ["overview", "example"],
      activeId: "example",
    }),
  );
  let imports = 0;
  const host = {
    get: async (migrate) => {
      if (migrate) imports += 1;
      return {
        session: migrate ?? {
          pages: { overview: { id: "overview", status: "ready" } },
          openIds: ["overview"],
          activeId: "overview",
        },
        stored: false,
      };
    },
    apply: async () => ({ ok: false, error: "unknown page" }),
  };
  assert.equal(await hydrateWorkbenchFromHost(host), "host");
  assert.equal(imports, 1);
  assert.equal(memory.has(WORKBENCH_SESSION_KEY), false);
  assert.equal(await hydrateWorkbenchFromHost(host), "host");
  assert.equal(imports, 1);
  assert.deepEqual(await runWorkbenchCommand({ action: "open", id: "foreign" }), {
    ok: false,
    error: "unknown page",
  });

  memory.set(WORKBENCH_SESSION_KEY, "{\"pages\":{}}");
  assert.equal(
    await hydrateWorkbenchFromHost({
      get: async () => {
        throw new Error("host unavailable");
      },
      apply: async () => {
        throw new Error("host unavailable");
      },
    }),
    "local",
  );
  assert.equal(memory.has(WORKBENCH_SESSION_KEY), true);
  const opened = await runWorkbenchCommand({ action: "open", id: "example" });
  assert.equal(opened.ok, true);
  disconnectWorkbenchHost();
});

test("contributed workbench pages stay disabled without being deleted", () => {
  const restored = restoreWorkbenchSession({
    pages: {
      overview: { id: "overview", titleKey: "workbench.title", status: "ready" },
      "pi.demo/board": {
        id: "pi.demo/board",
        title: "Board",
        status: "disabled",
        pluginId: "pi.demo",
        viewId: "board",
        available: false,
      },
      foreign: { id: "foreign", status: "ready" },
    },
    openIds: ["overview", "pi.demo/board"],
    activeId: "pi.demo/board",
  });
  assert.equal(restored.pages["pi.demo/board"].status, "disabled");
  assert.equal(restored.pages["pi.demo/board"].pluginId, "pi.demo");
  assert.equal("foreign" in restored.pages, false);
  const ready = applyWorkbenchCommand(restored, {
    action: "setStatus",
    id: "pi.demo/board",
    status: "ready",
  });
  assert.equal(ready.pages["pi.demo/board"].status, "ready");
  assert.equal(ready.pages["pi.demo/board"].viewId, "board");
});
