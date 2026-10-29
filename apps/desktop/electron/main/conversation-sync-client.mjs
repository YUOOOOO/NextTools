/**
 * Desktop login and push for the conversation-sync store.
 * The token is encrypted by the caller before it is written.
 */

import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const ID = /^[a-z0-9][a-z0-9._:-]{3,63}$/;

export function validateBaseUrl(value) {
  let raw = String(value ?? "").trim();
  if (raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Enter a server URL"), { code: "bad_url" });
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw Object.assign(new Error("Enter a server URL"), { code: "bad_url" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("Enter a server URL"), { code: "bad_url" });
  }
  return url.origin;
}

/** Dial the typed server with Node, not Electron net.fetch. Chromium's fetch
 * applies CORS and the system proxy, which rejects this private HTTP service. */
export function directFetch(url, init = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(Object.assign(new Error("Enter a server URL"), { code: "bad_url" }));
  }
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const body = init.body == null ? null : Buffer.from(String(init.body));
  return new Promise((resolve, reject) => {
    const req = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port ? { port: target.port } : {}),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(init.headers ?? {}),
          ...(body ? { "content-length": body.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
              if (!text) return {};
              try {
                return JSON.parse(text);
              } catch {
                throw Object.assign(new Error(`服务器没有返回 JSON (HTTP ${status})`), { code: "upstream" });
              }
            },
          });
        });
      },
    );
    req.setTimeout(20_000, () => req.destroy(Object.assign(new Error("连接服务器超时"), { code: "timeout" })));
    req.on("error", (error) => {
      const code = error && error.code ? ` (${error.code})` : "";
      reject(Object.assign(new Error(`${error.message || "连不上服务器"}${code}`), { code: "upstream" }));
    });
    if (body) req.write(body);
    req.end();
  });
}

export function messageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part.text === "string" && (part.type === "text" || part.type === "input_text" || part.type === "output_text"))
    .map((part) => part.text)
    .join("\n");
}

export function toSyncChanges(sessions, deviceId) {
  const conversations = [];
  const messages = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (["pi-native", "native-pi", "remote"].includes(session?.source) || session?.remoteHostKey || session?.remoteWorkspace) continue;
    const cid = String(session?.id ?? "").trim().toLowerCase();
    if (!ID.test(cid)) continue;
    const created = unixSeconds(session.createdAt ?? session.created_at);
    const updated = unixSeconds(session.updatedAt ?? session.updated_at ?? created);
    conversations.push({
      cid,
      kind: "side",
      title: String(session.title ?? "").slice(0, 200),
      created_at: created,
      updated_at: updated,
      ...(deviceId ? { execution_device: deviceId, session_id: session.id } : {}),
      ...(typeof session.projectPath === "string" && session.projectPath.trim() ? projectMetadata(session.projectPath) : {}),
    });
    const rows = Array.isArray(session.messages) ? session.messages : [];
    for (const message of rows) {
      // Cloud messages are idempotent by id; never freeze a streaming checkpoint.
      if (message?.status === "streaming") continue;
      const role = message?.role === "assistant" || message?.role === "user" ? message.role : "";
      const mid = String(message?.id ?? "").trim().toLowerCase();
      const text = messageText(message);
      if (!role || !ID.test(mid) || !text) continue;
      messages.push({
        mid,
        cid,
        role,
        text,
        created_at: unixSeconds(message.createdAt ?? message.created_at ?? created),
      });
    }
  }
  return { conversations, messages };
}

function projectMetadata(projectPath) {
  const paths = /\\/.test(projectPath) || /^[a-z]:/i.test(projectPath) ? win32 : posix;
  const normalized = paths.normalize(projectPath).replace(/[\\/]+$/, "") || paths.parse(projectPath).root;
  return {
    project_id: createHash("sha256").update(normalized).digest("hex"),
    project_name: (paths.basename(normalized) || "Project").slice(0, 200),
  };
}

export function createConversationSync({
  filePath,
  encrypt,
  decrypt,
  encryptionAvailable,
  fetchImpl = directFetch,
  listSessions,
  confirmSessionDeleted,
  onCall,
  WebSocketImpl = globalThis.WebSocket,
  deviceId = "desktop-local",
}) {
  let hub = null;
  let hubToken = "";
  let hubUrl = "";
  let hubController = null;
  let reconnectTimer = null;
  let generation = 0;
  let activeScope = "";
  const sharedSessions = new Map();
  function useScope(saved) {
    const scope = JSON.stringify([saved.baseUrl, saved.account]);
    if (scope !== activeScope) {
      sharedSessions.clear();
      activeScope = scope;
    }
    if (!sharedSessions.has(scope)) sharedSessions.set(scope, new Set());
    return scope;
  }
  return {
    async getState() {
      const saved = readSaved();
      if (!saved) return { signedIn: false };
      ensureHub(saved);
      const state = await relay(saved, "/v1/sync/state");
      return { signedIn: true, baseUrl: saved.baseUrl, account: saved.account, state };
    },
    async register(input) {
      return authenticate(input, "/v1/auth/register");
    },
    async signIn(input) {
      return authenticate(input, "/v1/auth/login");
    },
    async signOut() {
      closeHub();
      rmSync(filePath, { force: true });
      return { signedIn: false };
    },
    queueDeleted(sessionIds) {
      const saved = readSaved();
      if (!saved) return;
      const scope = useScope(saved);
      const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === "string" && ID.test(id));
      const pendingDeletes = [...new Set([...(saved.pendingDeletes || []), ...ids])];
      for (const id of ids) sharedSessions.get(scope)?.delete(id);
      writeSaved({ ...saved, pendingDeletes });
    },
    async push() {
      const saved = readSaved();
      if (!saved) throw Object.assign(new Error("Sign in first"), { code: "signed_out" });
      const scope = useScope(saved);
      const epoch = generation;
      const stillSignedIn = () => {
        const current = readSaved();
        if (epoch !== generation || !current || current.token !== saved.token || current.baseUrl !== saved.baseUrl || current.account !== saved.account) {
          throw Object.assign(new Error("Sign-in changed during sync"), { code: "signed_out" });
        }
      };
      // Explicit successful local deletion, never absence from a partial list.
      if (saved.pendingDeletes?.length) {
        const directory = await relay(saved, "/v1/sync/conversations");
        stillSignedIn();
        for (const cid of saved.pendingDeletes) {
          const row = directory.conversations?.find((item) => item.cid === cid);
          if (row && (row.execution_device || row.device) !== deviceId) {
            throw Object.assign(new Error("Conversation belongs to another device"), { code: "sync_delete_owner" });
          }
          if (row) await relay(saved, "/v1/sync/conversations/" + encodeURIComponent(cid), { method: "DELETE" });
          stillSignedIn();
          const latest = readSaved();
          writeSaved({ ...latest, pendingDeletes: (latest.pendingDeletes || []).filter((id) => id !== cid) });
        }
      }
      const sessions = await listSessions();
      stillSignedIn();
      if (confirmSessionDeleted) {
        const live = new Set(sessions.map((session) => session?.id));
        const directory = await relay(saved, "/v1/sync/conversations");
        stillSignedIn();
        const confirmed = [];
        for (const row of directory.conversations || []) {
          if ((row.execution_device || row.device) !== deviceId || live.has(row.session_id || row.cid)) continue;
          if (!ID.test(row.session_id || row.cid)) continue;
          if (await confirmSessionDeleted(row.session_id || row.cid)) confirmed.push(row.cid);
          stillSignedIn();
        }
        if (confirmed.length) {
          const latest = readSaved();
          writeSaved({ ...latest, pendingDeletes: [...new Set([...(latest.pendingDeletes || []), ...confirmed])] });
          for (const id of confirmed) sharedSessions.get(scope)?.delete(id);
        }
      }
      const pendingDeletes = new Set([...(saved.pendingDeletes || []), ...(readSaved()?.pendingDeletes || [])]);
      const changes = toSyncChanges(sessions.filter((session) => !pendingDeletes.has(session?.id)), deviceId);
      let accepted = 0;
      for (let index = 0; index < Math.max(changes.conversations.length, changes.messages.length, 1); index += 200) {
        const body = {
          device: deviceId,
          conversations: changes.conversations.slice(index, index + 200),
          messages: changes.messages.slice(index, index + 200),
        };
        if (!body.conversations.length && !body.messages.length) break;
        stillSignedIn();
        const result = await relay(saved, "/v1/sync/changes", { method: "POST", body });
        stillSignedIn();
        if (Array.isArray(result.rejected) && result.rejected.length) {
          throw Object.assign(new Error("Some conversations could not be synced"), { code: "sync_rejected" });
        }
        accepted += Number(result.accepted ?? 0);
      }
      const state = await relay(saved, "/v1/sync/state");
      stillSignedIn();
      for (const conversation of changes.conversations) sharedSessions.get(scope)?.add(conversation.session_id);
      return { signedIn: true, baseUrl: saved.baseUrl, account: saved.account, accepted, state };
    },
  };

  async function authenticate(input, path) {
    const baseUrl = validateBaseUrl(input?.baseUrl);
    const account = String(input?.account ?? "").trim();
    const password = String(input?.password ?? "");
    if (!account || !password) throw Object.assign(new Error("填写账号和密码"), { code: "bad_credentials" });
    const result = await publicPost(baseUrl, path, { account, identifier: account, password });
    const token = String(result.token || result.api_key || "");
    if (!token) throw Object.assign(new Error("登录没有返回令牌"), { code: "bad_key" });
    const previous = readSaved();
    const accountId = accountLabel(result, account);
    const saved = { baseUrl, token, account: accountId,
      pendingDeletes: previous?.baseUrl === baseUrl && previous.account === accountId ? previous.pendingDeletes || [] : [] };
    writeSaved(saved);
    closeHub(false);
    useScope(saved);
    ensureHub(saved);
    const state = await relay(saved, "/v1/sync/state");
    return { signedIn: true, baseUrl, account: saved.account, state };
  }

  function readSaved() {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (!parsed?.baseUrl || !parsed?.tokenEncrypted) return null;
      return { baseUrl: validateBaseUrl(parsed.baseUrl), token: decrypt(parsed.tokenEncrypted), account: String(parsed.account ?? ""), pendingDeletes: Array.isArray(parsed.pendingDeletes) ? parsed.pendingDeletes.filter((id) => typeof id === "string" && ID.test(id)) : [] };
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      if (error && error.code === "bad_url") return null;
      throw error;
    }
  }

  function closeHub(clearGrants = true) {
    generation += 1;
    if (clearGrants) {
      sharedSessions.clear();
      activeScope = "";
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    hubToken = "";
    hubUrl = "";
    const previous = hub;
    hub = null;
    hubController?.abort();
    hubController = null;
    previous?.close();
  }

  function ensureHub(saved) {
    const scope = useScope(saved);
    if (!onCall || typeof WebSocketImpl !== "function") return;
    if (hub && hubToken === saved.token && hubUrl === saved.baseUrl) return;
    closeHub(false);
    const epoch = generation;
    hubToken = saved.token;
    hubUrl = saved.baseUrl;
    const controller = new AbortController();
    hubController = controller;
    const socket = new WebSocketImpl(`${saved.baseUrl.replace(/^http/, "ws")}/v1/hub`);
    hub = socket;
    const pending = new Set();
    const current = () => hub === socket && generation === epoch && !controller.signal.aborted;
    const send = (body) => {
      if (!current() || socket.readyState !== 1) return;
      try { socket.send(JSON.stringify(body)); } catch { lost(); socket.close(); }
    };
    const open = () => send({
      type: "hello",
      key: saved.token,
      device: {
        id: deviceId, name: "Pilot", kind: "computer", os: process.platform,
        actions: ["info", "sessions.list", "chat.send", "task", "stop", "interactive.list", "interactive.resolve", "shell", "files", "file.get", "file.put", "open", "screen"],
      },
    });
    const message = (event) => {
      if (!current()) return;
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (!frame || frame.type !== "call" || typeof frame.id !== "string" || !frame.id || pending.has(frame.id)) return;
      const args = frame.args && typeof frame.args === "object" && !Array.isArray(frame.args) ? frame.args : {};
      const caller = frame.from && typeof frame.from === "object" ? frame.from : {};
      const context = {
        signal: controller.signal,
        scope,
        isSessionShared: (id) => current() && activeScope === scope && sharedSessions.get(scope)?.has(id) === true,
        caller: {
          id: typeof caller.id === "string" ? caller.id : "",
          name: typeof caller.name === "string" ? caller.name : "",
          kind: typeof caller.kind === "string" ? caller.kind : "",
        },
        emit: (body) => {
          if (pending.has(frame.id)) send({ type: "event", id: frame.id, body });
        },
      };
      pending.add(frame.id);
      Promise.resolve()
        .then(() => {
          if (!current()) return;
          return onCall(String(frame.action ?? ""), args, context);
        })
        .then((body) => {
          pending.delete(frame.id);
          send({ type: "result", id: frame.id, ok: true, body });
        })
        .catch((error) => {
          pending.delete(frame.id);
          send({
            type: "result", id: frame.id, ok: false,
            error: typeof error?.code === "string" ? error.code : "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        });
    };
    const lost = () => {
      socket.removeEventListener("open", open);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", lost);
      socket.removeEventListener("error", lost);
      controller.abort();
      if (socket.readyState < 2) socket.close();
      if (hub !== socket || generation !== epoch) return;
      hub = null;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (generation !== epoch) return;
        let again;
        try { again = readSaved(); } catch { return; }
        if (again && again.token === saved.token && again.baseUrl === saved.baseUrl) ensureHub(again);
      }, 2000);
      reconnectTimer.unref?.();
    };
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("close", lost);
    socket.addEventListener("error", lost);
    controller.signal.addEventListener("abort", () => {
      socket.removeEventListener("open", open);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", lost);
      socket.removeEventListener("error", lost);
    }, { once: true });
  }

  function writeSaved(saved) {
    if (!encryptionAvailable()) {
      throw Object.assign(new Error("This machine cannot store the access token"), { code: "encryption_unavailable" });
    }
    const payload = JSON.stringify({ baseUrl: saved.baseUrl, account: saved.account ?? "", tokenEncrypted: encrypt(saved.token), pendingDeletes: saved.pendingDeletes || [] });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, payload, "utf8");
    renameSync(temporary, filePath);
  }

  async function relay(saved, path, options = {}) {
    const response = await fetchImpl(`${saved.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${saved.token}`,
        "x-nanomuse-device": deviceId,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.error?.message || `HTTP ${response.status}`;
      throw Object.assign(new Error(message), { code: body?.error?.code || "upstream" });
    }
    return body;
  }
  async function publicPost(baseUrl, path, body) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`), {
        code: payload?.error?.code || "upstream",
      });
    }
    return payload;
  }

}

function accountLabel(result, fallback) {
  const value = result?.account;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const id = value.id ?? value.hint;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return fallback;
}

function unixSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.trunc(value / 1000) : Math.trunc(value);
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
  }
  return Math.trunc(Date.now() / 1000);
}
