import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const globalStyles = await loadStyles();
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);

test("the Agent sidebar does not imply a user identity", () => {
  // The app has no accounts; an avatar with a name implied one that never existed.
  assert.doesNotMatch(sidebarSource, /footer-profile/);
  assert.doesNotMatch(sidebarSource, /profile-menu/);
  assert.doesNotMatch(sidebarSource, /sidebar-profile-menu/);
  assert.doesNotMatch(sidebarSource, /IconUser/);
  assert.doesNotMatch(globalStyles, /\.footer-profile/);
  assert.doesNotMatch(globalStyles, /\.profile-menu/);
  for (const locale of [zhLocale, enLocale]) {
    assert.doesNotMatch(locale, /localProfile:/);
    assert.doesNotMatch(locale, /openProfileMenu:/);
  }
});

test("Agent sidebar has no legacy footer navigation or version chip", () => {
  assert.doesNotMatch(sidebarSource, /className="sidebar-footer no-drag"/);
  assert.doesNotMatch(sidebarSource, /footer-build/);
  assert.doesNotMatch(globalStyles, /\.footer-build/);
  assert.doesNotMatch(globalStyles, /\.footer-action/);
});

test("Activity Bar owns navigation, notifications and settings", async () => {
  const activitySource = await readFile(
    new URL("../src/features/app/ActivityBar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(activitySource, /ACTIVITY_NAVIGATION\.map/);
  assert.match(activitySource, /<NotificationCenter/);
  assert.match(activitySource, /data-nav="settings"/);
  assert.doesNotMatch(activitySource, /footer-build/);
});
