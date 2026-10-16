import { useEffect, useState } from "react";
import { CodeEditor } from "./code-editor";
import type { HostClient } from "@nexttools/plugin-sdk";
import type {
  FileChangeApproval,
  FileContent,
  FileEntry,
  Workspace,
} from "@nexttools/protocol";

export function FileEditor({
  host,
  workspaceId,
  file,
  newFile = false,
  onSaved,
}: {
  host: HostClient;
  workspaceId: string;
  file: FileContent;
  newFile?: boolean;
  onSaved?: (file: FileContent | null) => void;
}) {
  const [draft, setDraft] = useState(file.content);
  const [original, setOriginal] = useState(file.content);
  const [name, setName] = useState(file.path);
  const [created, setCreated] = useState(!newFile);
  const [deleted, setDeleted] = useState(false);
  const [approval, setApproval] = useState<FileChangeApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = !created || draft !== original;
  async function prepare(kind: "write" | "create" | "delete") {
    if (busy || approval || deleted) return;
    setBusy(true);
    setError("");
    try {
      setApproval(
        await host.prepareFileChange(workspaceId, {
          kind,
          path: name,
          content: kind === "delete" ? null : draft,
          expectedContent: kind === "create" ? null : original,
        }),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function resolve(approved: boolean) {
    if (!approval || busy) return;
    setBusy(true);
    setError("");
    try {
      await host.resolveFileChange(workspaceId, approval.requestId, approved);
      if (approved) {
        if (approval.change.kind === "delete") {
          setDeleted(true);
          onSaved?.(null);
        } else {
          const content = approval.change.content ?? "";
          setOriginal(content);
          setCreated(true);
          onSaved?.({ path: approval.change.path, content });
        }
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setApproval(null);
      setBusy(false);
    }
  }
  if (deleted) return <p role="status">文件已删除</p>;
  return (
    <section className="file-edit-pane" aria-label="文件编辑">
      <header className="file-preview-header">
        {created ? (
          <span>
            {name}
            {dirty ? " *" : ""}
          </span>
        ) : (
          <input
            aria-label="新文件路径"
            value={name}
            disabled={busy || !!approval}
            onChange={(event) => setName(event.target.value)}
            placeholder="相对文件路径"
          />
        )}
        <button
          className="text-button"
          disabled={busy || !!approval || !dirty || !name.trim()}
          onClick={() => void prepare(created ? "write" : "create")}
        >
          预览并保存
        </button>
        {created && (
          <button
            className="text-button danger"
            disabled={busy || !!approval}
            onClick={() => void prepare("delete")}
          >
            删除文件
          </button>
        )}
      </header>
      <CodeEditor
        value={draft}
        path={name}
        disabled={busy || !!approval}
        onChange={setDraft}
        onSave={() => {
          if (dirty) void prepare(created ? "write" : "create");
        }}
      />
      {approval && (
        <section className="file-change-review" aria-label="文件变更审批">
          <h3>
            {approval.change.kind === "delete" ? "确认删除" : "确认保存"}：
            {approval.change.path}
          </h3>
          <p>
            仅批准本次变更，{approval.expiresInSeconds}{" "}
            秒后失效。执行前会再次检查文件是否变化。
          </p>
          <pre aria-label="文件差异">
            {approval.diff || "空文件变更（无文本差异）"}
          </pre>
          <button disabled={busy} onClick={() => void resolve(false)}>
            拒绝
          </button>
          <button disabled={busy} onClick={() => void resolve(true)}>
            批准并执行
          </button>
        </section>
      )}
      {error && (
        <p className="file-editor-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function FilesView({
  host,
  workspace,
  revision,
}: {
  host: HostClient;
  workspace: Workspace | null;
  revision: number;
}) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [newFile, setNewFile] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setPath("");
    setFile(null);
  }, [workspace?.id]);
  useEffect(() => {
    let active = true;
    setError("");
    setLoading(true);
    setEntries([]);
    setFile(null);
    setNewFile(false);
    if (!workspace) {
      setLoading(false);
      return;
    }
    host
      .listFiles(workspace.id, path)
      .then(
        (value) => {
          if (active) setEntries(value);
        },
        (cause: unknown) => {
          if (active) setError(String(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [host, workspace?.id, path, revision, refresh]);
  async function open(entry: FileEntry) {
    if (entry.isDirectory) {
      setPath(entry.path);
      return;
    }
    if (!workspace) return;
    setError("");
    try {
      setFile(await host.readFile(workspace.id, entry.path));
      setNewFile(false);
    } catch (cause) {
      setError(String(cause));
    }
  }
  if (!workspace)
    return (
      <div className="empty-state">
        <h2>选择一个工作区</h2>
        <p>切换到 Agent，通过工作区标题右侧加号授权目录，再回到此页面。</p>
      </div>
    );
  return (
    <section className="files-view">
      <div className="file-path">
        <button
          disabled={!path}
          onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
        >
          上一级
        </button>
        <span>
          {workspace.name} / {path || "根目录"}
        </span>
        <button
          onClick={() => {
            setNewFile(true);
            setFile({ path: path ? `${path}/` : "", content: "" });
          }}
        >
          新建文件
        </button>
        <button onClick={() => setRefresh((value) => value + 1)}>刷新</button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="file-columns">
        <div className="file-list" aria-label="文件列表">
          {loading ? (
            <p>读取中…</p>
          ) : entries.length === 0 ? (
            <p className="muted">空目录</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => void open(entry)}
                className={file?.path === entry.path ? "selected" : ""}
              >
                <span aria-hidden="true">{entry.isDirectory ? "▸" : "·"}</span>
                {entry.name}
              </button>
            ))
          )}
        </div>
        <div className="file-preview">
          {file ? (
            <FileEditor
              key={`${workspace.id}:${file.path}:${newFile}`}
              host={host}
              workspaceId={workspace.id}
              file={file}
              newFile={newFile}
              onSaved={() => setRefresh((value) => value + 1)}
            />
          ) : (
            <div className="empty-state">
              <p>选择文件查看、编辑或删除，或新建文件</p>
              <small>
                仅支持授权目录内、1 MiB 以内的 UTF-8
                文本。所有变更均需审批并记录审计。
              </small>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
