import { useEffect, useRef, useState } from "react";
import type { AgentProfile, AgentSettingsSnapshot } from "@nexttools/protocol";
import { host } from "./host";

export function AgentProfiles({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<AgentSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<AgentProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  async function refresh() {
    setSnapshot(await host.agentSettingsSnapshot());
  }
  useEffect(() => {
    dialog.current?.showModal();
    let valid = true;
    void host
      .agentSettingsSnapshot()
      .then((value) => {
        if (valid) setSnapshot(value);
      })
      .catch((cause) => {
        if (valid) setError(String(cause));
      });
    return () => {
      valid = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  function create() {
    setDraft({
      id: "",
      name: "",
      description: "",
      provider: snapshot?.provider ?? "",
      model: snapshot?.model ?? "",
      systemPrompt: "",
      skillIds:
        snapshot?.skills.filter((s) => s.enabled).map((s) => s.id) ?? [],
    });
  }
  return (
    <dialog
      ref={dialog}
      className="agent-profiles-dialog"
      aria-label="智能体管理"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>智能体</h2>
        <button disabled={busy} onClick={onClose}>
          关闭
        </button>
      </header>
      <p className="muted">
        本机智能体模板：模型、系统指令与
        Skills。选择后用于后续新建或恢复的会话，不改动运行中的会话。API Key
        仍由系统凭据管理。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!snapshot && !error && <p role="status">正在读取智能体配置…</p>}
      {snapshot && (
        <div className="agent-profile-layout">
          <div className="agent-profile-list">
            <button disabled={busy} onClick={create}>
              新建智能体
            </button>
            <button
              disabled={busy}
              aria-pressed={!snapshot.activeProfileId}
              onClick={() => void run(() => host.agentProfileSelect(null))}
            >
              默认 Agent · 全局模型 / Skills
            </button>
            {snapshot.profiles.map((profile) => (
              <article key={profile.id}>
                <strong>
                  {profile.name}
                  {snapshot.activeProfileId === profile.id ? " · 已选择" : ""}
                </strong>
                <p>{profile.description}</p>
                <small>
                  {profile.provider} / {profile.model}
                </small>
                <div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() => host.agentProfileSelect(profile.id))
                    }
                  >
                    选择
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      setDraft({ ...profile, skillIds: [...profile.skillIds] })
                    }
                  >
                    编辑
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        ...profile,
                        id: "",
                        name: `${profile.name} 副本`,
                        skillIds: [...profile.skillIds],
                      })
                    }
                  >
                    复制
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setDeleting(profile.id)}
                  >
                    删除
                  </button>
                </div>
                {deleting === profile.id && (
                  <div role="alert">
                    <p>删除此智能体？现有会话不会停止。</p>
                    <button disabled={busy} onClick={() => setDeleting(null)}>
                      取消
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await host.agentProfileRemove(profile.id);
                          setDeleting(null);
                          if (draft?.id === profile.id) setDraft(null);
                        })
                      }
                    >
                      确认删除
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          {draft ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await host.agentProfileSave(draft);
                  setDraft(null);
                });
              }}
            >
              <fieldset disabled={busy}>
                <label>
                  名称
                  <input
                    aria-label="智能体名称"
                    required
                    maxLength={120}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  描述
                  <textarea
                    aria-label="智能体描述"
                    maxLength={2000}
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </label>
                <label>
                  Provider
                  <select
                    aria-label="智能体 Provider"
                    value={draft.provider}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        provider: e.target.value,
                        model: "",
                      })
                    }
                  >
                    <option value="">请选择</option>
                    {snapshot.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                        {p.hasApiKey ? "" : "（未配置 Key）"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  模型
                  <select
                    aria-label="智能体模型"
                    required
                    value={draft.model}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value })
                    }
                  >
                    <option value="">请选择</option>
                    {snapshot.models
                      .filter((m) => m.provider === draft.provider)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  系统指令
                  <textarea
                    className="agent-prompt-editor"
                    aria-label="智能体系统指令"
                    maxLength={65536}
                    value={draft.systemPrompt}
                    onChange={(e) =>
                      setDraft({ ...draft, systemPrompt: e.target.value })
                    }
                  />
                </label>
                <h3>Skills</h3>
                <p className="muted">
                  仅启用已导入且全局启用的 Skills。MCP
                  仍遵循宿主连接与审批策略。
                </p>
                {snapshot.skills.map((skill) => (
                  <label className="skill-choice" key={skill.id}>
                    <input
                      type="checkbox"
                      disabled={!skill.enabled}
                      checked={draft.skillIds.includes(skill.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          skillIds: e.target.checked
                            ? [...draft.skillIds, skill.id]
                            : draft.skillIds.filter((id) => id !== skill.id),
                        })
                      }
                    />
                    {skill.name}
                    {!skill.enabled && "（全局已禁用）"}
                  </label>
                ))}
                <div>
                  <button type="submit">保存智能体</button>
                  <button type="button" onClick={() => setDraft(null)}>
                    取消编辑
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <p className="muted">
              选择一个智能体编辑，或新建模板。Skills、MCP
              和凭据使用宿主共用设置。
            </p>
          )}
        </div>
      )}
    </dialog>
  );
}
