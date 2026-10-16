import { useEffect, useRef, useState } from "react";
import type { HostSnapshot } from "@nexttools/protocol";
import {
  ArrowUpRight,
  Bot,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Grid2X2,
  Laptop,
  LockKeyhole,
  Monitor,
  Moon,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  UserRound,
} from "lucide-react";
import { host } from "../host";
import { AccountPane, RemoteAgentPane, useRemote } from "../remote";
import "./mobile.css";

type Tab = "workbench" | "agent" | "me";
type Detail = "account" | "devices" | "sync" | "privacy" | null;
const tabs = [
  { id: "workbench", label: "工作台", icon: Grid2X2 },
  { id: "agent", label: "Agent", icon: Bot },
  { id: "me", label: "我的", icon: UserRound },
] as const;

export function MobileApp({
  initialSnapshot,
}: {
  initialSnapshot: HostSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [tab, setTab] = useState<Tab>("workbench");
  const [detail, setDetail] = useState<Detail>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const remote = useRemote();
  const theme = snapshot?.preferences.theme ?? "system";

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [tab, detail]);

  async function changeTheme(value: string) {
    if (!snapshot || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const preferences = { ...snapshot.preferences, theme: value };
      await host.setPreferences(preferences);
      setSnapshot({ ...snapshot, preferences });
    } catch (cause) {
      setError(String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const titles = {
    account: "账号与登录",
    devices: "桌面设备",
    sync: "数据同步",
    privacy: "隐私与安全",
  };
  const plugins = snapshot?.plugins ?? [];
  const supported = plugins.filter(
    (item) => item.manifest.mobileMode === "native",
  );
  const filtered = supported.filter((item) =>
    item.manifest.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  return (
    <div className="mobile-app">
      {!snapshot && (
        <div className="mobile-preview" role="status">
          界面预览 · 未连接原生 Host · 无演示数据
        </div>
      )}
      <header className="mobile-header">
        <div className="mobile-brand">
          <span className="mobile-brand-mark">
            <Sparkles size={17} />
          </span>
          NextTools
        </div>
        <span className="mobile-local">
          <span />
          {snapshot ? "本机" : "预览"}
        </span>
      </header>
      <main className="mobile-main" id="mobile-page">
        {detail ? (
          <>
            <button className="mobile-back" onClick={() => setDetail(null)}>
              <ChevronLeft size={18} />
              返回我的
            </button>
            <h1 ref={heading} tabIndex={-1}>
              {titles[detail]}
            </h1>
            {(detail === "account" ||
              detail === "devices" ||
              detail === "sync") && <AccountPane section={detail} />}
            {detail === "privacy" && (
              <section className="mobile-card mobile-detail">
                <ShieldCheck size={32} />
                <h2>执行留在受信任的电脑</h2>
                <ul className="mobile-security-list">
                  <li>手机不运行本地 Node、Pi、Shell、Git 或 MCP server。</li>
                  <li>
                    文件修改和高风险操作须经过目标桌面的权限校验、审批与审计。
                  </li>
                  <li>API Key、SSH key 和设备私钥不参与同步。</li>
                  <li>
                    实时控制与数据同步分离；过期或重放的控制请求必须拒绝。
                  </li>
                </ul>
              </section>
            )}
          </>
        ) : tab === "workbench" ? (
          <>
            <div className="mobile-eyebrow">YOUR SPACE</div>
            <h1 ref={heading} tabIndex={-1}>
              工作台<span className="mobile-heading-dot">.</span>
            </h1>
            <p className="mobile-subtitle">随身携带的工作空间。</p>
            <section className="mobile-connect-card">
              <span className="mobile-feature-icon">
                <Laptop size={23} />
              </span>
              <h2>让工作，跨越设备</h2>
              <p>
                关联电脑，随时查看项目，
                <br />
                在手机上继续你的 Agent 任务。
              </p>
              <button
                onClick={() => {
                  setTab("me");
                  setDetail("account");
                }}
              >
                查看账号与连接
                <ArrowUpRight size={17} />
              </button>
              <div className="mobile-connect-art" aria-hidden="true">
                <Monitor size={94} strokeWidth={1} />
                <Smartphone size={53} strokeWidth={1.2} />
              </div>
            </section>
            <section aria-labelledby="mobile-plugins-title">
              <div className="mobile-section-heading">
                <h2 id="mobile-plugins-title">插件</h2>
                <span>{supported.length} 个支持移动端</span>
              </div>
              <label className="mobile-search">
                <Search size={18} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索移动端插件"
                  aria-label="搜索移动端插件"
                />
              </label>
              {!filtered.length && (
                <div className="mobile-card mobile-empty">
                  <Grid2X2 size={27} />
                  <h3>{query ? "没有匹配的插件" : "暂无可用的移动端插件"}</h3>
                  <p>
                    {query
                      ? "试试其他关键词。"
                      : "已安装的文件插件仅支持桌面；Pi Agent 在手机上仅可远程控制。"}
                  </p>
                </div>
              )}
              {filtered.map((plugin) => (
                <article
                  className="mobile-card mobile-plugin"
                  key={plugin.manifest.id}
                >
                  <Grid2X2 size={22} />
                  <div>
                    <h3>{plugin.manifest.name}</h3>
                    <p>
                      v{plugin.manifest.version} ·{" "}
                      {plugin.enabled ? "已启用" : "已停用"}
                    </p>
                  </div>
                </article>
              ))}
            </section>
            <p className="mobile-footnote">
              <LockKeyhole size={13} />
              本地优先。你的系统能力始终由 Host 授权。
            </p>
          </>
        ) : tab === "agent" ? (
          <>
            <div className="mobile-eyebrow">DESKTOP, WITH YOU</div>
            <h1 ref={heading} tabIndex={-1}>
              Agent<span className="mobile-heading-dot">.</span>
            </h1>
            <p className="mobile-subtitle">留在电脑执行，在手机掌握进展。</p>
            <RemoteAgentPane />
          </>
        ) : (
          <>
            <div className="mobile-eyebrow">MAKE IT YOURS</div>
            <h1 ref={heading} tabIndex={-1}>
              我的<span className="mobile-heading-dot">.</span>
            </h1>
            <p className="mobile-subtitle">账号、设备与偏好，一处管理。</p>
            <button
              className="mobile-card mobile-account"
              onClick={() => setDetail("account")}
            >
              <span className="mobile-avatar">
                <UserRound size={29} />
              </span>
              <span>
                <strong>{remote.state?.email ?? "尚未登录"}</strong>
                <small>
                  {remote.state?.connected
                    ? "实时通道已连接"
                    : "登录并配对桌面"}
                </small>
              </span>
              <ChevronRight size={18} />
            </button>
            <h2 className="mobile-group-title">连接与数据</h2>
            <div className="mobile-card mobile-rows">
              <button onClick={() => setDetail("devices")}>
                <Laptop size={20} />
                <span>桌面设备</span>
                <small>
                  {remote.state?.pairings.filter((p) => p.status === "approved")
                    .length ?? 0}{" "}
                  个配对
                </small>
                <ChevronRight size={16} />
              </button>
              <button onClick={() => setDetail("sync")}>
                <CloudOff size={20} />
                <span>数据同步</span>
                <small>{remote.state?.workspaces.length ?? 0} 个项目</small>
                <ChevronRight size={16} />
              </button>
              <button onClick={() => setDetail("privacy")}>
                <ShieldCheck size={20} />
                <span>隐私与安全</span>
                <ChevronRight size={16} />
              </button>
            </div>
            <h2 className="mobile-group-title">本机偏好</h2>
            <section className="mobile-card mobile-appearance">
              <div>
                <Settings2 size={20} />
                <h3>外观</h3>
                <small>仅当前设备</small>
              </div>
              <div
                className="mobile-theme-options"
                role="group"
                aria-label="外观"
              >
                {[
                  { value: "system", label: "跟随系统", icon: Smartphone },
                  { value: "light", label: "浅色", icon: Sun },
                  { value: "dark", label: "深色", icon: Moon },
                ].map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    aria-pressed={theme === value}
                    disabled={!snapshot || saving}
                    onClick={() => void changeTheme(value)}
                  >
                    <Icon size={18} />
                    {label}
                  </button>
                ))}
              </div>
              {!snapshot && (
                <p className="mobile-footnote">
                  预览不保存设置；请在原生客户端中使用。
                </p>
              )}
            </section>
            {error && (
              <p className="mobile-error" role="alert">
                设置未保存：{error}
              </p>
            )}
            <p className="mobile-about">
              NextTools <span>本地优先 · 安全连接</span>
            </p>
          </>
        )}
      </main>
      <nav className="mobile-tabbar" aria-label="主导航">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              setTab(id);
              setDetail(null);
            }}
          >
            <span>
              <Icon size={23} strokeWidth={tab === id ? 2 : 1.6} />
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
