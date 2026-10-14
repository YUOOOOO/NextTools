import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FilesView } from "@nexttools/workspace-files";
import { IconButton } from "@nexttools/ui";
import type {
  AgentSessionInfo,
  AgentSessionSummary,
  AgentSettingsSnapshot,
  CommandEvent,
  GitStatus,
  HostSnapshot,
  Preferences,
  McpServerConfig,
} from "@nexttools/protocol";
import {
  Ban,
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Files,
  GitBranch,
  Home,
  LoaderCircle,
  Minus,
  PanelLeft,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Square,
  StopCircle,
  User,
  Wrench,
  X,
} from "lucide-react";
import { host, nativeHostAvailable } from "./host";

type AgentTimelineKind = "user" | "assistant" | "thinking" | "tool";
type AgentTimelineStatus = "running" | "done" | "error";

interface AgentTimelineItem {
  id: string;
  kind: AgentTimelineKind;
  title: string;
  text: string;
  status?: AgentTimelineStatus;
}

interface AgentApproval {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function stringField(value: UnknownRecord | null, key: string) {
  const field = value?.[key];
  return typeof field === "string" ? field : "";
}

function displayJson(value: unknown) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentText(
  value: unknown,
  kind: "text" | "thinking" = "text",
): string {
  if (typeof value === "string") return kind === "text" ? value : "";
  if (!Array.isArray(value)) {
    const record = asRecord(value);
    if (!record) return "";
    const type = stringField(record, "type").toLowerCase();
    const isThinking = type.includes("thinking") || type.includes("reasoning");
    if ((kind === "thinking") !== isThinking && type) return "";
    const candidate =
      record.text ?? record.thinking ?? record.reasoning ?? record.content;
    return typeof candidate === "string" ? candidate : "";
  }
  return value
    .map((part: unknown): string => contentText(part, kind))
    .filter(Boolean)
    .join("\n");
}

function eventDelta(event: UnknownRecord) {
  const candidate = event.delta ?? event.text ?? event.content;
  return typeof candidate === "string" ? candidate : "";
}

function upsertTimeline(
  items: AgentTimelineItem[],
  next: AgentTimelineItem,
  append = false,
) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  const current = items[index];
  const updated = [...items];
  updated[index] = {
    ...current,
    ...next,
    text: append ? current.text + next.text : next.text,
  };
  return updated;
}

function restoredTimeline(messages: unknown): AgentTimelineItem[] {
  if (!Array.isArray(messages)) return [];
  const timeline: AgentTimelineItem[] = [];
  messages.forEach((unknownMessage, messageIndex) => {
    const message = asRecord(unknownMessage);
    if (!message) return;
    const role = stringField(message, "role").toLowerCase();
    const baseId = stringField(message, "id") || `restored-${messageIndex}`;
    if (role === "user") {
      const text = contentText(message.content);
      if (text)
        timeline.push({
          id: `${baseId}:user`,
          kind: "user",
          title: "你",
          text,
          status: "done",
        });
      return;
    }
    if (role === "assistant") {
      const thinking = contentText(message.content, "thinking");
      if (thinking)
        timeline.push({
          id: `${baseId}:thinking`,
          kind: "thinking",
          title: "思考",
          text: thinking,
          status: "done",
        });
      const text = contentText(message.content);
      if (text)
        timeline.push({
          id: `${baseId}:assistant`,
          kind: "assistant",
          title: "Pi",
          text,
          status: "done",
        });
      if (Array.isArray(message.content)) {
        message.content.forEach((unknownPart, partIndex) => {
          const part = asRecord(unknownPart);
          const type = stringField(part, "type").toLowerCase();
          if (
            !part ||
            (!type.includes("toolcall") && !type.includes("tool_call"))
          )
            return;
          timeline.push({
            id: `${baseId}:tool:${partIndex}`,
            kind: "tool",
            title: stringField(part, "name") || "工具调用",
            text: displayJson(part.arguments ?? part.input),
            status: "done",
          });
        });
      }
      return;
    }
    if (role === "toolresult" || role === "tool_result" || role === "tool") {
      timeline.push({
        id: `${baseId}:tool-result`,
        kind: "tool",
        title: stringField(message, "toolName") || "工具结果",
        text: contentText(message.content) || displayJson(message.content),
        status: message.isError === true ? "error" : "done",
      });
    }
  });
  return timeline;
}

export function App() {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  const [revision, setRevision] = useState(0);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const [pendingAgentCommand, setPendingAgentCommand] = useState<
    "new" | "continue" | null
  >(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [agentSession, setAgentSession] = useState<AgentSessionInfo | null>(
    null,
  );
  const [activePersistedSessionId, setActivePersistedSessionId] = useState<
    string | null
  >(null);
  const [agentMessages, setAgentMessages] = useState<AgentTimelineItem[]>([]);
  const [agentInput, setAgentInput] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentCreating, setAgentCreating] = useState(false);
  const [agentStopping, setAgentStopping] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentApprovals, setAgentApprovals] = useState<AgentApproval[]>([]);
  const [resolvingApprovals, setResolvingApprovals] = useState<Set<string>>(
    () => new Set(),
  );
  const currentSessionId = useRef("");
  const activeAssistantId = useRef("");
  const activeThinkingId = useRef("");
  const sessionVersion = useRef(0);
  const autoWorkspace = useRef("");
  const pendingRestoredEvents = useRef(new Map<string, unknown>());
  const currentWorkspaceId = useRef("");
  const sessionsRequestVersion = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const loadAgentSessionsRef = useRef<(workspaceId: string) => void>(
    () => undefined,
  );
  const refresh = useCallback(async () => {
    const next = await host.snapshot();
    setSnapshot(next);
    return next;
  }, []);
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError("");
      try {
        await action();
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );
  const consumeAgentEvent = useCallback((event: unknown) => {
    const value = asRecord(event);
    if (!value) return;
    const type = stringField(value, "type").toLowerCase().replace(/[.-]/g, "_");
    if (!type) return;
    if (type === "session_restored") {
      setAgentMessages(restoredTimeline(value.messages));
      setAgentStopping(false);
      setAgentRunning(false);
      return;
    }

    if (type === "agent_start" || type === "turn_start") setAgentRunning(true);
    if (type === "agent_end" || type === "agent_settled") {
      setAgentStopping(false);
      setAgentRunning(false);
      setAgentMessages((items) =>
        items.map((item) =>
          item.status === "running" ? { ...item, status: "done" } : item,
        ),
      );
      const workspaceId = currentWorkspaceId.current;
      if (workspaceId) loadAgentSessionsRef.current(workspaceId);
    }
    if (type.includes("error")) {
      setAgentStopping(false);
      const detail = value.error ?? value.message;
      if (detail !== undefined) setAgentError(displayJson(detail));
      setAgentMessages((items) =>
        items.map((item) =>
          item.status === "running" ? { ...item, status: "error" } : item,
        ),
      );
    }

    const message = asRecord(value.message);
    const role = stringField(message, "role").toLowerCase();
    const suppliedMessageId =
      stringField(message, "id") || stringField(value, "messageId");

    if (type === "message_start" && role === "assistant") {
      activeAssistantId.current =
        suppliedMessageId || `assistant-${Date.now()}`;
      setAgentMessages((items) =>
        upsertTimeline(items, {
          id: `${activeAssistantId.current}:assistant`,
          kind: "assistant",
          title: "Pi",
          text: "",
          status: "running",
        }),
      );
    }

    if (
      (type === "message_start" || type === "message_end") &&
      role === "user"
    ) {
      const text = contentText(message?.content);
      if (text) {
        setAgentMessages((items) => {
          const last = items.at(-1);
          if (last?.kind === "user" && last.text === text) return items;
          return [
            ...items,
            {
              id: `${suppliedMessageId || `user-${Date.now()}`}:user`,
              kind: "user",
              title: "你",
              text,
              status: "done",
            },
          ];
        });
      }
    }

    const nested =
      asRecord(value.assistantMessageEvent) ?? asRecord(value.event) ?? value;
    const nestedType = stringField(nested, "type")
      .toLowerCase()
      .replace(/[.-]/g, "_");
    const delta = eventDelta(nested);
    if (
      delta &&
      nestedType.includes("thinking") &&
      nestedType.includes("delta")
    ) {
      const baseId =
        suppliedMessageId ||
        activeAssistantId.current ||
        `assistant-${Date.now()}`;
      activeAssistantId.current ||= baseId;
      activeThinkingId.current = `${baseId}:thinking`;
      setAgentMessages((items) =>
        upsertTimeline(
          items,
          {
            id: activeThinkingId.current,
            kind: "thinking",
            title: "思考",
            text: delta,
            status: "running",
          },
          true,
        ),
      );
    } else if (
      delta &&
      (nestedType.includes("text_delta") || type === "assistant_delta")
    ) {
      const baseId =
        suppliedMessageId ||
        activeAssistantId.current ||
        `assistant-${Date.now()}`;
      activeAssistantId.current ||= baseId;
      setAgentMessages((items) =>
        upsertTimeline(
          items,
          {
            id: `${baseId}:assistant`,
            kind: "assistant",
            title: "Pi",
            text: delta,
            status: "running",
          },
          true,
        ),
      );
    }

    if (type === "message_end" && role === "assistant") {
      const baseId = suppliedMessageId || activeAssistantId.current;
      const text = contentText(message?.content);
      const thinking = contentText(message?.content, "thinking");
      if (baseId && text) {
        setAgentMessages((items) =>
          upsertTimeline(items, {
            id: `${baseId}:assistant`,
            kind: "assistant",
            title: "Pi",
            text,
            status: "done",
          }),
        );
      } else if (baseId) {
        setAgentMessages((items) =>
          items.map((item) =>
            item.id === `${baseId}:assistant`
              ? { ...item, status: "done" }
              : item,
          ),
        );
      }
      if (baseId && thinking) {
        setAgentMessages((items) =>
          upsertTimeline(items, {
            id: `${baseId}:thinking`,
            kind: "thinking",
            title: "思考",
            text: thinking,
            status: "done",
          }),
        );
      }
      activeAssistantId.current = "";
      activeThinkingId.current = "";
    }

    if (type === "tool_execution_start") {
      const id =
        stringField(value, "toolCallId") ||
        stringField(value, "id") ||
        `tool-${Date.now()}`;
      const title = stringField(value, "toolName") || "工具调用";
      setAgentMessages((items) =>
        upsertTimeline(items, {
          id: `${id}:tool`,
          kind: "tool",
          title,
          text: displayJson(value.args ?? value.input),
          status: "running",
        }),
      );
    }
    if (type === "tool_execution_update" || type === "tool_execution_end") {
      const id = stringField(value, "toolCallId") || stringField(value, "id");
      if (id) {
        const failed = value.isError === true || value.error !== undefined;
        const result =
          value.result ?? value.partialResult ?? value.error ?? value.output;
        setAgentMessages((items) =>
          upsertTimeline(items, {
            id: `${id}:tool`,
            kind: "tool",
            title: stringField(value, "toolName") || "工具调用",
            text: displayJson(result),
            status:
              type === "tool_execution_update"
                ? "running"
                : failed
                  ? "error"
                  : "done",
          }),
        );
      }
    }
  }, []);
  useEffect(() => {
    if (nativeHostAvailable) void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    if (!nativeHostAvailable) return;
    let stopped = false;
    let cleanup: (() => void)[] = [];
    void Promise.all([
      listen<CommandEvent>("host:command", async ({ payload }) => {
        if (
          payload.commandId === "pi.newSession" ||
          payload.commandId === "pi.continueSession"
        ) {
          setPendingAgentCommand(
            payload.commandId === "pi.newSession" ? "new" : "continue",
          );
          const state = await host.snapshot();
          await host.setPreferences({ ...state.preferences, mode: "agent" });
          await refresh();
          return;
        }
        if (payload.viewId) {
          const state = await host.snapshot();
          await host.setPreferences({
            ...state.preferences,
            mode: "workbench",
            workbenchView: payload.viewId,
          });
          await refresh();
        }
        if (payload.commandId === "refresh") setRevision((value) => value + 1);
      }),
      listen<string>("host:error", ({ payload }) => setError(payload)),
    ]).then((unlisten) => {
      if (stopped) unlisten.forEach((fn) => fn());
      else cleanup = unlisten;
    });
    return () => {
      stopped = true;
      cleanup.forEach((fn) => fn());
    };
  }, [refresh]);
  useEffect(() => {
    if (!nativeHostAvailable) return;
    let stopped = false;
    let cleanup: (() => void)[] = [];
    void Promise.all([
      listen<unknown>("agent:event", ({ payload }) => {
        const envelope = asRecord(payload);
        if (!envelope) return;
        const sessionId = stringField(envelope, "sessionId");
        if (!sessionId) return;
        if (sessionId !== currentSessionId.current) {
          const event = asRecord(envelope.event);
          if (stringField(event, "type") === "session_restored") {
            pendingRestoredEvents.current.set(sessionId, envelope.event);
          }
          return;
        }
        consumeAgentEvent(envelope.event);
      }),
      listen<unknown>("agent:approval", ({ payload }) => {
        const request = asRecord(payload);
        if (!request) return;
        const requestId = stringField(request, "requestId");
        const sessionId = stringField(request, "sessionId");
        const toolName = stringField(request, "toolName");
        if (!requestId || !sessionId || sessionId !== currentSessionId.current)
          return;
        setAgentApprovals((items) => {
          const next = { requestId, sessionId, toolName, input: request.input };
          const index = items.findIndex((item) => item.requestId === requestId);
          if (index < 0) return [...items, next];
          return items.map((item, itemIndex) =>
            itemIndex === index ? next : item,
          );
        });
      }),
      listen<unknown>("agent:error", ({ payload }) => {
        const value = asRecord(payload);
        const detail = value?.error ?? payload;
        setAgentError(displayJson(detail));
        setAgentStopping(false);
        setAgentRunning(false);
        setAgentMessages((items) =>
          items.map((item) =>
            item.status === "running" ? { ...item, status: "error" } : item,
          ),
        );
      }),
      listen<unknown>("agent:approval-resolved", ({ payload }) => {
        const request = asRecord(payload);
        const requestId = request && stringField(request, "requestId");
        if (!requestId) return;
        setAgentApprovals((items) =>
          items.filter((item) => item.requestId !== requestId),
        );
        setResolvingApprovals((items) => {
          const next = new Set(items);
          next.delete(requestId);
          return next;
        });
      }),
    ]).then((unlisten) => {
      if (stopped) unlisten.forEach((fn) => fn());
      else cleanup = unlisten;
    });
    return () => {
      stopped = true;
      cleanup.forEach((fn) => fn());
    };
  }, [consumeAgentEvent]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        snapshot?.preferences.theme === "system" || !snapshot
          ? snapshot?.preferences.theme === "system" && media.matches
            ? "dark"
            : "light"
          : snapshot.preferences.theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [snapshot?.preferences.theme]);
  useEffect(() => {
    if (settings) dialog.current?.showModal();
    else dialog.current?.close();
  }, [settings]);
  const preferences = snapshot?.preferences;
  const mode = preferences?.mode ?? "workbench";
  const view = preferences?.workbenchView ?? "home";
  const workspace =
    snapshot?.workspaces.find(
      (item) => item.id === preferences?.activeWorkspaceId,
    ) ?? null;
  currentWorkspaceId.current = workspace?.id ?? "";
  const filePlugin = snapshot?.plugins.find(
    (plugin) => plugin.manifest.id === "com.nexttools.workspace-files",
  );
  const loadAgentSessions = useCallback(async (workspaceId: string) => {
    if (currentWorkspaceId.current !== workspaceId) return;
    const version = ++sessionsRequestVersion.current;
    setSessionsLoading(true);
    try {
      const sessions = await host.listAgentSessions(workspaceId);
      if (
        version === sessionsRequestVersion.current &&
        currentWorkspaceId.current === workspaceId
      ) {
        setAgentSessions(sessions);
      }
    } catch (cause) {
      if (
        version === sessionsRequestVersion.current &&
        currentWorkspaceId.current === workspaceId
      ) {
        setAgentSessions([]);
        setAgentError(String(cause));
      }
    } finally {
      if (version === sessionsRequestVersion.current) setSessionsLoading(false);
    }
  }, []);
  loadAgentSessionsRef.current = (workspaceId) =>
    void loadAgentSessions(workspaceId);
  const loadGit = useCallback(async (workspaceId: string) => {
    setGitLoading(true);
    setGitError("");
    try {
      const status = await host.gitStatus(workspaceId);
      if (currentWorkspaceId.current === workspaceId) setGitStatus(status);
    } catch (cause) {
      if (currentWorkspaceId.current === workspaceId)
        setGitError(String(cause));
    } finally {
      setGitLoading(false);
    }
  }, []);
  useEffect(() => {
    setGitStatus(null);
    setGitError("");
    if (gitOpen && workspace) void loadGit(workspace.id);
  }, [gitOpen, loadGit, workspace?.id]);
  const beginAgentSession = useCallback(
    async (workspaceId: string) => {
      const version = ++sessionVersion.current;
      currentSessionId.current = "";
      activeAssistantId.current = "";
      activeThinkingId.current = "";
      setAgentSession(null);
      setActivePersistedSessionId(null);
      setAgentMessages([]);
      setAgentApprovals([]);
      setAgentError("");
      setAgentRunning(false);
      setAgentStopping(false);
      setAgentCreating(true);
      try {
        const next = await host.agentSessionCreate(workspaceId);
        if (version !== sessionVersion.current) return;
        currentSessionId.current = next.sessionId;
        setAgentSession(next);
        void loadAgentSessions(workspaceId);
      } catch (cause) {
        if (version === sessionVersion.current) setAgentError(String(cause));
      } finally {
        if (version === sessionVersion.current) setAgentCreating(false);
      }
    },
    [loadAgentSessions],
  );
  const resumeAgentSession = useCallback(
    async (workspaceId: string, persistedSessionId: string) => {
      const version = ++sessionVersion.current;
      currentSessionId.current = "";
      activeAssistantId.current = "";
      activeThinkingId.current = "";
      setAgentSession(null);
      setAgentMessages([]);
      setAgentApprovals([]);
      setActivePersistedSessionId(persistedSessionId);
      setAgentError("");
      setAgentRunning(false);
      setAgentCreating(true);
      setAgentStopping(false);
      try {
        const next = await host.resumeAgentSession(
          workspaceId,
          persistedSessionId,
        );
        if (version !== sessionVersion.current) return;
        currentSessionId.current = next.sessionId;
        setAgentSession(next);
        const restored = pendingRestoredEvents.current.get(next.sessionId);
        if (restored !== undefined) {
          pendingRestoredEvents.current.delete(next.sessionId);
          consumeAgentEvent(restored);
        }
      } catch (cause) {
        if (version === sessionVersion.current) setAgentError(String(cause));
      } finally {
        if (version === sessionVersion.current) setAgentCreating(false);
      }
    },
    [consumeAgentEvent],
  );
  useEffect(() => {
    if (!pendingAgentCommand || mode !== "agent" || !workspace || agentCreating)
      return;
    if (agentRunning) {
      setAgentError("请先停止当前运行，再切换会话。");
      setPendingAgentCommand(null);
      return;
    }
    const command = pendingAgentCommand;
    setPendingAgentCommand(null);
    autoWorkspace.current = workspace.id;
    if (command === "new") {
      void beginAgentSession(workspace.id);
    } else {
      const workspaceId = workspace.id;
      void host
        .listAgentSessions(workspaceId)
        .then((sessions) => {
          if (currentWorkspaceId.current !== workspaceId) return;
          const latest = [...sessions].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          )[0];
          if (latest) void resumeAgentSession(workspaceId, latest.sessionId);
          else setAgentError("此工作区没有可继续的会话，请新建会话。");
        })
        .catch((cause) => setAgentError(String(cause)));
    }
  }, [
    pendingAgentCommand,
    mode,
    workspace,
    agentCreating,
    agentRunning,
    beginAgentSession,
    resumeAgentSession,
  ]);
  useEffect(() => {
    if (mode !== "agent" || !workspace) {
      sessionsRequestVersion.current += 1;
      setSessionsLoading(false);
      setAgentSessions([]);
      return;
    }
    void loadAgentSessions(workspace.id);
  }, [loadAgentSessions, mode, workspace]);
  useEffect(() => {
    if (mode !== "agent" || pendingAgentCommand) return;
    if (!workspace) {
      autoWorkspace.current = "";
      currentSessionId.current = "";
      setAgentSession(null);
      setAgentMessages([]);
      setAgentApprovals([]);
      setActivePersistedSessionId(null);
      return;
    }
    if (
      agentSession?.workspaceId !== workspace.id &&
      autoWorkspace.current !== workspace.id
    ) {
      autoWorkspace.current = workspace.id;
      void beginAgentSession(workspace.id);
    }
  }, [
    agentSession?.workspaceId,
    beginAgentSession,
    mode,
    workspace,
    pendingAgentCommand,
  ]);
  const sendAgentPrompt = async () => {
    const text = agentInput.trim();
    const session = agentSession;
    if (!text || !session || agentRunning) return;
    setAgentInput("");
    setAgentError("");
    setAgentMessages((items) => [
      ...items,
      {
        id: `local-user-${Date.now()}`,
        kind: "user",
        title: "你",
        text,
        status: "done",
      },
    ]);
    setAgentRunning(true);
    try {
      await host.agentPrompt(session.sessionId, text);
    } catch (cause) {
      setAgentError(String(cause));
      if (currentSessionId.current === session.sessionId)
        setAgentRunning(false);
    }
  };
  const stopAgent = async () => {
    const session = agentSession;
    if (!session || agentStopping) return;
    setAgentStopping(true);
    setAgentError("");
    try {
      await host.agentAbort(session.sessionId);
    } catch (cause) {
      setAgentError(String(cause));
      setAgentStopping(false);
    }
  };
  const resolveAgentApproval = async (requestId: string, approved: boolean) => {
    setResolvingApprovals((items) => new Set(items).add(requestId));
    setAgentError("");
    try {
      await host.agentApprovalRespond(requestId, approved);
      setAgentApprovals((items) =>
        items.filter((item) => item.requestId !== requestId),
      );
    } catch (cause) {
      setAgentError(String(cause));
    } finally {
      setResolvingApprovals((items) => {
        const next = new Set(items);
        next.delete(requestId);
        return next;
      });
    }
  };
  const update = (patch: Partial<Preferences>) =>
    run(async () => {
      if (preferences) await host.setPreferences({ ...preferences, ...patch });
    });
  const minimizeWindow = () => {
    if (nativeHostAvailable) void getCurrentWindow().minimize();
  };
  const toggleMaximizeWindow = () => {
    if (nativeHostAvailable) void getCurrentWindow().toggleMaximize();
  };
  const closeWindow = () => {
    if (nativeHostAvailable) void getCurrentWindow().close();
  };
  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region>
        <IconButton
          className={
            "titlebar-button " + (preferences?.sidebarCollapsed ? "" : "active")
          }
          label={preferences?.sidebarCollapsed ? "展开菜单栏" : "收起菜单栏"}
          disabled={!snapshot}
          onClick={() =>
            void update({ sidebarCollapsed: !preferences?.sidebarCollapsed })
          }
        >
          <PanelLeft size={17} />
        </IconButton>
        <div className="titlebar-drag" data-tauri-drag-region>
          <span data-tauri-drag-region>NextTools</span>
        </div>
        <div className="titlebar-actions">
          <div className="mode-switch" aria-label="页面模式">
            <button
              aria-pressed={mode === "workbench"}
              disabled={!snapshot}
              onClick={() => void update({ mode: "workbench" })}
            >
              工作台
            </button>
            <button
              aria-pressed={mode === "agent"}
              disabled={!snapshot}
              onClick={() => void update({ mode: "agent" })}
            >
              Agent
            </button>
          </div>
          {mode === "agent" ? (
            <>
              <IconButton
                className={gitOpen ? "active" : ""}
                label={gitOpen ? "关闭 Git 状态" : "查看 Git 状态"}
                disabled={!workspace}
                onClick={() => setGitOpen((value) => !value)}
              >
                <GitBranch size={17} />
              </IconButton>
              <IconButton
                label="新建会话"
                disabled={!workspace || agentCreating || agentRunning}
                onClick={() =>
                  workspace && void beginAgentSession(workspace.id)
                }
              >
                <Plus size={18} />
              </IconButton>
            </>
          ) : view === "files" && filePlugin?.enabled ? (
            <IconButton
              label="刷新文件列表"
              onClick={() =>
                void run(() =>
                  host.executeCommand(filePlugin.manifest.id, "refresh"),
                )
              }
            >
              <RefreshCw size={17} />
            </IconButton>
          ) : null}
          {preferences?.sidebarCollapsed && (
            <IconButton label="设置" onClick={() => setSettings(true)}>
              <Settings size={17} />
            </IconButton>
          )}
        </div>
        {nativeHostAvailable && (
          <div className="window-controls">
            <IconButton label="最小化" onClick={minimizeWindow}>
              <Minus size={16} />
            </IconButton>
            <IconButton label="最大化或还原" onClick={toggleMaximizeWindow}>
              <Square size={13} />
            </IconButton>
            <IconButton
              className="window-close"
              label="关闭"
              onClick={closeWindow}
            >
              <X size={17} />
            </IconButton>
          </div>
        )}
      </header>
      <div className="app-body">
        <aside
          className={
            "sidebar " + (preferences?.sidebarCollapsed ? "is-collapsed" : "")
          }
          aria-label={mode === "agent" ? "Agent 会话导航" : "工作台插件导航"}
          inert={preferences?.sidebarCollapsed}
        >
          <div className="sidebar-inner">
            {mode === "workbench" ? (
              <>
                <div className="sidebar-heading">
                  <strong>NextTools</strong>
                  <small>本地工作台</small>
                </div>
                <div className="sidebar-scroll">
                  <div className="sidebar-section">工作台</div>
                  <button
                    className={
                      "sidebar-button " + (view === "home" ? "selected" : "")
                    }
                    onClick={() => void update({ workbenchView: "home" })}
                  >
                    <Home size={16} />
                    首页
                  </button>
                  {filePlugin?.enabled && (
                    <button
                      className={
                        "sidebar-button " + (view === "files" ? "selected" : "")
                      }
                      onClick={() =>
                        void run(() =>
                          host.executeCommand(filePlugin.manifest.id, "open"),
                        )
                      }
                    >
                      <Files size={16} />
                      工作区文件
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="sidebar-heading">
                  <strong>Agent</strong>
                  <small>本地开发代理</small>
                </div>
                <button
                  className="sidebar-button"
                  disabled={!workspace || agentCreating || agentRunning}
                  onClick={() =>
                    workspace && void beginAgentSession(workspace.id)
                  }
                >
                  <Plus size={16} />
                  新建会话
                </button>
                <div className="sidebar-scroll">
                  <div className="sidebar-section-row">
                    <div className="sidebar-section">工作区</div>
                    <IconButton
                      className="workspace-add"
                      label="打开工作区"
                      disabled={!snapshot || agentCreating || agentRunning}
                      onClick={() => void run(() => host.chooseWorkspace())}
                    >
                      <Plus size={15} />
                    </IconButton>
                  </div>
                  {snapshot?.workspaces.map((item) => (
                    <button
                      key={item.id}
                      className={
                        "sidebar-button " +
                        (workspace?.id === item.id ? "selected" : "")
                      }
                      disabled={agentCreating || agentRunning}
                      onClick={() =>
                        void update({ activeWorkspaceId: item.id })
                      }
                    >
                      <ChevronRight size={14} />
                      <span>{item.name}</span>
                    </button>
                  ))}
                  {!snapshot?.workspaces.length && (
                    <p className="sidebar-empty">尚未选择工作区</p>
                  )}
                  <div className="sidebar-section">会话</div>
                  {agentSession && !activePersistedSessionId && (
                    <button className="sidebar-button selected" disabled>
                      <Bot size={15} />
                      <span>新会话</span>
                    </button>
                  )}
                  {agentSessions.map((item) => {
                    const selected =
                      activePersistedSessionId === item.sessionId;
                    return (
                      <button
                        key={item.sessionId}
                        className={
                          "sidebar-button session-button " +
                          (selected ? "selected" : "")
                        }
                        aria-current={selected ? "page" : undefined}
                        disabled={agentCreating || agentRunning || selected}
                        onClick={() =>
                          workspace &&
                          void resumeAgentSession(workspace.id, item.sessionId)
                        }
                      >
                        <Bot size={15} />
                        <span>{item.title || "未命名会话"}</span>
                      </button>
                    );
                  })}
                  {sessionsLoading && (
                    <p className="sidebar-empty">正在读取会话…</p>
                  )}
                  {!sessionsLoading &&
                    !agentSession &&
                    agentSessions.length === 0 && (
                      <p className="sidebar-empty">
                        {agentCreating ? "正在创建会话…" : "选择工作区以开始"}
                      </p>
                    )}
                </div>
              </>
            )}
            <div className="sidebar-footer">
              <span className="muted">
                {snapshot ? "本机 · SQLite" : "宿主未连接"}
              </span>
              <IconButton label="设置" onClick={() => setSettings(true)}>
                <Settings size={17} />
              </IconButton>
            </div>
          </div>
        </aside>
        <div className="content">
          {error && (
            <div role="alert" className="app-error">
              {error}
              <button aria-label="关闭错误" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {mode === "agent" && gitOpen && (
            <GitOverlay
              status={gitStatus}
              loading={gitLoading}
              error={gitError}
              onClose={() => setGitOpen(false)}
              onRefresh={() => workspace && void loadGit(workspace.id)}
            />
          )}
          <main className="main-container">
            <div className="mode-page" hidden={mode !== "workbench"}>
              {!nativeHostAvailable ? (
                <div className="empty-state">
                  <h1>NextTools</h1>
                  <p>请在 Tauri 桌面应用中使用本地工作区。</p>
                  <small>浏览器预览不提供文件访问或模拟 Host。</small>
                </div>
              ) : !snapshot ? (
                <div className="empty-state">
                  <p>{error ? "宿主加载失败" : "正在连接本地宿主…"}</p>
                  <button onClick={() => void run(refresh)}>重新连接</button>
                </div>
              ) : view === "files" && filePlugin?.enabled ? (
                <FilesView
                  host={host}
                  workspace={workspace}
                  revision={revision}
                />
              ) : (
                <div className="workbench-home">
                  <div className="wordmark">NextTools</div>
                  <p className="home-caption">
                    工作台 · {workspace?.name ?? "选择工作区以开始"}
                  </p>
                  <div className="home-plugins">
                    {snapshot.plugins
                      .filter((plugin) => plugin.enabled)
                      .map((plugin) => (
                        <section
                          className="plugin-card"
                          key={plugin.manifest.id}
                        >
                          {plugin.manifest.kind === "agent-runtime" ? (
                            <Bot size={21} />
                          ) : (
                            <Files size={21} />
                          )}
                          <h2>{plugin.manifest.name}</h2>
                          <p>
                            {plugin.manifest.kind} ·{" "}
                            {plugin.manifest.contributes.commands.length} 条命令
                          </p>
                          <div className="plugin-card-actions">
                            {plugin.manifest.contributes.commands.map(
                              (command) => (
                                <button
                                  key={command.id}
                                  onClick={() =>
                                    void run(() =>
                                      host.executeCommand(
                                        plugin.manifest.id,
                                        command.id,
                                      ),
                                    )
                                  }
                                >
                                  {command.title} <ChevronRight size={14} />
                                </button>
                              ),
                            )}
                          </div>
                        </section>
                      ))}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setSettings(true)}
                  >
                    管理插件与快捷键
                  </button>
                </div>
              )}
            </div>
            <div className="mode-page" hidden={mode !== "agent"}>
              <AgentPage
                workspaceName={workspace?.name ?? null}
                session={agentSession}
                messages={agentMessages}
                input={agentInput}
                running={agentRunning}
                creating={agentCreating}
                stopping={agentStopping}
                error={agentError}
                approvals={agentApprovals}
                resolvingApprovals={resolvingApprovals}
                onInput={setAgentInput}
                onSend={() => void sendAgentPrompt()}
                onStop={() => void stopAgent()}
                onRetry={() => {
                  if (!workspace) return;
                  if (activePersistedSessionId) {
                    void resumeAgentSession(
                      workspace.id,
                      activePersistedSessionId,
                    );
                  } else {
                    void beginAgentSession(workspace.id);
                  }
                }}
                onOpenWorkspace={() => void run(() => host.chooseWorkspace())}
                onDismissError={() => setAgentError("")}
                onResolveApproval={(requestId, approved) =>
                  void resolveAgentApproval(requestId, approved)
                }
              />
            </div>
          </main>
        </div>
      </div>
      <dialog
        ref={dialog}
        className="settings-dialog"
        onCancel={() => setSettings(false)}
        onClose={() => setSettings(false)}
      >
        <div className="dialog-heading">
          <h2>设置</h2>
          <IconButton label="关闭设置" onClick={() => setSettings(false)}>
            <X size={18} />
          </IconButton>
        </div>
        {snapshot && settings ? (
          <SettingsContent snapshot={snapshot} update={update} run={run} />
        ) : (
          <p>本地设置需要连接 Tauri Host。</p>
        )}
      </dialog>
    </div>
  );
}

function GitOverlay({
  status,
  loading,
  error,
  onClose,
  onRefresh,
}: {
  status: GitStatus | null;
  loading: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="git-overlay" aria-label="Git 状态">
      <header>
        <div>
          <GitBranch size={16} />
          <strong>{status?.branch || "Git 状态"}</strong>
        </div>
        <div>
          <IconButton
            label="刷新 Git 状态"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? "spin" : ""} size={15} />
          </IconButton>
          <IconButton label="关闭 Git 状态" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      {error ? (
        <p className="git-overlay-error" role="alert">
          {error}
        </p>
      ) : loading && !status ? (
        <p className="git-overlay-empty">正在读取仓库状态…</p>
      ) : status?.changes.length ? (
        <div className="git-change-list">
          {status.changes.map((change) => (
            <div
              className="git-change"
              key={`${change.path}-${change.indexStatus}-${change.worktreeStatus}`}
            >
              <code>
                {change.indexStatus}
                {change.worktreeStatus}
              </code>
              <span title={change.path}>{change.path}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="git-overlay-empty">工作区没有未提交变更。</p>
      )}
    </aside>
  );
}

function AgentPage({
  workspaceName,
  session,
  messages,
  input,
  running,
  creating,
  stopping,
  error,
  approvals,
  resolvingApprovals,
  onInput,
  onSend,
  onStop,
  onRetry,
  onOpenWorkspace,
  onDismissError,
  onResolveApproval,
}: {
  workspaceName: string | null;
  session: AgentSessionInfo | null;
  messages: AgentTimelineItem[];
  input: string;
  running: boolean;
  creating: boolean;
  stopping: boolean;
  error: string;
  approvals: AgentApproval[];
  resolvingApprovals: Set<string>;
  onInput: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRetry: () => void;
  onOpenWorkspace: () => void;
  onDismissError: () => void;
  onResolveApproval: (requestId: string, approved: boolean) => void;
}) {
  const timeline = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = timeline.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, approvals, running]);

  if (!workspaceName) {
    return (
      <div className="empty-state agent-empty">
        <Bot size={28} strokeWidth={1.5} />
        <h1>选择一个工作区</h1>
        <p>Pi Agent 只会访问当前授权的工作区。</p>
        <button onClick={onOpenWorkspace}>打开工作区</button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="empty-state agent-empty">
        {creating ? (
          <LoaderCircle className="spin" size={26} />
        ) : (
          <CircleAlert size={26} />
        )}
        <h2>{creating ? "正在启动 Pi Agent" : "无法创建会话"}</h2>
        <p>{creating ? `正在连接 ${workspaceName}…` : error}</p>
        {!creating && <button onClick={onRetry}>重试</button>}
      </div>
    );
  }

  return (
    <section className="agent-page" aria-label="Pi Agent 会话">
      <div className="agent-timeline" ref={timeline} aria-live="polite">
        {messages.length === 0 && !running ? (
          <div className="agent-welcome">
            <Bot size={25} strokeWidth={1.5} />
            <h1>从 {workspaceName} 开始</h1>
            <p>描述目标、粘贴错误，或让 Pi 检查当前代码。</p>
          </div>
        ) : (
          messages.map((message) => (
            <article
              className={`agent-message agent-message-${message.kind}`}
              key={message.id}
            >
              <div className="agent-message-icon" aria-hidden="true">
                {message.kind === "user" ? (
                  <User size={15} />
                ) : message.kind === "thinking" ? (
                  <Brain size={15} />
                ) : message.kind === "tool" ? (
                  <Wrench size={15} />
                ) : (
                  <Bot size={15} />
                )}
              </div>
              <div className="agent-message-body">
                <div className="agent-message-heading">
                  <strong>{message.title}</strong>
                  {message.status === "running" && (
                    <span className="agent-message-status">
                      <LoaderCircle className="spin" size={12} />
                      运行中
                    </span>
                  )}
                  {message.status === "error" && (
                    <span className="agent-message-status error">失败</span>
                  )}
                </div>
                {message.text ? (
                  <pre>{message.text}</pre>
                ) : (
                  <span className="agent-pending">等待输出…</span>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <div className="agent-dock">
        {error && (
          <div className="agent-inline-error" role="alert">
            <CircleAlert size={15} />
            <span>{error}</span>
            <button aria-label="关闭 Agent 错误" onClick={onDismissError}>
              <X size={14} />
            </button>
          </div>
        )}
        {approvals.length > 0 && (
          <section className="approval-dock" aria-label="待批准的工具调用">
            {approvals.map((approval) => {
              const resolving = resolvingApprovals.has(approval.requestId);
              return (
                <article className="approval-request" key={approval.requestId}>
                  <div className="approval-copy">
                    <strong>{approval.toolName || "工具调用"}</strong>
                    <span>请求在此桌面执行</span>
                    <pre>{displayJson(approval.input) || "无参数"}</pre>
                  </div>
                  <div className="approval-actions">
                    <button
                      className="approval-reject"
                      disabled={resolving}
                      onClick={() =>
                        onResolveApproval(approval.requestId, false)
                      }
                    >
                      <Ban size={14} /> 拒绝
                    </button>
                    <button
                      className="approval-accept"
                      disabled={resolving}
                      onClick={() =>
                        onResolveApproval(approval.requestId, true)
                      }
                    >
                      {resolving ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Check size={14} />
                      )}
                      批准
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
        <form
          className="agent-composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <textarea
            aria-label="发送消息给 Pi Agent"
            placeholder="给 Pi 一项任务…"
            rows={1}
            value={input}
            disabled={creating || running}
            onChange={(event) => onInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          {running ? (
            <button
              className="composer-action stop"
              type="button"
              aria-label="停止运行"
              disabled={stopping}
              onClick={onStop}
            >
              {stopping ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <StopCircle size={17} />
              )}
            </button>
          ) : (
            <button
              className="composer-action"
              type="submit"
              aria-label="发送消息"
              disabled={!input.trim()}
            >
              <Send size={17} />
            </button>
          )}
        </form>
        <div className="agent-session-meta">
          <span>{running ? "Pi 正在工作" : "就绪"}</span>
          <span>{session.model || "默认模型"}</span>
        </div>
      </div>
    </section>
  );
}

function SettingsContent({
  snapshot,
  update,
  run,
}: {
  snapshot: HostSnapshot;
  update: (patch: Partial<Preferences>) => Promise<void>;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [tab, setTab] = useState("general");
  const [keys, setKeys] = useState<Record<string, string>>({});
  useEffect(() => {
    setKeys(
      Object.fromEntries(
        snapshot.shortcuts.map((binding) => [
          binding.pluginId + "/" + binding.commandId,
          binding.accelerator,
        ]),
      ),
    );
  }, [snapshot.shortcuts]);
  return (
    <div className="settings-shell">
      <nav className="settings-navigation" aria-label="设置分类">
        {[
          [
            "NextTools",
            [
              ["general", "通用"],
              ["appearance", "外观"],
            ],
          ],
          [
            "Agent",
            [
              ["models", "模型"],
              ["skills", "Skills"],
              ["mcp", "MCP"],
            ],
          ],
          [
            "扩展",
            [
              ["plugins", "插件"],
              ["shortcuts", "快捷键"],
            ],
          ],
        ].map(([group, entries]) => (
          <div className="settings-nav-group" key={group as string}>
            <span>{group as string}</span>
            {(entries as string[][]).map(([id, label]) => (
              <button
                key={id}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-body">
        {tab === "general" ? (
          <section className="settings-section">
            <header>
              <h2>通用</h2>
              <p>NextTools 的本机数据与运行环境。</p>
            </header>
            <h3>本地存储</h3>
            <p className="muted">
              配置和快捷键保存在当前设备，不参与账号同步。
            </p>
            <code className="database-path">{snapshot.databasePath}</code>
            <p className="muted">
              协议版本 {snapshot.protocolVersion} · {snapshot.platform}
            </p>
          </section>
        ) : tab === "appearance" ? (
          <section className="settings-section">
            <header>
              <h2>外观</h2>
              <p>选择界面使用的明暗模式。</p>
            </header>
            <label className="setting-row">
              <span>
                主题
                <small>系统模式会跟随桌面外观变化。</small>
              </span>
              <select
                value={snapshot.preferences.theme}
                onChange={(event) => void update({ theme: event.target.value })}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
          </section>
        ) : tab === "models" || tab === "skills" || tab === "mcp" ? (
          <AgentSettingsPane tab={tab} />
        ) : tab === "plugins" ? (
          <section className="settings-section">
            <header>
              <h2>插件</h2>
              <p>控制工作台中可用的本机插件。</p>
            </header>
            {snapshot.plugins.map((plugin) => (
              <article className="setting-plugin" key={plugin.manifest.id}>
                <label className="setting-row">
                  <span>
                    {plugin.manifest.name}
                    <small>{plugin.manifest.version} · 官方内置</small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={"启用" + plugin.manifest.name}
                    checked={plugin.enabled}
                    onChange={(event) =>
                      void run(() =>
                        host.setPluginEnabled(
                          plugin.manifest.id,
                          event.target.checked,
                        ),
                      )
                    }
                  />
                </label>
                <p className="muted">
                  已声明能力：{plugin.manifest.capabilities.join("、")}
                </p>
                <small>所有系统能力仍由 Rust Host 授权、审批并执行。</small>
              </article>
            ))}
          </section>
        ) : (
          <section className="settings-section">
            <header>
              <h2>快捷键</h2>
              <p>每条命令独立绑定，应用退出后失效。</p>
            </header>
            {snapshot.plugins.map((plugin) => (
              <section className="setting-plugin" key={plugin.manifest.id}>
                <h3>{plugin.manifest.name}</h3>
                {plugin.manifest.contributes.commands.map((command) => {
                  const key = plugin.manifest.id + "/" + command.id;
                  const binding = snapshot.shortcuts.find(
                    (item) =>
                      item.pluginId === plugin.manifest.id &&
                      item.commandId === command.id,
                  );
                  return (
                    <div className="shortcut-row" key={key}>
                      <label htmlFor={key}>
                        {command.title}
                        <small>
                          {binding
                            ? binding.status +
                              (binding.error ? ": " + binding.error : "")
                            : "未绑定"}
                        </small>
                      </label>
                      <input
                        id={key}
                        aria-label={command.title + "快捷键"}
                        value={keys[key] ?? ""}
                        onChange={(event) =>
                          setKeys({ ...keys, [key]: event.target.value })
                        }
                        placeholder="未绑定"
                      />
                      <button
                        onClick={() =>
                          void run(() =>
                            host.setShortcut(
                              plugin.manifest.id,
                              command.id,
                              keys[key] ?? null,
                            ),
                          )
                        }
                      >
                        保存
                      </button>
                      <button
                        disabled={!binding}
                        onClick={() =>
                          void run(() =>
                            host.setShortcut(
                              plugin.manifest.id,
                              command.id,
                              null,
                            ),
                          )
                        }
                      >
                        清除
                      </button>
                    </div>
                  );
                })}
              </section>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function AgentSettingsPane({ tab }: { tab: string }) {
  const [state, setState] = useState<AgentSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connectRequest, setConnectRequest] = useState<McpServerConfig | null>(
    null,
  );
  const [editingMcp, setEditingMcp] = useState<McpServerConfig | null>(null);
  const [mcpName, setMcpName] = useState("");
  const [transport, setTransport] =
    useState<McpServerConfig["transport"]>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [deleteRequest, setDeleteRequest] = useState<{
    kind: "skill" | "mcp";
    id: string;
    name: string;
  } | null>(null);

  const initializeModel = (next: AgentSettingsSnapshot) => {
    const selected = next.providers.find((item) => item.id === next.provider);
    const models = next.models.filter(
      (item) => item.provider === (selected?.id ?? next.providers[0]?.id),
    );
    setProvider(selected?.id ?? next.providers[0]?.id ?? "");
    setModel(next.model || models[0]?.id || "");
  };
  const refreshSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await host.agentSettingsSnapshot();
      setState(next);
      initializeModel(next);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);
  useEffect(() => {
    setError("");
    setNotice("");
    setConnectRequest(null);
    setDeleteRequest(null);
  }, [tab]);
  const mutate = async (action: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      const next = await host.agentSettingsSnapshot();
      setState(next);
      initializeModel(next);
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveModel = async () => {
    if (!provider || !model || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await host.agentConfigure(provider, model, apiKey.trim());
      setApiKey("");
      const next = await host.agentSettingsSnapshot();
      setState(next);
      initializeModel(next);
      setNotice("默认模型已保存。现有会话不会被中断。");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const resetMcp = () => {
    setEditingMcp(null);
    setMcpName("");
    setTransport("stdio");
    setCommand("");
    setArgs("");
    setUrl("");
    setEnabled(true);
  };
  const editMcp = (config: McpServerConfig) => {
    setEditingMcp(config);
    setMcpName(config.name);
    setTransport(config.transport);
    setCommand(config.command ?? "");
    setArgs(config.args.join("\n"));
    setUrl(config.url ?? "");
    setEnabled(config.enabled);
  };
  const saveMcp = async () => {
    if (
      !mcpName.trim() ||
      (transport === "stdio" ? !command.trim() : !url.trim())
    )
      return;
    const next: McpServerConfig = {
      id: editingMcp?.id ?? crypto.randomUUID(),
      name: mcpName.trim(),
      transport,
      command: transport === "stdio" ? command.trim() : null,
      args:
        transport === "stdio"
          ? args
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
      url: transport === "http" ? url.trim() : null,
      enabled,
      connected: editingMcp?.connected ?? false,
      error: null,
      tools: editingMcp?.tools ?? [],
    };
    if (await mutate(() => host.agentMcpSave(next))) resetMcp();
  };
  const deleteConfirmed = async () => {
    const request = deleteRequest;
    if (!request) return;
    const success = await mutate(() =>
      request.kind === "skill"
        ? host.agentSkillRemove(request.id)
        : host.agentMcpRemove(request.id),
    );
    if (success) {
      if (editingMcp?.id === request.id) resetMcp();
      setDeleteRequest(null);
    }
  };
  const selectedProvider = state?.providers.find(
    (item) => item.id === provider,
  );
  const providerModels =
    state?.models.filter((item) => item.provider === provider) ?? [];
  const title = tab === "models" ? "模型" : tab === "skills" ? "Skills" : "MCP";
  const selectedModel = providerModels.find((item) => item.id === model);

  return (
    <section className="settings-section">
      <header>
        <h2>{title}</h2>
        <p>
          {tab === "models"
            ? "从真实模型目录选择默认提供商和模型。"
            : tab === "skills"
              ? "管理本机的 Agent 指令包。"
              : "配置本机 stdio 或远程 URL MCP server。"}
        </p>
      </header>
      <p className="settings-note">
        配置影响新创建或恢复的会话，现有会话不会被中断。系统能力始终由 Rust Host
        执行。
      </p>
      {loading && (
        <p className="settings-loading">
          <LoaderCircle className="spin" size={15} />
          正在读取设置…
        </p>
      )}
      {error && (
        <div className="settings-error" role="alert">
          <CircleAlert size={15} />
          <span>{error}</span>
          <button
            disabled={busy || loading}
            onClick={() => void refreshSettings()}
          >
            重试
          </button>
        </div>
      )}
      {notice && (
        <p className="agent-config-status" role="status">
          {notice}
        </p>
      )}
      {deleteRequest && (
        <div className="settings-delete-confirm" role="alert">
          <span>确定删除“{deleteRequest.name}”？此操作移除本机配置。</span>
          <button disabled={busy} onClick={() => setDeleteRequest(null)}>
            取消
          </button>
          <button
            className="settings-danger-button"
            disabled={busy}
            onClick={() => void deleteConfirmed()}
          >
            确认删除
          </button>
        </div>
      )}
      {connectRequest && (
        <div className="settings-delete-confirm" role="alert">
          <span>
            允许“{connectRequest.name}”启动本机进程或访问网络并连接 MCP？
          </span>
          <button disabled={busy} onClick={() => setConnectRequest(null)}>
            取消
          </button>
          <button
            className="settings-primary-button"
            disabled={busy}
            onClick={() => {
              const request = connectRequest;
              void mutate(() => host.agentMcpConnect(request.id, true)).then(
                (success) => {
                  if (success) setConnectRequest(null);
                },
              );
            }}
          >
            批准并连接
          </button>
        </div>
      )}
      {state && tab === "models" && (
        <form
          className="agent-settings"
          onSubmit={(event) => {
            event.preventDefault();
            void saveModel();
          }}
        >
          <fieldset disabled={busy}>
            <label>
              提供商
              <select
                value={provider}
                onChange={(event) => {
                  const nextProvider = event.target.value;
                  setProvider(nextProvider);
                  setModel(
                    state.models.find((item) => item.provider === nextProvider)
                      ?.id ?? "",
                  );
                  setApiKey("");
                }}
              >
                {state.providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                    {item.hasApiKey ? " · 已配置" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              模型
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {model && !providerModels.some((item) => item.id === model) && (
                  <option value={model}>{model} · 当前配置</option>
                )}
                {providerModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.reasoning ? " · reasoning" : ""}
                  </option>
                ))}
              </select>
              {selectedModel && (
                <small>
                  上下文{" "}
                  {selectedModel.contextWindow?.toLocaleString() ?? "未知"} ·
                  最大输出 {selectedModel.maxTokens?.toLocaleString() ?? "未知"}
                </small>
              )}
            </label>
            <label>
              API Key
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  selectedProvider?.hasApiKey
                    ? "留空保留系统凭据中的现有密钥"
                    : "输入提供商 API Key"
                }
              />
            </label>
            <small>
              密钥仅发送给 Rust
              Host，保存在系统凭据存储；不会回传或写入浏览器存储。
            </small>
            <button
              className="settings-primary-button"
              type="submit"
              disabled={!provider || !model}
            >
              保存默认模型
            </button>
          </fieldset>
        </form>
      )}
      {state && tab === "skills" && (
        <>
          <div className="settings-inline-form">
            <div>
              <strong>从本机导入</strong>
              <p className="muted">
                选择一个 Skill 文件或目录；导入后可单独启停。
              </p>
            </div>
            <button
              disabled={busy}
              onClick={() => void mutate(() => host.agentSkillImport())}
            >
              选择并导入
            </button>
          </div>
          <div className="settings-entity-list">
            {state.skills.map((skill) => (
              <article className="settings-entity" key={skill.id}>
                <div>
                  <strong>{skill.name}</strong>
                  <p>{skill.description || "此 Skill 没有说明。"}</p>
                  <small>{skill.filePath}</small>
                </div>
                <div className="settings-entity-actions">
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void mutate(() =>
                          host.agentSkillSetEnabled(
                            skill.id,
                            event.target.checked,
                          ),
                        )
                      }
                    />
                    启用
                  </label>
                  <button
                    className="settings-danger-button"
                    disabled={busy}
                    onClick={() =>
                      setDeleteRequest({
                        kind: "skill",
                        id: skill.id,
                        name: skill.name,
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
            {!state.skills.length && (
              <p className="settings-empty">
                尚未导入 Skill。选择本机文件或目录以开始。
              </p>
            )}
          </div>
        </>
      )}
      {state && tab === "mcp" && (
        <>
          <form
            className="mcp-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void saveMcp();
            }}
          >
            <fieldset disabled={busy}>
              <div className="mcp-editor-heading">
                <strong>
                  {editingMcp ? `编辑 ${editingMcp.name}` : "新增 MCP server"}
                </strong>
                {editingMcp && (
                  <button type="button" onClick={resetMcp}>
                    取消编辑
                  </button>
                )}
              </div>
              <label>
                名称
                <input
                  value={mcpName}
                  onChange={(event) => setMcpName(event.target.value)}
                  placeholder="例如 filesystem"
                  spellCheck={false}
                />
              </label>
              <label>
                传输
                <select
                  value={transport}
                  onChange={(event) =>
                    setTransport(
                      event.target.value as McpServerConfig["transport"],
                    )
                  }
                >
                  <option value="stdio">stdio</option>
                  <option value="http">HTTP</option>
                </select>
              </label>
              {transport === "stdio" ? (
                <>
                  <label>
                    命令
                    <input
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                      placeholder="npx"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    参数（每行一个）
                    <textarea
                      rows={3}
                      value={args}
                      onChange={(event) => setArgs(event.target.value)}
                      placeholder={
                        "-y\n@modelcontextprotocol/server-filesystem"
                      }
                      spellCheck={false}
                    />
                  </label>
                </>
              ) : (
                <label>
                  URL
                  <input
                    type="url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://mcp.example.com"
                    spellCheck={false}
                  />
                </label>
              )}
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                启用
              </label>
              <button
                className="settings-primary-button"
                type="submit"
                disabled={
                  !mcpName.trim() ||
                  (transport === "stdio" ? !command.trim() : !url.trim())
                }
              >
                保存配置
              </button>
            </fieldset>
          </form>
          <div className="settings-entity-list">
            {state.mcpServers.map((server) => (
              <article className="settings-entity mcp-server" key={server.id}>
                <div>
                  <div className="mcp-server-title">
                    <strong>{server.name}</strong>
                    <span>{server.connected ? "已连接" : "未连接"}</span>
                  </div>
                  <p>{server.transport}</p>
                  <small>{server.url ?? server.command}</small>
                  {server.tools.length > 0 && (
                    <small>工具：{server.tools.join("、")}</small>
                  )}
                  {server.error && (
                    <small className="error">{server.error}</small>
                  )}
                </div>
                <div className="settings-entity-actions">
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      disabled={busy}
                      onChange={(event) =>
                        void mutate(() =>
                          host.agentMcpSave({
                            ...server,
                            enabled: event.target.checked,
                          }),
                        )
                      }
                    />
                    启用
                  </label>
                  <button disabled={busy} onClick={() => editMcp(server)}>
                    编辑
                  </button>
                  {server.connected ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate(() => host.agentMcpDisconnect(server.id))
                      }
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      disabled={busy || !server.enabled}
                      onClick={() => setConnectRequest(server)}
                    >
                      连接
                    </button>
                  )}
                  <button
                    className="settings-danger-button"
                    disabled={busy}
                    onClick={() =>
                      setDeleteRequest({
                        kind: "mcp",
                        id: server.id,
                        name: server.name,
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
            {!state.mcpServers.length && (
              <p className="settings-empty">
                尚未添加 MCP server。保存配置后可显式批准连接。
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
