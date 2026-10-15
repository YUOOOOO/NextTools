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
import { AgentExplorer, AgentFilePreview } from "./agent-explorer";

import { asRecord, stringField, displayJson, createLiveSession, reduceAgentEvent, type LiveAgentSession, type AgentTimelineItem, type AgentApproval } from "./agent-sessions";

export function App() {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  const [revision, setRevision] = useState(0);
  const [agentPanel, setAgentPanel] = useState<"explorer" | "chat" | "git">("chat");
  const [fileSelection, setFileSelection] = useState<{ workspaceId: string; path: string } | null>(null);
  const gitRequestVersion = useRef(0);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const [pendingAgentCommand, setPendingAgentCommand] = useState<
    "new" | "continue" | null
  >(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [liveSessions, setLiveSessions] = useState<LiveAgentSession[]>([]);
  const liveSessionsRef = useRef(liveSessions);
  const [activeSessions, setActiveSessions] = useState<Record<string, string>>({});
  const selectionVersions = useRef(new Map<string, number>());
  const [creatingWorkspaces, setCreatingWorkspaces] = useState<Set<string>>(() => new Set());
  const openingSessions = useRef(new Map<string, Promise<void>>());
  const initializedWorkspaces = useRef(new Set<string>());
  const pendingEvents = useRef(new Map<string, unknown[]>());
  const closedSessions = useRef(new Set<string>());
  const changeSessions = useCallback((change: (items: LiveAgentSession[]) => LiveAgentSession[]) => {
    const next = change(liveSessionsRef.current);
    liveSessionsRef.current = next;
    setLiveSessions(next);
  }, []);
  const changeSession = useCallback((id: string, change: (session: LiveAgentSession) => LiveAgentSession) => {
    changeSessions((items) => items.map((item) => item.info.sessionId === id ? change(item) : item));
  }, [changeSessions]);
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
  const consumeAgentEvent = useCallback((sessionId: string, event: unknown) => {
    const session = liveSessionsRef.current.find((item) => item.info.sessionId === sessionId);
    if (!session) {
      if (!closedSessions.current.has(sessionId) && openingSessions.current.size) {
        pendingEvents.current.set(sessionId, [...(pendingEvents.current.get(sessionId) ?? []), event]);
      }
      return;
    }
    if (session.unavailable) return;
    changeSession(sessionId, (item) => reduceAgentEvent(item, event));
    const type = stringField(asRecord(event), "type");
    if (type === "agent_end" || type === "agent_settled") loadAgentSessionsRef.current(session.info.workspaceId);
  }, [changeSession]);
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
        consumeAgentEvent(sessionId, envelope.event);
      }),
      listen<unknown>("agent:approval", ({ payload }) => {
        const request = asRecord(payload);
        if (!request) return;
        const requestId = stringField(request, "requestId");
        const sessionId = stringField(request, "sessionId");
        const toolName = stringField(request, "toolName");
        if (!requestId || !sessionId) return;
        consumeAgentEvent(sessionId, { ...request, type: "approval", toolName });
      }),
      listen<unknown>("agent:error", ({ payload }) => {
        const value = asRecord(payload);
        const detail = value?.error ?? payload;
        const sessionId = stringField(value, "sessionId");
        if (sessionId) consumeAgentEvent(sessionId, { type: "error", error: detail });
        else setError(displayJson(detail));
      }),
      listen<unknown>("agent:approval-resolved", ({ payload }) => {
        const request = asRecord(payload);
        const requestId = request && stringField(request, "requestId");
        if (!requestId) return;
        const sessionId = stringField(request, "sessionId");
        consumeAgentEvent(sessionId, { type: "approval_resolved", requestId });
      }),
    ]).then((unlisten) => {
      if (stopped) unlisten.forEach((fn) => fn());
      else cleanup = unlisten;
    });
    return () => {
      stopped = true;
      cleanup.forEach((fn) => fn());
    };
  }, [consumeAgentEvent, changeSession, changeSessions]);
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
  const selectedFile = fileSelection?.workspaceId === workspace?.id ? fileSelection?.path ?? null : null;
  const filePlugin = snapshot?.plugins.find(
    (plugin) => plugin.manifest.id === "com.nexttools.workspace-files",
  );
  const workspaceSessions = liveSessions.filter((item) => item.info.workspaceId === workspace?.id);
  const activeSession = workspaceSessions.find((item) => item.info.sessionId === activeSessions[workspace?.id ?? ""]);
  const agentSession = activeSession?.info ?? null;
  const activePersistedSessionId = agentSession?.persistedSessionId ?? null;
  const agentMessages = activeSession?.messages ?? [];
  const agentInput = activeSession?.input ?? "";
  const agentRunning = activeSession?.running ?? false;
  const agentStopping = activeSession?.stopping ?? false;
  const agentCreating = creatingWorkspaces.has(workspace?.id ?? "");
  const agentError = activeSession?.error ?? "";
  const agentApprovals = activeSession?.approvals ?? [];
  const resolvingApprovals = activeSession?.resolving ?? new Set<string>();
  const setAgentInput = (input: string) => { if (agentSession) changeSession(agentSession.sessionId, (item) => ({ ...item, input })); };
  const setAgentError = (error: string) => { if (agentSession) changeSession(agentSession.sessionId, (item) => ({ ...item, error })); };
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
        setError(String(cause));
      }
    } finally {
      if (version === sessionsRequestVersion.current) setSessionsLoading(false);
    }
  }, []);
  loadAgentSessionsRef.current = (workspaceId) =>
    void loadAgentSessions(workspaceId);
  const loadGit = useCallback(async (workspaceId: string) => {
    const version = ++gitRequestVersion.current;
    setGitLoading(true);
    setGitError("");
    try {
      const status = await host.gitStatus(workspaceId);
      if (version === gitRequestVersion.current && currentWorkspaceId.current === workspaceId) setGitStatus(status);
    } catch (cause) {
      if (version === gitRequestVersion.current && currentWorkspaceId.current === workspaceId)
        setGitError(String(cause));
    } finally {
      if (version === gitRequestVersion.current) setGitLoading(false);
    }
  }, []);
  useEffect(() => {
    setGitStatus(null);
    setGitError("");
    setGitLoading(false);
    if (mode === "agent" && agentPanel === "git" && workspace) void loadGit(workspace.id);
    return () => { gitRequestVersion.current += 1; };
  }, [mode, agentPanel, loadGit, workspace?.id]);
  const openSession = useCallback((workspaceId: string, persistedSessionId?: string): Promise<void> => {
    const existing = persistedSessionId && liveSessionsRef.current.find((item) => item.info.workspaceId === workspaceId && item.info.persistedSessionId === persistedSessionId);
    if (existing) {
      selectionVersions.current.set(workspaceId, (selectionVersions.current.get(workspaceId) ?? 0) + 1);
      setActiveSessions((items) => ({ ...items, [workspaceId]: existing.info.sessionId }));
      return Promise.resolve();
    }
    const opening = openingSessions.current.get(workspaceId);
    if (opening) return opening;
    const selectionVersion = selectionVersions.current.get(workspaceId) ?? 0;
    initializedWorkspaces.current.add(workspaceId);
    setCreatingWorkspaces((items) => new Set(items).add(workspaceId));
    const task = Promise.resolve().then(async () => {
      try {
        const info = persistedSessionId ? await host.resumeAgentSession(workspaceId, persistedSessionId) : await host.agentSessionCreate(workspaceId);
        let session = createLiveSession(info);
        for (const event of pendingEvents.current.get(info.sessionId) ?? []) session = reduceAgentEvent(session, event);
        pendingEvents.current.delete(info.sessionId);
        changeSessions((items) => [...items, session]);
        if ((selectionVersions.current.get(workspaceId) ?? 0) === selectionVersion)
          setActiveSessions((items) => ({ ...items, [workspaceId]: info.sessionId }));
        void loadAgentSessions(workspaceId);
      } catch (cause) {
        setError(String(cause));
      } finally {
        openingSessions.current.delete(workspaceId);
        if (!openingSessions.current.size) pendingEvents.current.clear();
        setCreatingWorkspaces((items) => { const next = new Set(items); next.delete(workspaceId); return next; });
      }
    });
    openingSessions.current.set(workspaceId, task);
    return task;
  }, [changeSessions, loadAgentSessions]);
  const beginAgentSession = useCallback((workspaceId: string) => openSession(workspaceId), [openSession]);
  const resumeAgentSession = useCallback((workspaceId: string, persistedSessionId: string) => openSession(workspaceId, persistedSessionId), [openSession]);
  const closeAgentSession = async (session: LiveAgentSession) => {
    const { sessionId, workspaceId } = session.info;
    if (session.closing) return;
    changeSession(sessionId, (item) => ({ ...item, closing: true, error: "" }));
    try {
      if (!session.unavailable) await host.agentSessionDispose(sessionId);
      const siblings = liveSessionsRef.current.filter((item) => item.info.workspaceId === workspaceId);
      const index = siblings.findIndex((item) => item.info.sessionId === sessionId);
      const next = siblings[index + 1] ?? siblings[index - 1];
      selectionVersions.current.set(workspaceId, (selectionVersions.current.get(workspaceId) ?? 0) + 1);
      closedSessions.current.add(sessionId);
      changeSessions((items) => items.filter((item) => item.info.sessionId !== sessionId));
      setActiveSessions((items) => items[workspaceId] === sessionId ? { ...items, [workspaceId]: next?.info.sessionId ?? "" } : items);
    } catch (cause) {
      changeSession(sessionId, (item) => ({ ...item, closing: false, unavailable: true, running: false, stopping: false, approvals: [], error: `关闭失败，会话已停用。可再次关闭标签并从历史恢复：${String(cause)}` }));
    }
  };
  useEffect(() => {
    if (!pendingAgentCommand || mode !== "agent" || !workspace || agentCreating)
      return;
    const command = pendingAgentCommand;
    setPendingAgentCommand(null);
    initializedWorkspaces.current.add(workspace.id);
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
          else setError("此工作区没有可继续的会话，请新建会话。");
        })
        .catch((cause) => setError(String(cause)));
    }
  }, [
    pendingAgentCommand,
    mode,
    workspace,
    agentCreating,
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
    if (!nativeHostAvailable || mode !== "agent" || pendingAgentCommand || !workspace || initializedWorkspaces.current.has(workspace.id)) return;
    void beginAgentSession(workspace.id);
  }, [beginAgentSession, mode, workspace?.id, pendingAgentCommand]);
  const sendAgentPrompt = async () => {
    if (!activeSession || activeSession.running || activeSession.closing || activeSession.unavailable || !agentInput.trim()) return;
    const id = activeSession.info.sessionId;
    const text = agentInput.trim();
    changeSession(id, (item) => ({ ...item, input: "", error: "", running: true, messages: [...item.messages, { id: `local-user-${Date.now()}`, kind: "user", title: "你", text, status: "done" }] }));
    try {
      const response = await host.agentPrompt(id, text);
      if (response.exportText !== undefined) {
        const url = URL.createObjectURL(new Blob([response.exportText], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = "agent-session.jsonl"; link.click(); URL.revokeObjectURL(url);
      }
      changeSession(id, (item) => ({ ...item, running: false, stopping: false }));
    } catch (cause) {
      changeSession(id, (item) => reduceAgentEvent(item, { type: "error", error: String(cause) }));
    }
  };
  const stopAgent = async () => {
    if (!activeSession || !activeSession.running || activeSession.stopping || activeSession.closing || activeSession.unavailable) return;
    const id = activeSession.info.sessionId;
    changeSession(id, (item) => ({ ...item, stopping: true, error: "" }));
    try { await host.agentAbort(id); }
    catch (cause) { changeSession(id, (item) => ({ ...item, stopping: false, error: String(cause) })); }
  };
  const resolveAgentApproval = async (requestId: string, approved: boolean) => {
    const session = liveSessionsRef.current.find((item) => item.approvals.some((approval) => approval.requestId === requestId));
    if (!session || session.closing || session.unavailable || session.resolving.has(requestId)) return;
    const id = session.info.sessionId;
    changeSession(id, (item) => ({ ...item, error: "", resolving: new Set(item.resolving).add(requestId) }));
    try {
      await host.agentApprovalRespond(requestId, approved);
      changeSession(id, (item) => ({ ...item, approvals: item.approvals.filter((approval) => approval.requestId !== requestId) }));
    } catch (cause) { changeSession(id, (item) => ({ ...item, error: String(cause) })); }
    finally { changeSession(id, (item) => { const resolving = new Set(item.resolving); resolving.delete(requestId); return { ...item, resolving }; }); }
  };
  const update = (patch: Partial<Preferences>) =>
    run(async () => {
      if (preferences) await host.setPreferences({ ...preferences, ...patch });
    });
  const openAgentPanel = (panel: "explorer" | "chat" | "git") => {
    setAgentPanel(panel);
    if (preferences?.sidebarCollapsed) void update({ sidebarCollapsed: false });
  };
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
      <div className="app-sidebar">
        {mode === "agent" && (
          <nav className="agent-activity-bar" aria-label="Agent 工具">
            <IconButton label="资源管理器" className={agentPanel === "explorer" ? "active" : ""} onClick={() => openAgentPanel("explorer")}><Files size={20} /></IconButton>
            <IconButton label="Chat" className={agentPanel === "chat" ? "active" : ""} onClick={() => openAgentPanel("chat")}><Bot size={20} /></IconButton>
            <IconButton label="Git" className={agentPanel === "git" ? "active" : ""} onClick={() => openAgentPanel("git")}><GitBranch size={20} /></IconButton>
          </nav>
        )}
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
                  {snapshot?.plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.manifest.contributes.commands.filter((command) => command.execution === "foreground" && command.viewId && plugin.manifest.contributes.views.includes(command.viewId)).map((command) => (
                    <button key={plugin.manifest.id + "/" + command.id} className={"sidebar-button " + (view === command.viewId ? "selected" : "")} disabled={!workspace} onClick={() => void run(() => host.executeCommand(plugin.manifest.id, command.id))}>
                      {plugin.manifest.kind === "agent-runtime" ? <Bot size={16} /> : <Files size={16} />}
                      <span>{command.title}</span>
                    </button>
                  )))}
                </div>
              </>
            ) : agentPanel === "explorer" ? (
              <AgentExplorer workspace={workspace} selected={selectedFile} onSelect={(path) => { if (workspace) setFileSelection({ workspaceId: workspace.id, path }); }} />
            ) : agentPanel === "git" ? (
              workspace ? <GitOverlay status={gitStatus} loading={gitLoading} error={gitError} onClose={() => setAgentPanel("chat")} onRefresh={() => void loadGit(workspace.id)} /> : <p className="sidebar-empty">请先在 Chat 中选择工作区。</p>
            ) : (
              <>
                <div className="sidebar-heading">
                  <strong>Agent</strong>
                  <small>本地开发代理</small>
                </div>
                <button
                  className="sidebar-button"
                  disabled={!workspace || agentCreating}
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
                      disabled={!snapshot}
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
                        disabled={agentCreating || selected}
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
        </div>
        <div className="app-main">
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
        {mode === "agent" && (
          <div className="agent-session-tabs" role="tablist" aria-label="已打开会话">
            {workspaceSessions.map((session) => (
              <div key={session.info.sessionId} className={"agent-session-tab " + (agentSession?.sessionId === session.info.sessionId ? "selected" : "")}>
                <button role="tab" aria-selected={agentSession?.sessionId === session.info.sessionId} title={session.info.title || "新会话"} onClick={() => { selectionVersions.current.set(session.info.workspaceId, (selectionVersions.current.get(session.info.workspaceId) ?? 0) + 1); setActiveSessions((items) => ({ ...items, [session.info.workspaceId]: session.info.sessionId })); setAgentPanel("chat"); }}>
                  {session.running ? <LoaderCircle size={13} className="spin" /> : <Bot size={13} />}
                  <span>{session.info.title || "新会话"}</span>
                  {session.approvals.length > 0 && <small aria-label="待审批">{session.approvals.length}</small>}
                  {session.error && <CircleAlert size={13} aria-label="会话错误" />}
                </button>
                <button className="session-tab-close" aria-label={"关闭会话 " + (session.info.title || "新会话")} disabled={session.closing} onClick={() => void closeAgentSession(session)}>{session.closing ? <LoaderCircle size={12} className="spin" /> : <X size={12} />}</button>
              </div>
            ))}
          </div>
        )}
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
                label="新建会话"
                disabled={!workspace || agentCreating}
                onClick={() => {
                  openAgentPanel("chat");
                  if (workspace) void beginAgentSession(workspace.id);
                }}
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
        <div className="content">
          {error && (
            <div role="alert" className="app-error">
              {error}
              <button aria-label="关闭错误" onClick={() => setError("")}>
                ×
              </button>
            </div>
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
                                  disabled={!workspace}
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
              <div className="mode-page" hidden={agentPanel !== "explorer"}>
                {agentPanel === "explorer" && <AgentFilePreview workspaceId={workspace?.id ?? null} path={selectedFile} />}
              </div>
              <div className="mode-page" hidden={agentPanel === "explorer"}>
              <AgentPage
                workspaceName={workspace?.name ?? null}
                session={agentSession}
                unavailable={activeSession?.unavailable || activeSession?.closing || false}
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
                onRetry={() => { if (workspace) void beginAgentSession(workspace.id); }}
                onOpenWorkspace={() => void run(() => host.chooseWorkspace())}
                onDismissError={() => setAgentError("")}
                onResolveApproval={(requestId, approved) =>
                  void resolveAgentApproval(requestId, approved)
                }
              />
              </div>
            </div>
          </main>
        </div>
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
  unavailable,
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
  unavailable: boolean;
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
        <h2>{creating ? "正在启动 Pi Agent" : "尚未打开会话"}</h2>
        <p>{creating ? `正在连接 ${workspaceName}…` : "新建会话或从左侧继续历史会话。"}</p>
        {!creating && <button onClick={onRetry}>新建会话</button>}
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
            disabled={creating || running || unavailable}
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
              disabled={!input.trim() || unavailable}
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
