import {
  createAgentSession,
  formatSkillsForPrompt,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import readline from "node:readline";
import {
  createHostTools,
  createMcpTools,
  createSkillTool,
} from "./host-tools.mjs";
import { PerchoHostBridge } from "./percho-host-bridge.mjs";

const VERSION = 1;
const sessions = new Map();
const pendingHost = new Map();
let nextId = 1;
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

function send(message) {
  protocolWrite(`${JSON.stringify({ version: VERSION, ...message })}\n`);
}
function rpcError(error) {
  return error instanceof Error ? error.message : String(error);
}
function response(id, result, error) {
  if (error === undefined) send({ id, result });
  else send({ id, error: { code: -32000, message: rpcError(error) } });
}
function hostCall(method, params, signal) {
  const id = `host-${nextId++}`;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(new Error(`Host response timeout: ${method}`));
    }, 240000);
    const onAbort = () => {
      clearTimeout(timer);
      pendingHost.delete(id);
      reject(new Error("Tool invocation cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingHost.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    });
  });
}

async function createRuntime(provider, modelId, apiKey) {
  if (!provider || !modelId || !apiKey)
    throw new Error("provider, model and apiKey are required");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider, async () => ({
    type: "api_key",
    key: apiKey,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
  return { runtime, model };
}

async function makeResourceLoader(
  cwd,
  agentDir,
  settingsManager,
  resources = {},
) {
  const skills = (Array.isArray(resources.skills) ? resources.skills : []).map(
    (skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      disableModelInvocation: false,
      sourceInfo: {
        source: "local",
        scope: "user",
        path: skill.filePath,
        baseDir: skill.baseDir,
      },
    }),
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDir || cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    disabledBuiltinExtensions: ["mcp"],
    appendSystemPrompt: [
      ...(typeof resources.systemPrompt === "string" && resources.systemPrompt ? [resources.systemPrompt] : []),
      ...(skills.length ? [formatSkillsForPrompt(skills, "indirect"), "Use skill_read with a listed filePath to load Skill instructions on demand. Never execute Skill files directly."] : []),
    ],
    skillsOverride: () => ({
      skills,
      diagnostics: [],
    }),
  });
  await loader.reload();
  return loader;
}

function eventFor(liveId, event) {
  send({ method: "agent.event", params: { sessionId: liveId, event } });
}
const percho = new PerchoHostBridge(eventFor);

async function createOrResume(params, resume) {
  const liveId = String(params.sessionId || "");
  if (!liveId) throw new Error("sessionId is required");
  if (sessions.has(liveId))
    return {
      sessionId: liveId,
      model: sessions.get(liveId).session.model?.id ?? null,
    };
  const cwd = String(params.cwd || process.cwd());
  const sessionDir = String(params.sessionDir || "");
  if (!sessionDir) throw new Error("sessionDir is required");
  const settingsManager = SettingsManager.inMemory();
  const { runtime, model } = await createRuntime(
    params.provider,
    params.model,
    params.apiKey,
  );
  let manager;
  if (resume) {
    const persistedId = String(params.persistedSessionId || "");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(persistedId))
      throw new Error("Invalid persistedSessionId");
    const file = SessionManager.findById(cwd, persistedId, sessionDir);
    if (!file) throw new Error(`Persisted session not found: ${persistedId}`);
    manager = SessionManager.open(file, sessionDir, cwd);
  } else {
    manager = SessionManager.create(cwd, sessionDir, { id: liveId });
  }
  const resources = params.resources || {};
  const resourceLoader = await makeResourceLoader(
    cwd,
    params.agentDir,
    settingsManager,
    resources,
  );
  const tools = [
    ...createHostTools(liveId, hostCall),
    ...(Array.isArray(resources.mcpTools)
      ? createMcpTools(liveId, hostCall, resources.mcpTools)
      : []),
  ];
  if (Array.isArray(resources.skills) && resources.skills.length)
    tools.push(createSkillTool(liveId, hostCall));
  const result = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    customTools: tools,
    noTools: "all",
    tools: tools.map((tool) => tool.name),
  });
  const session = result.session;
  const persistedId = percho.attach(liveId, session, cwd);
  sessions.set(liveId, {
    session,
    runtime,
    persistedId,
    resources,
    prompt: Promise.resolve(),
  });
  eventFor(liveId, {
    type: "session_ready",
    sessionId: liveId,
    persistedSessionId: persistedId,
    model: session.model?.id ?? null,
  });
  const output = {
    sessionId: liveId,
    persistedSessionId: persistedId,
    model: session.model?.id ?? null,
  };
  if (resume) output.messages = await percho.messages(persistedId);
  return output;
}

async function listSessions(params) {
  const cwd = String(params.cwd || process.cwd());
  const sessionDir = String(params.sessionDir || "");
  if (!sessionDir) throw new Error("sessionDir is required");
  return (await SessionManager.list(cwd, sessionDir)).map((info) => ({
    sessionId: info.id,
    title: info.name || info.firstMessage || "New session",
    updatedAt: info.modified.toISOString(),
  }));
}

async function disposeSession(liveId) {
  const record = sessions.get(liveId);
  if (!record) return { disposed: true };
  const result = await percho.close(record.persistedId);
  if (result.closed) sessions.delete(liveId);
  return { disposed: result.closed };
}

async function handleRequest(message) {
  const params = message.params || {};
  if (message.method === "runner.health")
    return { version: VERSION, sessions: [...sessions.keys()] };
  if (message.method === "models.list") {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    return runtime
      .getModels()
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
      }));
  }
  if (message.method === "session.list") return listSessions(params);
  if (message.method === "session.create") return createOrResume(params, false);
  if (message.method === "session.resume") return createOrResume(params, true);
  const liveId = String(params.sessionId || "");
  const record = sessions.get(liveId);
  if (!record) throw new Error(`Unknown agent session: ${liveId}`);
  if (message.method === "session.snapshot") {
    return {
      model: record.session.model?.id ?? null,
      messages: await percho.messages(record.persistedId),
    };
  }
  if (message.method === "session.rename") {
    const title = String(params.title || "").trim();
    if (!title || title.length > 200)
      throw new Error("Session title must contain 1–200 characters");
    await percho.rename(record.persistedId, title);
    return { renamed: true };
  }
  if (message.method === "session.thinking") {
    const levels = getSupportedThinkingLevels(record.session.model);
    const level = String(params.level || "");
    if (!levels.includes(level))
      throw new Error(`Unsupported thinking level: ${level}`);
    await percho.thinking(record.persistedId, level);
    return {
      thinkingLevel: record.session.thinkingLevel,
      supportedThinkingLevels: levels,
    };
  }
  if (message.method === "session.prompt") {
    let text = String(params.text || "");
    if (text.trim() === "/export")
      return {
        accepted: true,
        exportText: await percho.export(record.persistedId),
      };
    const skillCommand = /^\/skill:([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(
      text.trim(),
    );
    if (skillCommand) {
      const skill = record.resources.skills?.find(
        (value) => value.name === skillCommand[1],
      );
      if (!skill) throw new Error(`Unknown enabled skill: ${skillCommand[1]}`);
      const result = await hostCall("tool.invoke", {
        sessionId: liveId,
        toolName: "skill_read",
        input: { filePath: skill.filePath },
      });
      text = `<skill name="${skill.name}">\nBase directory: ${skill.baseDir}\n${result.content}\n</skill>\n${skillCommand[2] || ""}`;
    }
    if (!text.trim()) throw new Error("Prompt must not be empty");
    // Percho acknowledges preflight; completion is delivered by agent_settled.
    await percho.prompt(record.persistedId, text);
    return { accepted: true };
  }
  if (message.method === "session.abort") {
    await percho.abort(record.persistedId);
    return { accepted: true };
  }
  if (message.method === "session.dispose") return disposeSession(liveId);
  throw new Error(`Unknown runner method: ${message.method}`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ method: "runner.error", params: { error: rpcError(error) } });
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const pending = pendingHost.get(String(message.id));
    if (!pending) return;
    pendingHost.delete(String(message.id));
    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      const error = message.error;
      pending.reject(
        new Error(
          typeof error === "string"
            ? error
            : error?.message || "Host request failed",
        ),
      );
    } else if (Object.prototype.hasOwnProperty.call(message, "result"))
      pending.resolve(message.result);
    else pending.reject(new Error("Invalid Host response"));
    return;
  }
  if (message.id === undefined) return;
  try {
    response(message.id, await handleRequest(message));
  } catch (error) {
    response(message.id, undefined, error);
  }
});

input.on("close", () => percho.dispose());

send({ method: "runner.ready", params: { version: VERSION } });
