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
  const helloComputer = () => computer.send(JSON.stringify({ type: "hello", key: session.token, device: { id: "browser-fixture", kind: "computer", name: "Pilot fixture", os: "test", actions: ["task", "stop", "interactive.list", "interactive.resolve"] } }));
  computer.addEventListener("open", helloComputer);
  let waitingTask;
  const taskConversations = [];
  const taskArguments = [];
  const stoppedConversations = [];
  const stoppedArguments = [];
  const cardsByConversation = new Map(), interactiveLists = [], resolutions = [];
  let holdSnapshot = false, delayedSnapshot, holdResolution = false, delayedResolution;
  let resolutionError = "";
  const sendResult = (id, body) => computer.send(JSON.stringify({ type: "result", id, ok: true, body }));
  const computerMessage = ({ data }) => {
    const frame = JSON.parse(String(data)); if (frame.type !== "call") return;
    if (frame.action === "interactive.list") {
      interactiveLists.push(frame.args);
      const body = { cards: structuredClone(cardsByConversation.get(frame.args.conversation) || []) };
      if (holdSnapshot) { holdSnapshot = false; delayedSnapshot = () => sendResult(frame.id, body); return; }
      sendResult(frame.id, body);
    } else if (frame.action === "interactive.resolve") {
      resolutions.push(frame.args);
      if (resolutionError) { const error = resolutionError; resolutionError = ""; computer.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error })); return; }
      const finish = () => { cardsByConversation.set(frame.args.conversation, (cardsByConversation.get(frame.args.conversation) || []).filter(c => c.id !== frame.args.id)); sendResult(frame.id, { ok: true }); };
      if (holdResolution) { holdResolution = false; delayedResolution = finish; return; }
      finish();
    } else if (frame.action === "task") {
      taskConversations.push(frame.args.conversation);
      taskArguments.push(frame.args);
      computer.send(JSON.stringify({ type: "event", id: frame.id, body: { stage: "session", sessionId: frame.args.sessionId || "host-" + frame.args.conversation } }));
      if (frame.args.text === "wait for stop") { waitingTask = frame.id; return; }
      computer.send(JSON.stringify({ type: "event", id: frame.id, body: { stage: "tool", name: "fixture", summary: "isolated browser test" } }));
      computer.send(JSON.stringify({ type: "result", id: frame.id, ok: true, body: { text: "Fixture completed: " + frame.args.text } }));
    } else if (frame.action === "stop") {
      stoppedConversations.push(frame.args.conversation);
      stoppedArguments.push(frame.args);
      computer.send(JSON.stringify({ type: "result", id: waitingTask, ok: false, error: "cancelled", message: "cancelled" }));
      computer.send(JSON.stringify({ type: "result", id: frame.id, ok: true, body: { stopped: true } }));
    }
  };
  computer.addEventListener("message", computerMessage);
  await welcomed;
  await until(() => evaluate("document.querySelector('.devices')?.textContent.includes('Pilot fixture')"), "Device missing");
  await evaluate("localStorage.setItem('nm.conv.browser-user.browser-fixture', 'web-legacy-conversation'); localStorage.setItem('nm.chat.browser-user.browser-fixture', JSON.stringify([{role:'me',text:'Legacy saved question'},{role:'them',text:'Legacy saved answer'}]))");
  await click(".devices button"); await visible(".composer textarea");
  assert.equal(await evaluate("document.querySelector('.head').textContent.includes('null')"), false);
  assert.equal(await evaluate("document.documentElement.dataset.consoleVersion"), "1.1.0-sidebar-cards");
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
  await fill(".composer textarea", "keep my busy draft");
  await evaluate("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}))");
  assert.equal(await evaluate("document.querySelector('.composer textarea').value"), "keep my busy draft");
  const runningAlias = await fetch(base + "/v1/sync/changes", {method:"POST",headers:{authorization:`Bearer ${session.token}`,"content-type":"application/json"},body:JSON.stringify({device:"browser-fixture",conversations:[{
    cid:"host-"+secondConversation,kind:"side",title:"Running Web alias",execution_device:"browser-fixture",session_id:"host-"+secondConversation,created_at:1700000000,updated_at:1700000000
  }],messages:[]})}); assert.equal(runningAlias.status,200);
  await until(() => evaluate(`!!document.querySelector('[data-cloud-conversation="host-${secondConversation}"]')`), "Running synced alias missing");
  await click('[data-cloud-conversation="host-' + secondConversation + '"]');
  // Switch away from a live task: its stop control and result belong to its conversation.
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  assert.equal(await evaluate("!!document.querySelector('.composer .stop')"), false);
  await evaluate(`document.querySelector('[data-conversation="${secondConversation}"]').click()`);
  await click(".composer .stop");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('cancelled')"), "Stop did not settle task");
  assert.equal(stoppedConversations.at(-1), secondConversation);
  assert.equal(stoppedArguments.at(-1).sessionId, undefined, "Synced alias changed the original running task stop key");
  await cdp("Page.reload"); await visible(".web-conversations");
  assert.equal(await evaluate("document.querySelectorAll('.conversation-entry').length"), 2);
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  assert(await evaluate("document.querySelector('.messages').textContent.includes('Fixture completed: hello from browser')"));
  await evaluate(`document.querySelector('[data-conversation="${secondConversation}"]').click()`);
  assert(await evaluate("document.querySelector('.messages').textContent.includes('Fixture completed: second independent task')"));
  // Desktop continuation must update the current Web conversation, not just a separate cloud list.
  const upload = async (rows) => {
    const response = await fetch(base + "/v1/sync/changes", { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ device: "browser-fixture", conversations: [{ cid: "host-" + firstConversation, kind: "side", title: "Roundtrip", project_id: "project-alpha", project_name: "Alpha", execution_device: "browser-fixture", session_id: "host-" + firstConversation, created_at: 1700000000, updated_at: 1700000010 }], messages: rows }) });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).rejected, []);
  };
  const empty = await fetch(base + "/v1/sync/changes", { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ device: "browser-fixture", conversations: [{ cid: "empty-project-session", kind: "side", title: "Empty project conversation", project_id: "project-beta", project_name: "Beta", execution_device: "browser-fixture", session_id: "empty-host-session", created_at: 1700000000, updated_at: 1700000000 }], messages: [] }) });
  assert.equal(empty.status, 200);
  await until(() => evaluate("document.querySelector('.cloud-conversations')?.textContent.includes('Empty project conversation')"), "Empty project conversation was omitted by message tail");
  const original = [{ mid: "roundtrip-web-user", cid: "host-" + firstConversation, role: "user", text: "hello from browser", created_at: 1700000000 },
    { mid: "roundtrip-web-answer", cid: "host-" + firstConversation, role: "assistant", text: "Fixture completed: hello from browser", created_at: 1700000001 }];
  await upload(original);
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  await upload([...original, { mid: "roundtrip-desktop-user", cid: "host-" + firstConversation, role: "user", text: "Desktop follow-up", created_at: 1700000002 },
    { mid: "roundtrip-desktop-answer", cid: "host-" + firstConversation, role: "assistant", text: "Desktop continuation answer", created_at: 1700000003 }]);
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Desktop continuation answer')"), "Desktop continuation missing from active Web conversation");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.messages .bubble')).filter(el => el.textContent === 'Fixture completed: hello from browser').length"), 1);
  await evaluate(`document.querySelector('[data-conversation="${secondConversation}"]').click()`);
  assert.equal(await evaluate("document.querySelector('.messages').textContent.includes('Desktop follow-up')"), false);
  await cdp("Page.reload"); await visible(".web-conversations");
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Desktop continuation answer')"), "Desktop continuation missing after reload");
  await until(() => evaluate("document.querySelectorAll('.cloud-project-group').length >= 2"), "Project groups missing");
  assert(await evaluate("document.querySelector('[data-project=project-alpha]').textContent.includes('Alpha')"));
  assert(await evaluate("document.querySelector('[data-project=project-beta]').textContent.includes('Beta')"));
  const differentIds = await fetch(base + "/v1/sync/changes", {method:"POST",headers:{authorization:`Bearer ${session.token}`,"content-type":"application/json"},body:JSON.stringify({device:"browser-fixture",conversations:[],messages:[{
    mid:"different-id-history",cid:"empty-project-session",role:"assistant",text:"History with a different Host id",created_at:1700000001
  }]})}); assert.equal(differentIds.status,200);
  await click('[data-cloud-conversation="empty-project-session"]');
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('History with a different Host id')"), "Cloud cid and Host id history lookup was mixed");
  await until(() => evaluate("document.querySelector('.composer textarea')?.disabled === false"), "Different-id composer disabled");
  await fill(".composer textarea","continue different host id"); await click(".composer .box button");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Fixture completed: continue different host id')"), "Different Host id continuation failed");
  assert.equal(taskArguments.at(-1).sessionId,"empty-host-session"); assert.equal(taskArguments.at(-1).cid,"empty-project-session");
  await click('[data-cloud-conversation="host-' + firstConversation + '"]');
  await until(() => evaluate("document.querySelector('.composer textarea')?.disabled === false"), "Shared project composer is disabled");
  await fill(".composer textarea", "continue from cloud project");
  // A sync refresh may rebuild the composer but must retain its draft.
  await upload(original);
  assert.equal(await evaluate("document.querySelector('.composer textarea').value"), "continue from cloud project");
  await click(".composer .box button");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Fixture completed: continue from cloud project')"), "Cloud project continuation failed");
  assert.equal(taskArguments.at(-1).sessionId, "host-" + firstConversation);
  assert.equal(taskArguments.at(-1).cid, "host-" + firstConversation);
  // Pending desktop tasks appear without a Web task being busy. Snapshots are
  // authoritative and contain opaque UI tokens, never raw Host request ids.
  const permission = (id) => ({ id, kind: "permission", toolName: "fixture-shell", preview: '<img src=x onerror="window.previewExecuted=true">', reason: "Fixture reason", risk: "system" });
  await click(".head .new-conversation");
  await fill(".composer textarea", "prepare regular interactive session"); await click(".composer .box button");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Fixture completed: prepare regular interactive session')"), "Regular session missing");
  const firstRoute = taskArguments.at(-1).conversation;
  cardsByConversation.set(firstRoute, [permission("opaque-allow")]);
  await visible(".interactive-card");
  assert(await evaluate("document.querySelector('.interactive-card').textContent.includes('Fixture reason')"));
  assert.equal(await evaluate("!!document.querySelector('.interactive-card img') || !!window.previewExecuted"), false);
  await fill(".composer textarea", "preserved interactive draft");
  holdResolution = true;
  await click(".interactive-card .yes");
  await until(() => delayedResolution, "Resolution was not received");
  assert.equal(await evaluate("document.querySelector('.interactive-card .yes').disabled"), true);
  await click(".interactive-card .yes");
  assert.equal(resolutions.filter(r => r.id === "opaque-allow").length, 1);
  delayedResolution(); delayedResolution = null;
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Successful permission did not disappear");
  assert.equal(resolutions.at(-1).decision, "allow-once");
  assert.equal(resolutions.at(-1).sessionId, undefined);
  assert.equal(resolutions.at(-1).cid, undefined);
  cardsByConversation.set(firstRoute, [permission("opaque-deny")]);
  await visible(".interactive-card"); await click(".interactive-card .btns button:last-child");
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Denied permission did not disappear");
  assert.equal(resolutions.at(-1).decision, "deny");
  cardsByConversation.set(firstRoute, [{ id: "opaque-ask", kind: "ask", questions: [
    { question: "Choose several", options: [{id:"option-one",label:"One"}, {id:"option-two",label:"Two",description:"Second option"}], multiSelect:true },
    { question: "Choose one", options: ["Yes", "No"] },
    { question: "Optional question", options: [] },
  ] }]);
  await visible(".interactive-card fieldset");
  await click('.interactive-card fieldset:nth-of-type(1) input[type=checkbox]');
  await evaluate("document.querySelectorAll('.interactive-card fieldset:nth-of-type(1) input[type=checkbox]')[1].click()");
  await fill('.interactive-card fieldset:nth-of-type(1) input[type=text]', "Custom detail");
  await click('.interactive-card fieldset:nth-of-type(2) input[type=radio]');
  await click('.interactive-card fieldset:nth-of-type(3) input[type=checkbox]');
  await evaluate("window.retainedAskInput = document.querySelector('.interactive-card input[type=text]')");
  const listCount = interactiveLists.length;
  await until(() => interactiveLists.length >= listCount + 2, "Selected idle session was not polled");
  assert.equal(await evaluate("window.retainedAskInput === document.querySelector('.interactive-card input[type=text]')"), true);
  assert.equal(await evaluate("document.querySelector('.interactive-card input[type=text]').value"), "Custom detail");
  assert.equal(await evaluate("document.querySelector('.composer textarea').value"), "preserved interactive draft");
  assert.equal(await evaluate("document.querySelectorAll('.interactive-card').length"), 1);
  await click(".interactive-card .yes");
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Ask did not settle");
  assert.deepEqual(resolutions.at(-1).answers, [[{option:"option-one"},{option:"option-two"},"Custom detail"],["Yes"],null]);
  cardsByConversation.set(firstRoute, [{ id: "custom-single", kind: "ask", questions: [{ question: "Custom single answer", options: ["Default"] }] }]);
  await visible(".interactive-card input[type=text]");
  await click(".interactive-card input[type=radio]");
  await fill(".interactive-card input[type=text]", "My own answer");
  resolutionError = "invalid_answer";
  await click(".interactive-card .yes");
  await until(() => evaluate("/Check your answers|请检查回答/.test(document.querySelector('.interactive-card')?.textContent || '')"), "Invalid answer error missing");
  assert.equal(await evaluate("document.querySelector('.interactive-card .yes').disabled"), false);
  assert.equal(await evaluate("document.querySelector('.interactive-card input[type=text]').value"), "My own answer");
  await click(".interactive-card .yes");
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Custom answer retry failed");
  assert.deepEqual(resolutions.at(-1).answers, [["My own answer"]]);
  cardsByConversation.set(firstRoute, [{ id: "skip-all", kind: "ask", questions: [{question:"Skip whole card",options:["One"]}] }]);
  await visible(".interactive-card"); await click(".interactive-card .btns button:last-child");
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Skip did not settle");
  assert.deepEqual(resolutions.at(-1).answers, [null]);
  assert.equal(await evaluate("Object.keys(localStorage).some(k => /opaque-ask|opaque-allow/.test(localStorage.getItem(k)))"), false, "Pending cards were persisted");
  cardsByConversation.set(firstRoute, [permission("desktop-resolves")]);
  await visible(".interactive-card");
  cardsByConversation.set(firstRoute, []);
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Desktop resolution was not reflected");
  cardsByConversation.set(firstRoute, [permission("expired")]);
  await visible(".interactive-card"); resolutionError = "card_expired"; cardsByConversation.set(firstRoute, []);
  await click(".interactive-card .yes");
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Expired card remained actionable");
  cardsByConversation.set(firstRoute, [permission("stale-secret")]); holdSnapshot = true;
  await until(() => delayedSnapshot, "Delayed snapshot was not captured");
  await click(".head .new-conversation");
  await fill(".composer textarea", "another interactive session"); await click(".composer .box button");
  await until(() => evaluate("document.querySelector('.messages')?.textContent.includes('Fixture completed: another interactive session')"), "Switched session missing");
  delayedSnapshot(); delayedSnapshot = null;
  const switchedLists = interactiveLists.length;
  await until(() => interactiveLists.length > switchedLists, "Switched session was not polled");
  assert.equal(await evaluate("document.querySelector('.interactive-cards').textContent.includes('fixture-shell')"), false, "Delayed snapshot leaked into another session");
  const regularConversation = taskArguments.at(-1).conversation;
  cardsByConversation.set(regularConversation, [permission("regular-route")]);
  await visible(".interactive-card");
  const regularRoute = interactiveLists.at(-1);
  assert.equal(regularRoute.conversation, regularConversation); assert.equal(regularRoute.sessionId, undefined); assert.equal(regularRoute.cid, undefined);
  await click(".interactive-card .yes");
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Regular permission did not settle");
  assert.equal(resolutions.at(-1).sessionId, undefined);
  cardsByConversation.set(firstRoute, []);
  await click('[data-cloud-conversation="host-' + firstConversation + '"]');
  await until(() => evaluate("document.querySelector('.composer textarea')?.disabled === false"), "Shared composer not restored");
  const sharedEntry = await evaluate("document.querySelector('.conversation-entry.active')?.dataset.conversation || localStorage.getItem('nm.conv.browser-user.browser-fixture')");
  cardsByConversation.set(sharedEntry, [permission("shared-route")]);
  await visible(".interactive-card"); await click(".interactive-card .yes");
  await until(() => evaluate("!document.querySelector('.interactive-card')"), "Shared permission did not settle");
  assert.equal(resolutions.at(-1).sessionId, "host-" + firstConversation);
  assert.equal(resolutions.at(-1).cid, "host-" + firstConversation);
  // Offline keeps history and a disabled composer; reconnect restores execution.
  computer.close();
  await until(() => evaluate("document.querySelector('.composer textarea')?.disabled === true"), "Offline project composer still enabled");
  assert(await evaluate("document.querySelector('.messages').textContent.includes('continue from cloud project')"));
  computer = new WebSocket(base.replace("http", "ws") + "/v1/hub");
  computer.addEventListener("open", helloComputer); computer.addEventListener("message", computerMessage);
  await until(() => evaluate("document.querySelector('.composer textarea')?.disabled === false"), "Reconnect did not enable same-session continuation");
  // Real desktop client + automatic scheduler upload to the real cloud store.
  const uploadRoot = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "cloud-upload-"));
  let cloudClient, automatic;
  try {
    const { createConversationSync } = await import("../../../apps/desktop/electron/main/conversation-sync-client.mjs");
    const { createConversationAutoSync } = await import("../../../apps/desktop/electron/main/conversation-auto-sync.mjs");
    const jobs = new Map(); let nextJob = 0;
    cloudClient = createConversationSync({
      deviceId: "browser-fixture", filePath: join(uploadRoot, "session.json"), encrypt: (x) => x, decrypt: (x) => x, encryptionAvailable: () => true,
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
    await evaluate("Array.from(document.querySelectorAll('.cloud-conversations button')).find(el => el.textContent.includes('Desktop cloud history')).click()");
    await until(() => evaluate("document.querySelector('.cloud-messages')?.textContent.includes('Persisted desktop answer')"), "Synced messages missing");
    await evaluate("Object.keys(localStorage).filter(k => k.startsWith('nm.chat.') || k.startsWith('nm.conv.')).forEach(k => localStorage.removeItem(k))");
    await cdp("Page.reload");
    await until(() => evaluate("document.querySelector('.cloud-conversations')?.textContent.includes('Desktop cloud history')"), "Cloud history missing after reload");
    await evaluate("Array.from(document.querySelectorAll('.cloud-conversations button')).find(el => el.textContent.includes('Desktop cloud history')).click()");
    await until(() => evaluate("document.querySelector('.cloud-messages')?.textContent.includes('Persisted desktop answer')"), "History depended on localStorage");
    cloudClient.queueDeleted(["browser-synced-session"]);
    await cloudClient.push();
    await until(()=>evaluate("!document.querySelector('[data-cloud-conversation=browser-synced-session]')"),"Deleted desktop session remained in cloud directory");
    await until(()=>evaluate("!document.querySelector('.messages')?.textContent.includes('Persisted desktop answer')"),"Deleted desktop transcript remained open");
    await cdp("Page.reload");
    await until(()=>evaluate("!!document.querySelector('.cloud-conversations')"),"Directory missing after deletion reload");
    assert.equal(await evaluate("!!document.querySelector('[data-cloud-conversation=browser-synced-session]')"),false);
    const page = await fetch(base + "/v1/sync/changes?since=0&tail=200", { headers: { authorization: `Bearer ${session.token}` } });
    const saved = await page.json(); assert.equal(saved.messages.filter((m) => m.cid === "browser-synced-session").length, 0);
  } finally { automatic?.dispose(); await cloudClient?.signOut(); await rm(uploadRoot, { recursive: true, force: true }); }
  // Many sessions must not push account controls outside the sidebar.
  const secondDevice = new WebSocket(base.replace("http", "ws") + "/v1/hub");
  const secondWelcome = new Promise(resolve => secondDevice.addEventListener("message", ({data}) => { if (JSON.parse(String(data)).type === "welcome") resolve(); }));
  secondDevice.addEventListener("open", () => secondDevice.send(JSON.stringify({type:"hello",key:session.token,device:{id:"second-desktop",kind:"computer",name:"Second desktop",actions:["task"]}})));
  await secondWelcome;
  const secondClosed = new Promise(resolve => secondDevice.addEventListener("close",resolve,{once:true})); secondDevice.close(); await secondClosed;
  async function addMany(device, prefix) {
    const response = await fetch(base + "/v1/sync/changes", {method:"POST",headers:{authorization:`Bearer ${session.token}`,"content-type":"application/json"},body:JSON.stringify({device,
      conversations:Array.from({length:80},(_,index)=>({cid:prefix+"-"+String(index).padStart(3,"0"),kind:"side",title:prefix+" conversation "+index,execution_device:device,session_id:prefix+"-"+String(index).padStart(3,"0"),project_id:prefix+"-project",project_name:prefix+" project",created_at:1700000000,updated_at:1700000000})),messages:[]})});
    assert.equal(response.status,200); assert.deepEqual((await response.json()).rejected,[]);
  }
  await addMany("browser-fixture","first-device"); await addMany("second-desktop","second-device");
  await until(()=>evaluate("document.querySelectorAll('.cloud-conversations [data-cloud-conversation]').length >= 80"),"First device history missing");
  assert.equal(await evaluate("document.querySelector('.cloud-conversations').textContent.includes('second-device conversation')"),false);
  await click('[data-device-id="second-desktop"]');
  await until(()=>evaluate("document.querySelectorAll('.cloud-conversations [data-cloud-conversation]').length === 80"),"Device filter did not replace history");
  assert(await evaluate("document.querySelector('.cloud-conversations').textContent.includes('second-device project')"));
  assert.equal(await evaluate("document.querySelector('.cloud-conversations').textContent.includes('first-device conversation')"),false);
  assert.equal(await evaluate("document.querySelector('[data-device-id=second-desktop]').getAttribute('aria-pressed')"),'true');
  await cdp("Page.reload");
  await until(()=>evaluate("document.querySelector('.cloud-conversations')?.textContent.includes('second-device conversation 79')"),"Device filter selection not restored");
  async function checkAccountPinned(width,height) {
    await cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<760});
    const state=await evaluate(`(()=>{const side=document.querySelector('.side'),area=side.querySelector('.side-scroll'),foot=side.querySelector('.foot');area.scrollTop=area.scrollHeight;const s=side.getBoundingClientRect(),f=foot.getBoundingClientRect(),a=area.getBoundingClientRect();return{areaHeight:area.clientHeight,scrollHeight:area.scrollHeight,scrollTop:area.scrollTop,areaY:a.top,areaBottom:a.bottom,rowY:area.querySelector('[data-cloud-conversation="second-device-079"]').getBoundingClientRect().top,rowBottom:area.querySelector('[data-cloud-conversation="second-device-079"]').getBoundingClientRect().bottom,scrolls:area.scrollHeight>area.clientHeight,within:f.top>=s.top&&f.bottom<=s.bottom+1,bounded:a.bottom<=f.top+1,hit:!!document.elementFromPoint(f.left+30,f.top+20)?.closest('.foot'),lastVisible:(()=>{const row=area.querySelector('[data-cloud-conversation="second-device-079"]').getBoundingClientRect();return row.top>=a.top&&row.bottom<=a.bottom+1})()}})()`);
    assert(state.scrolls,'Long history must scroll');assert(state.within,'Account card pushed out');assert(state.bounded,'History overlaps account');assert(state.hit,'Account not clickable');assert(state.lastVisible,'Last session not reachable '+JSON.stringify({width,height,...state}));
  }
  await checkAccountPinned(1200,800);await checkAccountPinned(390,844);
  await cdp("Emulation.setDeviceMetricsOverride",{width:1200,height:800,deviceScaleFactor:1,mobile:false});
  await click('[data-device-id="browser-fixture"]');
  await evaluate(`document.querySelector('[data-conversation="${firstConversation}"]').click()`);
  cardsByConversation.set(firstConversation, [{ id:"long-list-permission",kind:"permission",toolName:"Write",preview:"long list fixture",reason:"fixture",risk:"high" }]);
  await until(()=>evaluate("document.querySelector('.interactive-card')?.textContent.includes('long list fixture')"),"Card missing with long sidebar");
  assert(await evaluate("(()=>{const r=document.querySelector('.foot').getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})()"));
  await click(".interactive-card button:not(.yes)");
  await until(()=>evaluate("!document.querySelector('.interactive-card')"),"Long-list card did not resolve");
  await click('[data-device-id="second-desktop"]');

  await click(".foot button");await visible(".sheet .identity");
  assert((await evaluate("document.querySelector('.sheet').textContent")).includes('browser-user'));
  await click(".sheet .head button:last-child");
  await cdp("Emulation.setDeviceMetricsOverride",{width:1200,height:800,deviceScaleFactor:1,mobile:false});
  await click('[data-device-id="browser-fixture"]');
  await until(()=>evaluate("document.querySelector('.cloud-conversations')?.textContent.includes('first-device conversation 79')"),"Switch back failed");
  assert.equal(await evaluate("document.querySelector('.cloud-conversations').textContent.includes('second-device conversation')"),false);
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
  console.log("PASS: pinned account with 160 conversations → selected-device filter → cards during long-list scroll → no null header text → interactive permission allow/deny → exact ask answers → preserved forms/drafts → desktop resolution → expired → stale snapshot isolation → regular/shared routes → browser register → project groups → shared project continuation → offline/reconnect → multiple isolated conversations → desktop continuation roundtrip → switch → stop → reload → task → automatic desktop upload → cloud history → reload recovery → account → password → mobile layout → account isolation");
} finally {
  computer?.close();
  if (socket?.readyState === 1) { try { await cdp("Browser.close"); } catch {} }
  socket?.close(); browser.kill();
  for (const request of pending.values()) clearTimeout(request.timer);
  await new Promise((resolve) => server.close(resolve)); db.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
