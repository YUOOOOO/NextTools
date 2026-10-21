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
