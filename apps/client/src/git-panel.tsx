import { useState } from "react";
import type {
  GitAction,
  GitApproval,
  GitChange,
  GitQuery,
  GitStatus,
} from "@nexttools/protocol";
import { host } from "./host";

export function GitPanel({
  workspaceId,
  status,
  loading,
  error: statusError,
  onRefresh,
  onClose,
  onOpen,
}: {
  workspaceId: string;
  status: GitStatus | null;
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const [output, setOutput] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<GitApproval | null>(null);
  const [message, setMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [remote, setRemote] = useState("origin");
  const [stash, setStash] = useState("stash@{0}");
  const [left, setLeft] = useState("HEAD");
  const [right, setRight] = useState("");
  const [commit, setCommit] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  function query(query: GitQuery, label: string) {
    void run(async () => {
      setTitle(label);
      setOutput(await host.gitQuery(workspaceId, query));
    });
  }
  function prepare(action: GitAction) {
    void run(async () => {
      setApproval(await host.prepareGitAction(workspaceId, action));
    });
  }
  function paths(file: GitChange) {
    return file.originalPath ? [file.path, file.originalPath] : [file.path];
  }
  const locked = busy || loading || !!approval;
  return (
    <section className="git-panel" aria-label="Git 管理">
      <header>
        <strong>{status?.branch || "Git 管理"}</strong>
        <div className="git-actions">
          <button disabled={locked} onClick={() => void run(onRefresh)}>
            刷新
          </button>
          <button
            aria-label="关闭 Git 管理"
            disabled={busy || !!approval}
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </header>
      {(error || statusError) && <p role="alert">{error || statusError}</p>}
      {approval ? (
        <div className="git-approval">
          <strong>确认 Git 操作 · 5 分钟有效</strong>
          <pre>{JSON.stringify(approval.action, null, 2)}</pre>
          {(approval.action.kind === "discard" ||
            approval.action.kind === "stashDrop" ||
            (approval.action.kind === "reset" && approval.action.hard)) && (
            <p role="alert">
              此操作会丢弃本地数据，确认前请检查目标并自行备份。
            </p>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const pending = approval;
                setApproval(null);
                try {
                  setTitle("执行结果");
                  setOutput(
                    await host.resolveGitAction(
                      workspaceId,
                      pending.requestId,
                      true,
                    ),
                  );
                } finally {
                  await onRefresh();
                }
              })
            }
          >
            批准并执行
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const pending = approval;
                setApproval(null);
                setTitle("执行结果");
                setOutput(
                  await host.resolveGitAction(
                    workspaceId,
                    pending.requestId,
                    false,
                  ),
                );
              })
            }
          >
            拒绝
          </button>
        </div>
      ) : (
        <>
          <div className="git-actions">
            <button
              disabled={locked}
              onClick={() => query({ kind: "log" }, "提交历史（完整哈希）")}
            >
              历史
            </button>
            <button
              disabled={locked}
              onClick={() => query({ kind: "branches" }, "本地 / 远程分支")}
            >
              分支
            </button>
            <button
              disabled={locked}
              onClick={() => query({ kind: "stashes" }, "Stash 列表")}
            >
              Stash 列表
            </button>
            <button
              disabled={locked}
              onClick={() => query({ kind: "outgoing" }, "待推送提交")}
            >
              待推送
            </button>
          </div>
          {status?.state && (
            <div className="git-operation-state">
              <strong>进行中：{status.state}</strong>
              <p>冲突文件可打开编辑后暂存，或选择保留一方。</p>
              <div className="git-actions">
                {status.state === "merge" && (
                  <button
                    disabled={locked}
                    onClick={() => prepare({ kind: "mergeContinue" })}
                  >
                    完成合并
                  </button>
                )}
                <button
                  disabled={locked}
                  onClick={() => prepare({ kind: "abort" })}
                >
                  中止操作
                </button>
              </div>
            </div>
          )}
          <div className="git-changes">
            {!status?.changes.length && (
              <p className="muted">{status ? "工作区干净" : "正在加载状态…"}</p>
            )}
            {!!status?.changes.length && (
              <div className="git-actions">
                <button
                  disabled={locked}
                  onClick={() =>
                    prepare({
                      kind: "stage",
                      paths: [...new Set(status.changes.flatMap(paths))],
                    })
                  }
                >
                  全部暂存
                </button>
                <button
                  disabled={locked}
                  onClick={() =>
                    prepare({
                      kind: "unstage",
                      paths: [
                        ...new Set(
                          status.changes
                            .filter(
                              (f) =>
                                f.indexStatus !== " " && f.indexStatus !== "?",
                            )
                            .flatMap(paths),
                        ),
                      ],
                    })
                  }
                >
                  全部取消暂存
                </button>
              </div>
            )}
            {status?.changes.map((file) => {
              const conflict = [
                "DD",
                "AU",
                "UD",
                "UA",
                "DU",
                "AA",
                "UU",
              ].includes(file.indexStatus + file.worktreeStatus);
              return (
                <article
                  className={conflict ? "git-conflict" : ""}
                  key={file.path}
                >
                  <button
                    className="git-file-name"
                    title={file.path}
                    onClick={() => onOpen(file.path)}
                  >
                    <code>
                      {file.indexStatus}
                      {file.worktreeStatus}
                    </code>{" "}
                    {file.originalPath ? `${file.originalPath} → ` : ""}
                    {file.path}
                  </button>
                  <div className="git-file-actions">
                    <button
                      disabled={locked}
                      onClick={() =>
                        void run(async () => {
                          setTitle(file.path);
                          setOutput(
                            file.indexStatus === "?"
                              ? (await host.readFile(workspaceId, file.path))
                                  .content
                              : await host.gitQuery(workspaceId, {
                                  kind: "diff",
                                  path: file.path,
                                  staged: false,
                                }),
                          );
                        })
                      }
                    >
                      改动
                    </button>
                    {file.indexStatus !== " " && file.indexStatus !== "?" && (
                      <button
                        disabled={locked}
                        onClick={() =>
                          query(
                            { kind: "diff", path: file.path, staged: true },
                            `暂存 · ${file.path}`,
                          )
                        }
                      >
                        暂存 diff
                      </button>
                    )}
                    <button
                      disabled={locked}
                      onClick={() =>
                        prepare({ kind: "stage", paths: paths(file) })
                      }
                    >
                      {conflict ? "标记已解决" : "暂存"}
                    </button>
                    {file.indexStatus !== " " && file.indexStatus !== "?" && (
                      <button
                        disabled={locked}
                        onClick={() =>
                          prepare({ kind: "unstage", paths: paths(file) })
                        }
                      >
                        取消暂存
                      </button>
                    )}
                    {file.worktreeStatus !== " " &&
                      file.worktreeStatus !== "?" &&
                      !conflict && (
                        <button
                          disabled={locked}
                          onClick={() =>
                            prepare({ kind: "discard", paths: [file.path] })
                          }
                        >
                          丢弃工作区改动
                        </button>
                      )}
                    {conflict && (
                      <>
                        <button
                          disabled={locked}
                          onClick={() =>
                            prepare({
                              kind: "resolveConflict",
                              path: file.path,
                              theirs: false,
                            })
                          }
                        >
                          保留当前并暂存
                        </button>
                        <button
                          disabled={locked}
                          onClick={() =>
                            prepare({
                              kind: "resolveConflict",
                              path: file.path,
                              theirs: true,
                            })
                          }
                        >
                          保留传入并暂存
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <fieldset disabled={locked}>
            <label>
              提交信息
              <textarea
                aria-label="Git 提交信息"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
            <button
              disabled={!message.trim()}
              onClick={() => prepare({ kind: "commit", message })}
            >
              提交暂存文件
            </button>
            <label>
              远端名称
              <input
                aria-label="Git 远端名称"
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
              />
            </label>
            <div className="git-actions">
              <button onClick={() => prepare({ kind: "fetch" })}>Fetch</button>
              <button onClick={() => prepare({ kind: "pull" })}>Pull</button>
              <button
                onClick={() =>
                  prepare({ kind: "push", remote: remote.trim() || null })
                }
              >
                Push / 发布分支
              </button>
            </div>
            <label>
              分支名称
              <input
                aria-label="Git 分支名称"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="feature/name 或 origin/name"
              />
            </label>
            <div className="git-actions">
              <button
                disabled={!branch.trim()}
                onClick={() => prepare({ kind: "switch", branch })}
              >
                切换本地分支
              </button>
              <button
                disabled={!branch.trim()}
                onClick={() => prepare({ kind: "switchRemote", branch })}
              >
                检出远程分支
              </button>
              <button
                disabled={!branch.trim()}
                onClick={() => prepare({ kind: "createBranch", branch })}
              >
                新建分支
              </button>
              <button
                disabled={!branch.trim()}
                onClick={() => prepare({ kind: "merge", branch })}
              >
                合并分支
              </button>
            </div>
            <label>
              比较起点
              <input
                aria-label="Git 比较起点"
                value={left}
                onChange={(event) => setLeft(event.target.value)}
              />
            </label>
            <label>
              比较终点
              <input
                aria-label="Git 比较终点"
                value={right}
                onChange={(event) => setRight(event.target.value)}
              />
            </label>
            <button
              disabled={!left.trim() || !right.trim()}
              onClick={() =>
                query({ kind: "compare", left, right }, `${left} → ${right}`)
              }
            >
              比较分支 / 提交
            </button>
            <label>
              提交哈希
              <input
                aria-label="Git 提交哈希"
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
                placeholder="从历史复制完整哈希"
              />
            </label>
            <div className="git-actions">
              <button
                disabled={!commit.trim()}
                onClick={() =>
                  query({ kind: "show", commit }, `提交 · ${commit}`)
                }
              >
                查看提交 diff
              </button>
              <button
                disabled={!commit.trim()}
                onClick={() => prepare({ kind: "reset", commit, hard: false })}
              >
                回退（保留改动）
              </button>
              <button
                disabled={!commit.trim()}
                onClick={() => prepare({ kind: "reset", commit, hard: true })}
              >
                回退（丢弃改动）
              </button>
            </div>
            <label>
              Stash 说明
              <input
                aria-label="Stash 说明"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>
            <button
              onClick={() =>
                prepare({
                  kind: "stashSave",
                  message: message || "NextTools stash",
                })
              }
            >
              搁置全部改动（含未跟踪）
            </button>
            <label>
              Stash 引用
              <input
                aria-label="Stash 引用"
                value={stash}
                onChange={(event) => setStash(event.target.value)}
              />
            </label>
            <div className="git-actions">
              <button
                onClick={() =>
                  prepare({ kind: "stashApply", reference: stash })
                }
              >
                恢复（保留 Stash）
              </button>
              <button
                onClick={() => prepare({ kind: "stashDrop", reference: stash })}
              >
                删除 Stash
              </button>
            </div>
          </fieldset>
        </>
      )}
      {title && (
        <section className="git-output">
          <strong>{title}</strong>
          <pre>{output || "操作完成，无输出"}</pre>
        </section>
      )}
    </section>
  );
}
