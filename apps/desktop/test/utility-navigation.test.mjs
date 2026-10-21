import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { usePluginBrowseState } = await import("../src/features/plugins/browse-state.ts");

const { selectActivityPage, ACTIVITY_NAVIGATION } = await import("../src/features/app/activity-navigation.ts");
const activitySource = readFileSync(new URL("../src/features/app/ActivityBar.tsx", import.meta.url), "utf8");

test("activity navigation keeps the requested order and makes active clicks a no-op", () => {
  assert.deepEqual(ACTIVITY_NAVIGATION.map((item) => item.page), ["chat", "workbench", "scheduled", "plugins"]);
  assert.match(activitySource, /aria-current=\{selected \? "page" : undefined\}/);
  assert.match(activitySource, /data-nav=\{item\.page\}/);
  const navigations = [];
  selectActivityPage("chat", "chat", (page) => navigations.push(page));
  selectActivityPage("chat", "workbench", (page) => navigations.push(page));
  assert.deepEqual(navigations, ["workbench"]);
});

test("Workbench route does not render Agent side surfaces", () => {
  const appShell = readFileSync(new URL("../src/features/app/AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShell, /page === "chat" && \(!sidebarCollapsed \|\| sidebarExiting\)/);
  assert.match(appShell, /page === "workbench" \? \([\s\S]*?<WorkbenchPage \/>/);
  assert.match(appShell, /page === "workbench"/);
  assert.match(readFileSync(new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url), "utf8"), /page === "workbench"/);
});

test("plugin browsing choices survive subscribers disconnecting without retaining dialogs or operations", () => {
  const before = usePluginBrowseState.getInitialState();
  try {
    const unsubscribe = usePluginBrowseState.subscribe(() => {});
    usePluginBrowseState.getState().setTab("market");
    usePluginBrowseState.getState().setQuery("browser");
    usePluginBrowseState.getState().setInstalledQuery("local");
    usePluginBrowseState.getState().setCategory("productivity");
    unsubscribe();
    const reopened = usePluginBrowseState.getState();
    assert.equal(reopened.tab, "market");
    assert.equal(reopened.query, "browser");
    assert.equal(reopened.installedQuery, "local");
    assert.equal(reopened.category, "productivity");
    assert.deepEqual(Object.keys(reopened).filter((key) => typeof reopened[key] !== "function").sort(),
      ["category", "installedQuery", "query", "tab"]);
  } finally { usePluginBrowseState.setState(before, true); }
});

test("activity navigation preserves the active Agent workspace through every destination", async () => {
  const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");
  const runningSessions = { "session-a": true };
  const draftConfiguration = { mode: "agent", modelId: "local-model" };
  let intents = 0;
  let state = {
    page: "chat", activeSessionId: "session-a", runningSessions, draftConfiguration,
    navStack: [{ page: "chat", sessionId: "session-a" }], navIndex: 0,
  };
  const actions = createInteractionSlice({
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    runtime: { beginNavigationIntent: () => ++intents },
    interactionRuntime: {},
  });
  state = { ...state, ...actions };
  for (const page of ["chat", "workbench", "scheduled", "plugins", "settings", "chat"]) {
    selectActivityPage(state.page, page, actions.setPage);
    const stack = state.navStack;
    const before = intents;
    selectActivityPage(state.page, page, actions.setPage);
    assert.equal(intents, before);
    assert.equal(state.navStack, stack);
    assert.equal(state.page, page);
    assert.equal(state.activeSessionId, "session-a");
    assert.equal(state.runningSessions, runningSessions);
    assert.equal(state.draftConfiguration, draftConfiguration);
  }
  assert.deepEqual(state.navStack.map((entry) => entry.page), ["chat", "workbench", "scheduled", "plugins", "settings", "chat"]);
});
