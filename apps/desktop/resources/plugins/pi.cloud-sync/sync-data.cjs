const { createHash } = require("node:crypto");
const { posix, win32 } = require("node:path");
const ID = /^[a-z0-9][a-z0-9._:-]{3,63}$/;
function validateBaseUrl(value) {
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


function messageText(message) {
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

function toSyncChanges(sessions, deviceId) {
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

module.exports = { validateBaseUrl, messageText, toSyncChanges };
