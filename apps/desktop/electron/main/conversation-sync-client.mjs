/**
 * Desktop login and push for the conversation-sync store.
 * The token is encrypted by the caller before it is written.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const ID = /^[a-z0-9][a-z0-9._:-]{3,63}$/;

export function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
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

export function toSyncChanges(sessions) {
  const conversations = [];
  const messages = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
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
    });
    const rows = Array.isArray(session.messages) ? session.messages : [];
    for (const message of rows) {
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

export function createConversationSync({
  filePath,
  encrypt,
  decrypt,
  encryptionAvailable,
  fetchImpl = globalThis.fetch,
  listSessions,
  deviceId = "desktop-local",
}) {
  return {
    async getState() {
      const saved = readSaved();
      if (!saved) return { signedIn: false };
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
      rmSync(filePath, { force: true });
      return { signedIn: false };
    },
    async push() {
      const saved = readSaved();
      if (!saved) throw Object.assign(new Error("Sign in first"), { code: "signed_out" });
      const sessions = await listSessions();
      const changes = toSyncChanges(sessions);
      let accepted = 0;
      for (let index = 0; index < Math.max(changes.conversations.length, changes.messages.length, 1); index += 200) {
        const body = {
          device: deviceId,
          conversations: changes.conversations.slice(index, index + 200),
          messages: changes.messages.slice(index, index + 200),
        };
        if (!body.conversations.length && !body.messages.length) break;
        const result = await relay(saved, "/v1/sync/changes", { method: "POST", body });
        accepted += Number(result.accepted ?? 0);
      }
      const state = await relay(saved, "/v1/sync/state");
      return { signedIn: true, baseUrl: saved.baseUrl, account: saved.account, accepted, state };
    },
  };

  async function authenticate(input, path) {
    const baseUrl = validateBaseUrl(input?.baseUrl);
    const account = String(input?.account ?? "").trim();
    const password = String(input?.password ?? "");
    if (!account || !password) throw Object.assign(new Error("填写账号和密码"), { code: "bad_credentials" });
    const result = await publicPost(baseUrl, path, { account, password });
    const token = String(result.token ?? "");
    if (!token) throw Object.assign(new Error("登录没有返回令牌"), { code: "bad_key" });
    const saved = { baseUrl, token, account: String(result.account ?? account) };
    writeSaved(saved);
    const state = await relay(saved, "/v1/sync/state");
    return { signedIn: true, baseUrl, account: saved.account, state };
  }

  function readSaved() {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (!parsed?.baseUrl || !parsed?.tokenEncrypted) return null;
      return { baseUrl: validateBaseUrl(parsed.baseUrl), token: decrypt(parsed.tokenEncrypted), account: String(parsed.account ?? "") };
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      if (error && error.code === "bad_url") return null;
      throw error;
    }
  }

  function writeSaved(saved) {
    if (!encryptionAvailable()) {
      throw Object.assign(new Error("This machine cannot store the access token"), { code: "encryption_unavailable" });
    }
    const payload = JSON.stringify({ baseUrl: saved.baseUrl, account: saved.account ?? "", tokenEncrypted: encrypt(saved.token) });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, payload, "utf8");
    renameSync(temporary, filePath);
  }

  async function relay(saved, path, options = {}) {
    const response = await fetchImpl(`${saved.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${saved.token}`,
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
