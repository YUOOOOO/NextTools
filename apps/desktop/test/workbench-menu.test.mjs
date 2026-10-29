import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("../src/pages/WorkbenchPage.tsx", import.meta.url),
  "utf8",
);
const menuSource = readFileSync(
  new URL("../src/features/workbench/WorkbenchMenu.tsx", import.meta.url),
  "utf8",
);
const styleSource = readFileSync(
  new URL("../src/styles/activity-bar.css", import.meta.url),
  "utf8",
);

test("the Workbench page shows no page heading and no page status controls", () => {
  assert.doesNotMatch(pageSource, /<h1/);
  for (const key of [
    "workbench.closePage",
    "workbench.disable",
    "workbench.markUnavailable",
    "workbench.restore",
  ]) {
    assert.ok(!pageSource.includes(`"${key}"`), `${key} must not be rendered by the Workbench page`);
  }
  assert.doesNotMatch(pageSource, /workbench-page-actions/);
  assert.doesNotMatch(pageSource, /workbench-page-panel-heading/);
  assert.match(pageSource, /className="workbench-page-panel"/);
  assert.match(pageSource, /<PluginViewTab/);
});

test("every Workbench menu entry is one centered list row", () => {
  assert.doesNotMatch(menuSource, /<Button/);
  const rows = menuSource.match(/className="workbench-menu-item"/g) ?? [];
  const buttons = menuSource.match(/<button/g) ?? [];
  assert.ok(buttons.length >= 3);
  assert.equal(rows.length, buttons.length);
  const block = styleSource.match(/\.workbench-menu-item \{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(block, /justify-content: center;/);
  assert.match(block, /text-align: center;/);
  assert.doesNotMatch(block, /text-align: start;/);
});

test("the stylesheet keeps no rules for the removed Workbench page chrome", () => {
  assert.doesNotMatch(styleSource, /\.workbench-page h1/);
  assert.doesNotMatch(styleSource, /\.workbench-page-panel-heading/);
  assert.doesNotMatch(styleSource, /\.workbench-page-actions/);
});
