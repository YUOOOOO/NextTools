import { useEffect, useState } from "react";
import type { HostClient } from "@nexttools/plugin-sdk";
import type { FileContent, FileEntry, Workspace } from "@nexttools/protocol";
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
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
    if (!workspace) {
      setLoading(false);
      return;
    }
    host
      .listFiles(workspace.id, path)
      .then(
        (v) => {
          if (active) setEntries(v);
        },
        (e) => {
          if (active) setError(String(e));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [host, workspace?.id, path, revision]);
  useEffect(() => {
    setFile(null);
  }, [workspace?.id]);
  async function open(entry: FileEntry) {
    if (entry.isDirectory) {
      setPath(entry.path);
      return;
    }
    if (!workspace) return;
    setError("");
    try {
      const result = await host.readFile(workspace.id, entry.path);
      setFile(result);
    } catch (e) {
      setError(String(e));
    }
  }
  if (!workspace)
    return (
      <div className="empty-state">
        <h2>选择一个工作区</h2>
        <p>切换到 Agent，通过“打开工作区”授权文件访问，再回到此页面。</p>
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
        <span className="muted">只读</span>
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
            <>
              <h3>{file.path}</h3>
              <pre>{file.content}</pre>
            </>
          ) : (
            <div className="empty-state">
              <p>选择文件以查看内容</p>
              <small>仅读取已授权目录内、1 MiB 以内的 UTF-8 文本。</small>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
