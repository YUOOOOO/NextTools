import { useEffect, useState } from "react";
import { ChevronRight, File, Folder, RefreshCw, Save } from "lucide-react";
import { IconButton } from "@nexttools/ui";
import type { FileContent, FileEntry, Workspace } from "@nexttools/protocol";
import { host } from "./host";

function Directory({ workspaceId, path, selected, onSelect, revision }: {
  workspaceId: string;
  path: string;
  selected: string | null;
  onSelect: (path: string) => void;
  revision: number;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    host.listFiles(workspaceId, path).then(
      (result) => { if (active) setEntries(result); },
      (cause: unknown) => { if (active) setError(String(cause)); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, path, revision, retry]);
  if (loading) return <p className="sidebar-empty" role="status">正在读取目录…</p>;
  if (error) return <div className="sidebar-empty"><p role="alert">{error}</p><button onClick={() => setRetry((value) => value + 1)}>重试</button></div>;
  return <ul className="explorer-tree" role="group">
    {entries.map((entry) => <li key={entry.path}>
      <button
        className={"explorer-entry " + (selected === entry.path ? "selected" : "")}
        aria-expanded={entry.isDirectory ? expanded.has(entry.path) : undefined}
        aria-current={!entry.isDirectory && selected === entry.path ? "true" : undefined}
        title={entry.path}
        onClick={() => {
          if (!entry.isDirectory) { onSelect(entry.path); return; }
          setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
            return next;
          });
        }}
      >
        {entry.isDirectory ? <><ChevronRight size={12} className={expanded.has(entry.path) ? "is-expanded" : ""} /><Folder size={15} /></> : <File size={15} />}
        <span>{entry.name}</span>
      </button>
      {entry.isDirectory && expanded.has(entry.path) && <Directory workspaceId={workspaceId} path={entry.path} selected={selected} onSelect={onSelect} revision={revision} />}
    </li>)}
    {!entries.length && <li className="sidebar-empty">空目录</li>}
  </ul>;
}

export function AgentExplorer({ workspace, selected, onSelect }: {
  workspace: Workspace | null;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  return <section className="agent-explorer" aria-label="资源管理器">
    <header className="sidebar-section-row"><strong>资源管理器</strong><IconButton label="刷新资源管理器" disabled={!workspace} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} /></IconButton></header>
    <div className="sidebar-scroll">
      {workspace ? <><div className="sidebar-section">{workspace.name}</div><Directory key={workspace.id} workspaceId={workspace.id} path="" selected={selected} onSelect={onSelect} revision={revision} /></> : <p className="sidebar-empty">请在 Chat 中打开工作区以授权文件访问。</p>}
    </div>
  </section>;
}

export function AgentFilePreview({ workspaceId, path }: { workspaceId: string | null; path: string | null }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [original, setOriginal] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = file !== null && draft !== original;

  useEffect(() => {
    let active = true;
    setFile(null);
    setDraft("");
    setOriginal("");
    setError("");
    setLoading(Boolean(workspaceId && path));
    if (workspaceId && path) {
      host.readFile(workspaceId, path).then(
        (result) => {
          if (!active) return;
          setFile(result);
          setDraft(result.content);
          setOriginal(result.content);
        },
        (cause: unknown) => { if (active) setError(String(cause)); },
      ).finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [workspaceId, path]);

  const save = async () => {
    if (!workspaceId || !path || !file || !dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      await host.writeFile(workspaceId, path, draft, original);
      setFile({ ...file, content: draft });
      setOriginal(draft);
    } catch (cause: unknown) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <section className="agent-file-preview" aria-label="文件内容">
    <header className="file-preview-header">
      <span>{path ?? "文件预览"}{dirty ? " *" : ""}</span>
      <button className="text-button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : <><Save size={14} /> 保存</>}</button>
    </header>
    <div className="file-preview">
      {loading ? <p role="status">正在读取文件…</p> : error && !file ? <p role="alert">{error}</p> : file ? <textarea
        className="file-editor"
        value={draft}
        spellCheck={false}
        aria-label={path ?? "文件编辑器"}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void save();
          }
        }}
      /> : <p className="muted">选择文件查看内容。仅支持授权目录内、1 MiB 以内的 UTF-8 文本。</p>}
    </div>
    {error && file && <p className="file-editor-error" role="alert">{error}</p>}
  </section>;
}
