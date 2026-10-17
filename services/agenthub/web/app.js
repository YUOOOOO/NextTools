const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view"),
  workspace = $("#workspace"),
  authForm = $("#auth-form");
const sessionKey = "agenthub.nexo.session.v1";
let session = loadSession(),
  registerMode = false,
  activeThread = null,
  busy = false;
let refreshing = null;
function setBusy(value) {
  busy = value;
  workspace.setAttribute("aria-busy", String(value));
  for (const control of workspace.querySelectorAll("button, input, textarea"))
    control.disabled = value;
  $("#logout").disabled = value;
}
async function perform(action) {
  if (busy) return;
  setBusy(true);
  try {
    await action();
  } catch (error) {
    showStatus(error.message);
  } finally {
    setBusy(false);
  }
}
function loadSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    return value &&
      typeof value.accountId === "string" &&
      typeof value.accessToken === "string" &&
      typeof value.refreshToken === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
function saveSession(value) {
  session = value;
  sessionStorage.setItem(sessionKey, JSON.stringify(value));
}
function clearSession() {
  session = null;
  activeThread = null;
  sessionStorage.removeItem(sessionKey);
  $("#thread-list").replaceChildren();
  $("#credential-form").reset();
  $("#prompt").value = "";
  renderMessages([]);
}
function showError(target, message) {
  target.textContent = message || "";
}
function explain(code) {
  const known = {
    ACCOUNT_CREDENTIALS_INVALID:
      "The email, username, or password is incorrect.",
    ACCOUNT_AUTH_REQUIRED: "Your session expired. Sign in again.",
    ACCOUNT_REGISTRATION_DISABLED: "Registration is disabled on this AgentHub.",
    ACCOUNT_PASSWORD_WEAK: "Choose a password with at least 12 characters.",
    ACCOUNT_EXISTS: "An account with this email or username already exists.",
    NEXO_CREDENTIAL_REQUIRED: "Add your Anthropic API key to start a chat.",
    NEXO_WORKER_UNCONFIGURED:
      "The Nexo worker is not configured on this AgentHub.",
    NEXO_WORKER_FAILED: "Nexo could not complete this response. Try again.",
    NEXO_WORKER_TIMEOUT: "The Nexo worker timed out. Try a shorter request.",
  };
  return (
    known[code] ||
    String(code || "Request failed")
      .replaceAll("_", " ")
      .toLowerCase()
  );
}
async function raw(path, options = {}, token = session?.accessToken) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (session?.accountId) headers.set("x-agenthub-account", session.accountId);
  const response = await fetch(path, {
    ...options,
    headers,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const error = new Error(explain(payload?.code));
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return payload.data;
}
async function refreshSession() {
  if (refreshing) return refreshing;
  const current = session;
  if (!current?.refreshToken)
    throw new Error("Your session expired. Sign in again.");
  refreshing = (async () => {
    const value = await raw(
      "/api/auth/refresh",
      {
        method: "POST",
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      },
      null,
    );
    if (session !== current || value.accountId !== current.accountId)
      throw new Error("Account session changed. Sign in again.");
    saveSession({
      ...current,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
    });
  })();
  try {
    await refreshing;
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      setAuthenticated(false);
      showError($("#auth-error"), error.message);
    }
    throw error;
  } finally {
    refreshing = null;
  }
}
async function api(path, options = {}) {
  const token = session?.accessToken;
  try {
    return await raw(path, options);
  } catch (error) {
    if (error.status !== 401 || !session?.refreshToken) throw error;
    if (session.accessToken === token) await refreshSession();
    return raw(path, options);
  }
}
function setAuthenticated(value) {
  authView.classList.toggle("hidden", value);
  workspace.classList.toggle("hidden", !value);
  $("#logout").classList.toggle("hidden", !value);
  $("#account-label").textContent = value ? session.identifier : "";
}
function renderMessages(messages) {
  const container = $("#messages");
  container.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const title = document.createElement("h1");
    title.textContent = "Start a conversation";
    empty.append(title);
    container.append(empty);
    return;
  }
  for (const item of messages) {
    const article = document.createElement("article");
    article.className = `message ${item.role === "user" ? "user" : ""}`;
    const label = document.createElement("span");
    label.className = "message-label";
    label.textContent = item.role === "user" ? "You" : "Nexo";
    const text = document.createElement("div");
    text.textContent = item.content;
    article.append(label, text);
    container.append(article);
  }
  container.scrollTop = container.scrollHeight;
}
async function loadThread(id) {
  const thread = await api(`/api/nexo/threads/${encodeURIComponent(id)}`);
  activeThread = id;
  renderMessages(thread.messages || []);
  for (const button of document.querySelectorAll(".thread-button")) {
    if (button.dataset.id === id) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}
async function loadThreads() {
  const list = await api("/api/nexo/threads");
  const nav = $("#thread-list");
  nav.replaceChildren();
  for (const thread of list.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-button";
    button.textContent = thread.title;
    button.dataset.id = thread.id;
    button.disabled = busy;
    button.addEventListener("click", () =>
      perform(() => loadThread(thread.id)),
    );
    nav.append(button);
  }
  if (activeThread && list.items.some((item) => item.id === activeThread))
    await loadThread(activeThread);
  else if (list.items[0]) await loadThread(list.items[0].id);
  else renderMessages([]);
}
function showStatus(errorOrText) {
  const error =
    errorOrText instanceof Error
      ? errorOrText.message
      : String(errorOrText || "");
  $("#status").textContent = error;
}
async function loadCredentialState() {
  const value = await api("/api/nexo/credential");
  $("#credential-state").textContent = value.configured
    ? "Key saved encrypted for this account."
    : "No provider key saved.";
  $("#remove-key").classList.toggle("hidden", !value.configured);
}
async function enterWorkspace() {
  setBusy(true);
  setAuthenticated(true);
  showStatus("");
  try {
    const me = await api("/api/auth/me");
    session.identifier = me.identifier;
    saveSession(session);
    $("#account-label").textContent = me.identifier;
    await Promise.all([loadThreads(), loadCredentialState()]);
  } catch (error) {
    if (error.status === 401 || error.code === "ACCOUNT_AUTH_REQUIRED") {
      clearSession();
      setAuthenticated(false);
      showError($("#auth-error"), "Your session expired. Sign in again.");
    } else showStatus(error.message);
  } finally {
    setBusy(false);
  }
}
$("#auth-mode").addEventListener("click", () => {
  registerMode = !registerMode;
  $("#auth-submit").textContent = registerMode ? "Create account" : "Sign in";
  $("#auth-mode").textContent = registerMode
    ? "Back to sign in"
    : "Create an account";
  authForm.elements.password.autocomplete = registerMode
    ? "new-password"
    : "current-password";
  showError(
    $("#auth-error"),
    registerMode
      ? "New account passwords must have at least 12 characters."
      : "",
  );
});
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#auth-submit");
  button.disabled = true;
  $("#auth-mode").disabled = true;
  showError($("#auth-error"), "");
  try {
    const identifier = authForm.elements.identifier.value;
    const password = authForm.elements.password.value;
    const value = await raw(
      `/api/auth/${registerMode ? "register" : "login"}`,
      {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      },
      null,
    );
    if (!value.accountId || !value.accessToken || !value.refreshToken)
      throw new Error("ACCOUNT_RESPONSE_INVALID");
    saveSession({ ...value, identifier });
    authForm.reset();
    await enterWorkspace();
  } catch (error) {
    showError($("#auth-error"), error.message);
  } finally {
    button.disabled = false;
    $("#auth-mode").disabled = false;
  }
});
$("#logout").addEventListener("click", () =>
  perform(async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      clearSession();
      setAuthenticated(false);
      showError($("#auth-error"), "");
    }
  }),
);
$("#new-thread").addEventListener("click", () =>
  perform(async () => {
    const thread = await api("/api/nexo/threads", {
      method: "POST",
      body: JSON.stringify({}),
    });
    activeThread = thread.id;
    await loadThreads();
    $("#prompt").value = "";
  }),
);
$("#credential-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  void perform(async () => {
    await api("/api/nexo/credential", {
      method: "PUT",
      body: JSON.stringify({ apiKey: form.elements.apiKey.value }),
    });
    form.reset();
    await loadCredentialState();
    showStatus("Provider key saved encrypted.");
  });
});
$("#remove-key").addEventListener("click", () =>
  perform(async () => {
    await api("/api/nexo/credential", { method: "DELETE" });
    await loadCredentialState();
    showStatus("Provider key removed.");
  }),
);
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const prompt = $("#prompt"),
    content = prompt.value.trim();
  if (!content) return;
  setBusy(true);
  showStatus("Nexo is working…");
  try {
    if (!activeThread) {
      const thread = await api("/api/nexo/threads", {
        method: "POST",
        body: JSON.stringify({}),
      });
      activeThread = thread.id;
    }
    await api(
      `/api/nexo/threads/${encodeURIComponent(activeThread)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    );
    prompt.value = "";
    await loadThreads();
    showStatus("");
  } catch (error) {
    showStatus(error.message);
  } finally {
    setBusy(false);
  }
});
setAuthenticated(false);
if (session) void enterWorkspace();
