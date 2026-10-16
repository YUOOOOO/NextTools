import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentSessionInfo,
  RemoteSnapshot,
  RemotePairing,
  Workspace,
} from "@nexttools/protocol";
import { nativeHostAvailable, remoteRequest } from "./host";
import {
  asRecord,
  stringField,
  createLiveSession,
  reduceAgentEvent,
  type LiveAgentSession,
} from "./agent-sessions";
import "./remote.css";

export function useRemote() {
  const [state, setState] = useState<RemoteSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!nativeHostAvailable) return;
    let active = true;
    let loading = false;
    async function update() {
      if (loading) return;
      loading = true;
      try {
        const next = await remoteRequest<RemoteSnapshot>("snapshot");
        if (active) setState(next);
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        loading = false;
      }
    }
    void update();
    const timer = setInterval(() => void update(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function act(action: string, input: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      setState(await remoteRequest<RemoteSnapshot>(action, input));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return { state, error, busy, act };
}
export function AccountPane({
  workspaces = [],
  section = "account",
}: {
  workspaces?: Workspace[];
  section?: "account" | "devices" | "sync";
}) {
  const { state, error, busy, act } = useRemote();
  const [server, setServer] = useState("");
  const [callback, setCallback] = useState("");
  const [code, setCode] = useState("");
  return (
    <section className="settings-section remote-pane">
      <header>
        <h2>
          {section === "devices"
            ? "设备与配对"
            : section === "sync"
              ? "加密数据同步"
              : "账号与连接"}
        </h2>
        <p>自托管账号服务 · 同账号不自动获得桌面控制权</p>
      </header>
      {!nativeHostAvailable ? (
        <p role="status">
          浏览器预览不提供原生账号、凭据或远控。请使用 NextTools 客户端。
        </p>
      ) : !state?.email ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act("login", { server });
          }}
        >
          <label>
            账号服务地址
            <input
              type="url"
              required
              placeholder="https://your-nexttools-server.example"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
          </label>
          <button disabled={busy}>在系统浏览器登录</button>
          <p>
            密码仅在账号服务的浏览器页面输入。设备私钥和 refresh token
            仅存系统凭据库。
          </p>
        </form>
      ) : (
        <>
          <div className="remote-status">
            <strong>{state.email}</strong>
            <span>{state.connected ? "实时通道已连接" : "实时通道未连接"}</span>
          </div>
          <p>{state.server}</p>
          <small>本机设备 {state.deviceId}</small>
          <div className="remote-actions">
            <button disabled={busy} onClick={() => void act("refresh")}>
              刷新连接状态
            </button>
            <button disabled={busy} onClick={() => void act("logout")}>
              退出登录并撤销本机
            </button>
          </div>
          {section !== "sync" && (
            <>
              {!!workspaces.length && (
                <>
                  <h3>邀请手机配对</h3>
                  <button disabled={busy} onClick={() => void act("offer")}>
                    生成五分钟一次性配对码
                  </button>
                  {state.pairingCode && (
                    <div className="remote-code">
                      <code>{state.pairingCode}</code>
                      <p>在手机输入；桌面确认前无控制权限。</p>
                    </div>
                  )}
                </>
              )}
              {!workspaces.length && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act("claim", { token: code });
                  }}
                >
                  <label>
                    桌面配对码
                    <input
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button disabled={busy}>请求配对</button>
                </form>
              )}
              <h3>设备公钥</h3>
              {state.devices.map((d) => (
                <article className="remote-device" key={d.id}>
                  <strong>
                    {d.name} · {d.platform}
                    {d.revoked ? " · 已撤销" : ""}
                  </strong>
                  <small>{d.id}</small>
                  <label>
                    签名公钥<code>{d.signingKey}</code>
                  </label>
                  <label>
                    加密公钥<code>{d.exchangeKey}</code>
                  </label>
                </article>
              ))}
              <h3>配对授权</h3>
              {!state.pairings.length && <p>尚无待确认或已授权配对。</p>}
              {state.pairings.map((p) => (
                <Pairing
                  key={p.id}
                  pairing={p}
                  state={state}
                  workspaces={workspaces}
                  busy={busy}
                  act={act}
                />
              ))}
            </>
          )}
          <h3>同步状态</h3>
          <p>
            已接收 {state.workspaces.length}{" "}
            个授权项目的会话索引。工作区路径、API
            Key、私钥和本机偏好不参与同步。离线控制请求不排队、不重放。
          </p>
        </>
      )}
      {state?.authorizationUrl && (
        <details open>
          <summary>浏览器未自动返回？</summary>
          <p>
            完成登录后，将浏览器跳转的应用回调 URL 粘贴到此处。不要分享回调
            URL。
          </p>
          <label>
            登录回调 URL
            <input
              value={callback}
              onChange={(e) => setCallback(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            disabled={busy}
            onClick={() => {
              void act("callback", { url: callback });
              setCallback("");
            }}
          >
            完成登录
          </button>
        </details>
      )}
      {(error || state?.error) && (
        <p role="alert" className="remote-error">
          {error || state?.error}
        </p>
      )}
    </section>
  );
}
function Pairing({
  pairing: p,
  state,
  workspaces,
  busy,
  act,
}: {
  pairing: RemotePairing;
  state: RemoteSnapshot;
  workspaces: Workspace[];
  busy: boolean;
  act: (a: string, v?: Record<string, unknown>) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [operations, setOperations] = useState(["session.view"]);
  const [confirmed, setConfirmed] = useState(false);
  const desktop = p.target === state.deviceId;
  const peer = state.devices.find(
    (d) => d.id === (desktop ? p.source : p.target),
  );
  const input = {
    id: p.id,
    workspaces: selected,
    operations,
    signingKey: peer?.signingKey,
    exchangeKey: peer?.exchangeKey,
  };
  return (
    <article className="remote-device">
      <strong>
        {peer?.name ?? "未知设备"} · {p.status}
      </strong>
      <small>{p.id}</small>
      {p.status === "pending" && desktop && (
        <>
          {workspaces.map((w) => (
            <label className="remote-check" key={w.id}>
              <input
                type="checkbox"
                checked={selected.includes(w.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, w.id]
                      : selected.filter((id) => id !== w.id),
                  )
                }
              />
              {w.name}
            </label>
          ))}
          {[
            ["session.view", "查看会话"],
            ["session.prompt", "发送消息"],
            ["session.stop", "停止任务"],
          ].map(([id, label]) => (
            <label className="remote-check" key={id}>
              <input
                type="checkbox"
                checked={operations.includes(id)}
                onChange={(e) =>
                  setOperations(
                    e.target.checked
                      ? [...operations, id]
                      : operations.filter((v) => v !== id),
                  )
                }
              />
              {label}
            </label>
          ))}
        </>
      )}
      <p>请与另一台设备显示的签名/加密公钥逐字核对后确认。</p>
      <code>{peer?.signingKey}</code>
      <code>{peer?.exchangeKey}</code>
      <label className="remote-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已通过另一台设备核对公钥
      </label>
      <div className="remote-actions">
        {p.status === "pending" && desktop ? (
          <>
            <button
              disabled={
                busy || !confirmed || !selected.length || !operations.length
              }
              onClick={() => void act("resolve", { ...input, approved: true })}
            >
              批准所选项目与范围
            </button>
            <button
              disabled={busy}
              onClick={() => void act("revoke", { id: p.id })}
            >
              拒绝并撤销
            </button>
          </>
        ) : (
          p.status === "approved" && (
            <>
              <button
                disabled={busy || !confirmed}
                onClick={() => void act("trust", input)}
              >
                确认对端公钥
              </button>
              <button
                disabled={busy}
                onClick={() => void act("revoke", { id: p.id })}
              >
                撤销配对
              </button>
            </>
          )
        )}
      </div>
    </article>
  );
}
async function control(
  target: string,
  workspace: string,
  operation: string,
  payload: Record<string, unknown>,
) {
  const { requestId } = await remoteRequest<{ requestId: string }>("control", {
    target,
    workspace,
    operation,
    payload,
  });
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await remoteRequest<{
      data?: unknown;
      error?: string;
    } | null>("result", { id: requestId });
    if (result) {
      if (result.error) throw new Error(result.error);
      return result.data;
    }
  }
}
export function RemoteAgentPane() {
  const { state, error } = useRemote();
  const [sessions, setSessions] = useState<Record<string, LiveAgentSession>>(
    {},
  );
  const [current, setCurrent] = useState("");
  const [target, setTarget] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [text, setText] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [approvals, setApprovals] = useState(
    () => new Map<string, Set<string>>(),
  );
  useEffect(() => {
    if (!nativeHostAvailable) return;
    const cleanup = listen<unknown>("remote:event", ({ payload }) => {
      const v = asRecord(payload);
      const id = stringField(v, "sessionId");
      if (!id) return;
      const event = asRecord(v?.event);
      const request = stringField(event, "requestId");
      if (
        event?.type === "remote_approval" ||
        event?.type === "remote_approval_resolved"
      ) {
        if (!request) return;
        setApprovals((all) => {
          const next = new Map(all);
          const pending = new Set(next.get(id));
          if (event.type === "remote_approval") pending.add(request);
          else pending.delete(request);
          if (pending.size) next.set(id, pending);
          else next.delete(id);
          return next;
        });
        return;
      }
      setSessions((all) => ({
        ...all,
        [id]: reduceAgentEvent(
          all[id] ??
            createLiveSession({ sessionId: id, workspaceId: "", model: null }),
          v?.event,
        ),
      }));
    });
    return () => {
      void cleanup.then((off) => off());
    };
  }, []);
  async function open(device: string, project: string, id: string) {
    setBusy(true);
    setFailure("");
    try {
      const info = (await control(device, project, "session.view", {
        sessionId: id,
      })) as AgentSessionInfo;
      setCurrent(info.sessionId);
      setWorkspace(project);
      setTarget(device);
      setSessions((all) => ({
        ...all,
        [info.sessionId]: {
          ...(all[info.sessionId] ?? createLiveSession(info)),
          info,
        },
      }));
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function send(stop: boolean) {
    setBusy(true);
    setFailure("");
    try {
      await control(
        target,
        workspace,
        stop ? "session.stop" : "session.prompt",
        { sessionId: current, text },
      );
      if (!stop) setText("");
    } catch (e) {
      setFailure(String(e));
    } finally {
      setBusy(false);
    }
  }
  const live = sessions[current];
  return (
    <section className="remote-pane">
      <h2>桌面 Agent</h2>
      <p>
        {state?.connected ? "实时通道已连接" : "实时通道未连接"} ·
        控制仅发往已授权的在线桌面
      </p>
      {!state?.workspaces.length && (
        <p>尚无同步的项目。请在“我的 → 桌面设备”登录、配对并核对公钥。</p>
      )}
      {state?.workspaces.map((w) => (
        <details key={w.deviceId + w.id} open>
          <summary>
            {w.name} · {w.sessions.length} 个会话
          </summary>
          {w.sessions.map((s) => (
            <button
              className="remote-session"
              key={s.sessionId}
              disabled={busy || !state.connected}
              onClick={() => void open(w.deviceId, w.id, s.sessionId)}
            >
              {s.title || "未命名会话"}
              <small>{s.updatedAt}</small>
            </button>
          ))}
        </details>
      ))}
      {live && (
        <>
          <h3>{live.title}</h3>
          <div className="remote-timeline">
            {live.messages.map((m) => (
              <article key={m.id}>
                <strong>{m.title}</strong>
                <pre>{m.text}</pre>
              </article>
            ))}
            {(!!live.approvals.length || !!approvals.get(current)?.size) && (
              <p role="status">
                有工具等待审批，请在目标桌面确认。手机不能批准高风险操作。
              </p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(false);
            }}
          >
            <label>
              继续会话
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className="remote-actions">
              <button disabled={busy || !state?.connected || !text.trim()}>
                发送到桌面
              </button>
              <button
                type="button"
                disabled={busy || !state?.connected}
                onClick={() => void send(true)}
              >
                停止任务
              </button>
            </div>
          </form>
        </>
      )}
      {(failure || error || state?.error) && (
        <p className="remote-error" role="alert">
          {failure || error || state?.error}
        </p>
      )}
    </section>
  );
}
