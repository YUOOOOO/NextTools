import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FilesView } from "@nexttools/workspace-files";
import { IconButton } from "@nexttools/ui";
import type {
  CommandEvent,
  GitStatus,
  HostSnapshot,
  Preferences,
} from "@nexttools/protocol";
import {
  ChevronRight,
  Files,
  GitBranch,
  Home,
  Minus,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  Square,
  X,
} from "lucide-react";
import { host, nativeHostAvailable } from "./host";

export function App() {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  const [revision, setRevision] = useState(0);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
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
  const loadGit = useCallback(async (workspaceId: string) => {
    setGitLoading(true);
    setGitError("");
    try {
      setGitStatus(await host.gitStatus(workspaceId));
    } catch (e) {
      setGitStatus(null);
      setGitError(String(e));
    } finally {
      setGitLoading(false);
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
    snapshot?.workspaces.find((item) => item.id === preferences?.activeWorkspaceId) ??
    null;
  const filePlugin = snapshot?.plugins.find(
    (plugin) => plugin.manifest.id === "com.nexttools.workspace-files",
  );
  useEffect(() => {
    if (gitOpen && workspace) void loadGit(workspace.id);
    if (!workspace) setGitStatus(null);
  }, [gitOpen, loadGit, workspace]);
  useEffect(() => {
    if (!gitOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGitOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [gitOpen]);
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
            "titlebar-button " +
            (preferences?.sidebarCollapsed ? "" : "active")
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
            <IconButton label="新建会话（Pi 尚未接入）" disabled>
              <Plus size={18} />
            </IconButton>
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
          {mode === "agent" && (
            <IconButton
              className={"titlebar-button " + (gitOpen ? "active" : "")}
              label={gitOpen ? "关闭 Git 更改" : "打开 Git 更改"}
              disabled={!workspace}
              aria-pressed={gitOpen}
              onClick={() => setGitOpen((open) => !open)}
            >
              <GitBranch size={17} />
            </IconButton>
          )}
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
            <IconButton className="window-close" label="关闭" onClick={closeWindow}>
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
                        "sidebar-button " +
                        (view === "files" ? "selected" : "")
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
                <button className="sidebar-button" disabled>
                  <Plus size={16} />
                  新建会话
                </button>
                <div className="agent-search">
                  <input aria-label="搜索会话" placeholder="搜索会话" disabled />
                </div>
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
                      onClick={() => void update({ activeWorkspaceId: item.id })}
                    >
                      <ChevronRight size={14} />
                      <span>{item.name}</span>
                    </button>
                  ))}
                  {!snapshot?.workspaces.length && (
                    <p className="sidebar-empty">尚未选择工作区</p>
                  )}
                  <div className="sidebar-section">会话</div>
                  <p className="sidebar-empty">Pi runtime 尚未接入</p>
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
                        <section className="plugin-card" key={plugin.manifest.id}>
                          <Files size={21} />
                          <h2>{plugin.manifest.name}</h2>
                          <p>浏览已授权工作区的目录和文本文件</p>
                          <button
                            onClick={() =>
                              void run(() =>
                                host.executeCommand(plugin.manifest.id, "open"),
                              )
                            }
                          >
                            打开 <ChevronRight size={14} />
                          </button>
                        </section>
                      ))}
                  </div>
                  <button className="text-button" onClick={() => setSettings(true)}>
                    管理插件与快捷键
                  </button>
                </div>
              )}
            </div>
            <div className="mode-page" hidden={mode !== "agent"}>
              <div className="empty-state">
                <div className="wordmark">Agent</div>
                <p>Pi Agent 尚未接入</p>
                <small>
                  当前初始化提供工作区、文件浏览与宿主设置。此处不创建模拟会话。
                </small>
              </div>
            </div>
          </main>
          {mode === "agent" && gitOpen && (
            <GitPanel
              status={gitStatus}
              loading={gitLoading}
              error={gitError}
              onClose={() => setGitOpen(false)}
              onRefresh={() => workspace && void loadGit(workspace.id)}
            />
          )}
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
        {snapshot ? (
          <SettingsContent snapshot={snapshot} update={update} run={run} />
        ) : (
          <p>本地设置需要连接 Tauri Host。</p>
        )}
      </dialog>
    </div>
  );
}

function GitPanel({
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
    <aside className="git-panel" aria-label="Git 更改">
      <div className="git-panel-heading">
        <div>
          <strong>Git 更改</strong>
          <small>{status?.branch ?? "当前工作区"}</small>
        </div>
        <IconButton label="刷新 Git 状态" disabled={loading} onClick={onRefresh}>
          <RefreshCw size={16} />
        </IconButton>
        <IconButton label="关闭 Git 更改" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </div>
      <div className="git-panel-body">
        {loading ? (
          <p className="sidebar-empty">正在读取 Git 状态…</p>
        ) : error ? (
          <p className="error">{error}</p>
        ) : status?.changes.length ? (
          status.changes.map((change, index) => (
            <div className="git-change" key={`${change.path}:${index}`}>
              <code>
                {change.indexStatus === " " ? "·" : change.indexStatus}
                {change.worktreeStatus === " " ? "·" : change.worktreeStatus}
              </code>
              <span title={change.path}>{change.path}</span>
            </div>
          ))
        ) : (
          <p className="sidebar-empty">工作区没有未提交更改</p>
        )}
      </div>
    </aside>
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
        snapshot.shortcuts.map((b) => [
          b.pluginId + "/" + b.commandId,
          b.accelerator,
        ]),
      ),
    );
  }, [snapshot.shortcuts]);
  return (
    <>
      <nav className="settings-tabs" aria-label="设置分类">
        {[
          ["general", "通用"],
          ["plugins", "插件"],
          ["shortcuts", "快捷键"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {tab === "general" ? (
          <>
            <label className="setting-row">
              外观
              <select
                value={snapshot.preferences.theme}
                onChange={(e) => void update({ theme: e.target.value })}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            <h3>本地存储</h3>
            <p className="muted">
              配置和快捷键保存在当前设备，不参与账号同步。
            </p>
            <code className="database-path">{snapshot.databasePath}</code>
            <p className="muted">
              协议版本 {snapshot.protocolVersion} · {snapshot.platform}
            </p>
          </>
        ) : tab === "plugins" ? (
          <>
            {snapshot.plugins.map((p) => (
              <section className="setting-plugin" key={p.manifest.id}>
                <label className="setting-row">
                  <span>
                    {p.manifest.name}
                    <small>{p.manifest.version} · 官方内置</small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={"启用" + p.manifest.name}
                    checked={p.enabled}
                    onChange={(e) =>
                      void run(() =>
                        host.setPluginEnabled(p.manifest.id, e.target.checked),
                      )
                    }
                  />
                </label>
                <p className="muted">
                  已声明能力：{p.manifest.capabilities.join("、")}
                </p>
                <small>
                  当前宿主仅开放授权工作区读取；写入与系统执行仍被拒绝。
                </small>
              </section>
            ))}
          </>
        ) : (
          <>
            <p className="muted">
              每条命令独立绑定，应用退出后失效。支持 F1
              等功能键，可能截获其他应用按键。输入组合，例如 Ctrl+Shift+F。
            </p>
            {snapshot.plugins.map((p) => (
              <section className="setting-plugin" key={p.manifest.id}>
                <h3>{p.manifest.name}</h3>
                {p.manifest.contributes.commands.map((cmd) => {
                  const key = p.manifest.id + "/" + cmd.id;
                  const binding = snapshot.shortcuts.find(
                    (b) =>
                      b.pluginId === p.manifest.id && b.commandId === cmd.id,
                  );
                  return (
                    <div className="shortcut-row" key={key}>
                      <label htmlFor={key}>
                        {cmd.title}
                        <small>
                          {binding
                            ? binding.status +
                              (binding.error ? ": " + binding.error : "")
                            : "未绑定"}
                        </small>
                      </label>
                      <input
                        id={key}
                        aria-label={cmd.title + "快捷键"}
                        value={keys[key] ?? ""}
                        onChange={(e) =>
                          setKeys({ ...keys, [key]: e.target.value })
                        }
                        placeholder="未绑定"
                      />
                      <button
                        onClick={() =>
                          void run(() =>
                            host.setShortcut(
                              p.manifest.id,
                              cmd.id,
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
                            host.setShortcut(p.manifest.id, cmd.id, null),
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
          </>
        )}
      </div>
    </>
  );
}
