// Real browser + real HTTP/Hub; only the desktop/model boundary is a fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSyncServer } from "../dist/http.js";

const executable = process.env.CLOUD_TEST_BROWSER;
if (!executable) throw new Error("Set CLOUD_TEST_BROWSER to a Chrome/Chromium executable; build this package first");
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "cloud-console-browser-"));
const db = new DatabaseSync(":memory:");
const server = createSyncServer({ db, accounts: new Map() });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "about:blank"], { stdio: "ignore", windowsHide: true });
let socket, computer;
const pending = new Map();
let sequence = 0;
let browserError;
browser.on("error", (error) => { browserError = error; });
const delay = () => new Promise((resolve) => setTimeout(resolve, 40));
async function until(read, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (browserError) throw browserError;
    const result = await read();
    if (result) return result;
    await delay();
  }
  throw new Error(message);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
const visible = (selector) => until(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `Missing UI: ${selector}`);
async function fill(selector, value) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
}
async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
try {
  const activePort = await until(async () => {
    try { return (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { return null; }
  }, "Browser did not start");
  const target = await (await fetch(`http://127.0.0.1:${activePort}/json/new?about:blank`, { method: "PUT" })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data)); const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: base + "/app/" });
  await visible("#ident");
  await fill("#ident", "browser-user"); await fill("#pw", "fixture-password");
  await click(".signin .btn.ghost"); await visible(".main");
  const login = await fetch(base + "/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "browser-user", password: "fixture-password", device: "Fixture desktop" }) });
  const session = await login.json(); assert.equal(login.status, 200);
  computer = new WebSocket(base.replace("http", "ws") + "/v1/hub");
  const welcomed = new Promise((resolve) => computer.addEventListener("message", ({ data }) => { if (JSON.parse(String(data)).type === "welcome") resolve(); }));
  computer.addEventListener("open", () => computer.send(JSON.stringify({ type: "hello", key: session.token, device: { id: "browser-fixture", kind: "computer", name: "Pilot fixture", os: "test", actions: ["task", "stop"] } })));
  let waitingTask;
  const taskConversations = [];
  const stoppedConversations = [];
  computer.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data)); if (frame.type !== "call") return;
    if (frame.action === "task") {
      taskConversations.push(frame.args.conversation);
      if (frame.args.text === "wait for stop") { waitingTask = frame.id; return; }
      computer.send(JSON.stringify({ type: "event", id: frame.id, body: { stage: "tool", name: "fixture", summary: "isolated browser test" } }));
      computer.send(JSON.stringify({ type: "result", id: frame.id, ok: true, body: { text: "Fixture completed: " + frame.args.text } }));
    } else if (frame.action === "stop") {
      stoppedConversations.push(frame.args.conversation);
      computer.send(JSON.stringify({ type: "result", id: waitingTask, ok: false, error: "cancelled", message: "cancelled" }));
      computer.send(JSON.stringify({ type: "result", id: frame.id, ok: true, body: { stopped: true } }));
    }
  });
  await welcomed;
  await until(() => evaluate("document.querySelector('.devices')?.textContent.includes('Pilot fixture')"), "Device missing");
  await evaluate("localStorage.setItem('nm.conv.browser-user.browser-fixture', 'web-legacy-conversation'); localStorage.setItem('nm.chat.browser-user.browser-fixture', JSON.stringify([{role:'me',text:'Legacy saved question'},{role:'them',text:'Legacy saved answer'}]))");
  await click(".devices button"); await visible(".composer textarea");
  assert(await evaluate("document.querySelector('.messages').textContent.includes('Legacy saved answer')"), "Legacy single-conversation history was lost");
  await fill(".composer textarea", "hello from browser"); await click(".composer .box button");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Fixture completed: hello from browser')"), "Final answer missing");
  const firstConversation = taskConversations[0];
  assert.equal(firstConversation, "web-legacy-conversation");
  await click(".head .new-conversation");
  assert.equal(await evaluate("document.querySelector('.messages').textContent.includes('hello from browser')"), false);
  await fill(".composer textarea", "second independent task"); await click(".composer .box button");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Fixture completed: second independent task')"), "Second conversation answer missing");
  const secondConversation = taskConversations[1];
  assert.notEqual(firstConversation, secondConversation);
  assert.equal(await evaluate("document.querySelector('.messages').textContent.includes('hello from browser')"), false);
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  assert(await evaluate("document.querySelector('.messages').textContent.includes('Fixture completed: hello from browser')"));
  assert.equal(await evaluate("document.querySelector('.messages').textContent.includes('second independent task')"), false);
  await evaluate(`document.querySelector('[data-conversation="${secondConversation}"]').click()`);
  await fill(".composer textarea", "wait for stop"); await click(".composer .box button"); await visible(".composer .stop");
  // Switch away from a live task: its stop control and result belong to its conversation.
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  assert.equal(await evaluate("!!document.querySelector('.composer .stop')"), false);
  await evaluate(`document.querySelector('[data-conversation="${secondConversation}"]').click()`);
  await click(".composer .stop");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('cancelled')"), "Stop did not settle task");
  assert.equal(stoppedConversations.at(-1), secondConversation);
  await cdp("Page.reload"); await visible(".web-conversations");
  assert.equal(await evaluate("document.querySelectorAll('.conversation-entry').length"), 2);
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  assert(await evaluate("document.querySelector('.messages').textContent.includes('Fixture completed: hello from browser')"));
  await evaluate(`document.querySelector('[data-conversation="${secondConversation}"]').click()`);
  assert(await evaluate("document.querySelector('.messages').textContent.includes('Fixture completed: second independent task')"));
  // Real desktop client + automatic scheduler upload to the real cloud store.
  const uploadRoot = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "cloud-upload-"));
  let cloudClient, automatic;
  try {
    const { createConversationSync } = await import("../../../apps/desktop/electron/main/conversation-sync-client.mjs");
    const { createConversationAutoSync } = await import("../../../apps/desktop/electron/main/conversation-auto-sync.mjs");
    const jobs = new Map(); let nextJob = 0;
    cloudClient = createConversationSync({
      filePath: join(uploadRoot, "session.json"), encrypt: (x) => x, decrypt: (x) => x, encryptionAvailable: () => true,
      listSessions: async () => [{ id: "browser-synced-session", title: "Desktop cloud history", messages: [
        { id: "browser-cloud-user", role: "user", content: "Persist this desktop question", createdAt: "2026-01-01T00:00:00Z" },
        { id: "browser-cloud-assistant", role: "assistant", content: "Persisted desktop answer", createdAt: "2026-01-01T00:00:01Z" },
      ] }],
    });
    await cloudClient.signIn({ baseUrl: base, account: "browser-user", password: "fixture-password" });
    automatic = createConversationAutoSync({ sync: cloudClient, onError: (e) => { throw e; },
      setTimer(fn) { const id = ++nextJob; jobs.set(id, fn); return id; }, clearTimer(id) { jobs.delete(id); } });
    automatic.start(); const [jobId, run] = jobs.entries().next().value; jobs.delete(jobId); await run();
    await until(() => evaluate("document.querySelector('.cloud-conversations')?.textContent.includes('Desktop cloud history')"), "Automatic desktop upload did not reach browser");
    await click(".cloud-conversations button");
    await until(() => evaluate("document.querySelector('.cloud-messages')?.textContent.includes('Persisted desktop answer')"), "Synced messages missing");
    await evaluate("Object.keys(localStorage).filter(k => k.startsWith('nm.chat.') || k.startsWith('nm.conv.')).forEach(k => localStorage.removeItem(k))");
    await cdp("Page.reload");
    await until(() => evaluate("document.querySelector('.cloud-conversations')?.textContent.includes('Desktop cloud history')"), "Cloud history missing after reload");
    await click(".cloud-conversations button");
    await until(() => evaluate("document.querySelector('.cloud-messages')?.textContent.includes('Persisted desktop answer')"), "History depended on localStorage");
    const page = await fetch(base + "/v1/sync/changes?since=0&tail=200", { headers: { authorization: `Bearer ${session.token}` } });
    const saved = await page.json(); assert.equal(saved.messages.length, 2);
  } finally { automatic?.dispose(); await cloudClient?.signOut(); await rm(uploadRoot, { recursive: true, force: true }); }
  await click(".foot button"); await visible(".sheet .identity");
  const accountText = await evaluate("document.querySelector('.sheet').textContent");
  assert(accountText.includes("browser-user"));
  assert(!accountText.includes("not_found"));
  assert(!accountText.includes("Help improve nanoMuse"));
  assert(!accountText.includes("帮助改进 nanoMuse"));
  await evaluate("Array.from(document.querySelectorAll('.sheet button')).find(el => /Change password|修改密码/.test(el.textContent)).click()");
  await visible(".dialog input[autocomplete='current-password']");
  await fill(".dialog input[autocomplete='current-password']", "fixture-password");
  await evaluate("Array.from(document.querySelectorAll('.dialog input[autocomplete=new-password]')).forEach(el => {el.value='fixture-password-2'})");
  await click(".dialog .acts button:last-child"); await visible(".sheet .identity");
  const updated = await fetch(base + "/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "browser-user", password: "fixture-password-2" }) });
  assert.equal(updated.status, 200);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile layout overflows");
  if (process.env.CLOUD_TEST_SCREENSHOT) {
    const image = await cdp("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.CLOUD_TEST_SCREENSHOT, Buffer.from(image.data, "base64"));
  }
  await evaluate("Array.from(document.querySelectorAll('.sheet button')).find(el => /^(Sign out|退出登录)$/.test(el.textContent.trim())).click()");
  await visible(".dialog"); await click(".dialog .acts button:last-child"); await visible("#ident");
  await fill("#ident", "second-browser-user"); await fill("#pw", "fixture-password");
  await click(".signin .btn.ghost"); await visible(".main");
  await until(() => evaluate("!!document.querySelector('.cloud-conversations')"), "Second account cloud list missing");
  assert.equal(await evaluate("document.querySelector('.cloud-conversations').textContent.includes('Desktop cloud history')"), false);
  console.log("PASS: browser register → multiple isolated conversations → switch → stop → reload → task → automatic desktop upload → cloud history → reload recovery → account → password → mobile layout → account isolation");
} finally {
  computer?.close();
  if (socket?.readyState === 1) { try { await cdp("Browser.close"); } catch {} }
  socket?.close(); browser.kill();
  for (const request of pending.values()) clearTimeout(request.timer);
  await new Promise((resolve) => server.close(resolve)); db.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
