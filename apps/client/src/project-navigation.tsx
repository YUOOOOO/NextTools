import { useEffect, useState } from "react";
import { Bot, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { IconButton } from "@nexttools/ui";
import type { AgentSessionSummary, Workspace } from "@nexttools/protocol";
import type { LiveAgentSession } from "./agent-sessions";
import { host } from "./host";

export function ProjectNavigation({
  projects,
  activeId,
  history,
  loading,
  sessions,
  activeSessions,
  creating,
  onChoose,
  onSelect,
  onNew,
  onResume,
  onLive,
}: {
  projects: Workspace[];
  activeId: string;
  history: AgentSessionSummary[];
  loading: boolean;
  sessions: LiveAgentSession[];
  activeSessions: Record<string, string>;
  creating: Set<string>;
  onChoose: () => void;
  onSelect: (id: string) => void;
  onNew: (id: string) => void;
  onResume: (id: string, persistedId: string) => void;
  onLive: (session: LiveAgentSession) => void;
}) {
  return (
    <>
      <div className="sidebar-section-row">
        <div className="sidebar-section">项目</div>
        <IconButton label="打开项目" onClick={onChoose}>
          <Plus size={15} />
        </IconButton>
      </div>
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          active={project.id === activeId}
          history={project.id === activeId ? history : null}
          loading={project.id === activeId && loading}
          live={sessions.filter((s) => s.info.workspaceId === project.id)}
          selected={activeSessions[project.id]}
          creating={creating.has(project.id)}
          onSelect={() => onSelect(project.id)}
          onNew={() => onNew(project.id)}
          onResume={(id) => onResume(project.id, id)}
          onLive={onLive}
        />
      ))}
      {!projects.length && <p className="sidebar-empty">点击 + 打开项目目录</p>}
    </>
  );
}
function ProjectRow({
  project,
  active,
  history,
  loading,
  live,
  selected,
  creating,
  onSelect,
  onNew,
  onResume,
  onLive,
}: {
  project: Workspace;
  active: boolean;
  history: AgentSessionSummary[] | null;
  loading: boolean;
  live: LiveAgentSession[];
  selected?: string;
  creating: boolean;
  onSelect: () => void;
  onNew: () => void;
  onResume: (id: string) => void;
  onLive: (session: LiveAgentSession) => void;
}) {
  const [expanded, setExpanded] = useState(active);
  const [saved, setSaved] = useState<AgentSessionSummary[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!expanded || history !== null) return;
    let valid = true;
    setPending(true);
    setError("");
    void host
      .listAgentSessions(project.id)
      .then((items) => {
        if (valid) setSaved(items);
      })
      .catch((cause) => {
        if (valid) setError(String(cause));
      })
      .finally(() => {
        if (valid) setPending(false);
      });
    return () => {
      valid = false;
    };
  }, [expanded, project.id, history, revision]);
  const items = history ?? saved;
  const persisted = new Set(
    live.map((s) => s.info.persistedSessionId).filter(Boolean),
  );
  return (
    <section className="project-row">
      <div className="project-heading">
        <button
          className={"sidebar-button " + (active ? "selected" : "")}
          aria-expanded={expanded}
          title={project.root}
          onClick={() => {
            setExpanded(!expanded);
            onSelect();
          }}
        >
          <ChevronRight size={14} className={expanded ? "expanded" : ""} />
          <span>{project.name}</span>
        </button>
        <IconButton
          label={`在 ${project.name} 新建会话`}
          disabled={creating}
          onClick={() => {
            setExpanded(true);
            onSelect();
            onNew();
          }}
        >
          <Plus size={14} />
        </IconButton>
      </div>
      {expanded && (
        <div className="project-sessions">
          {live.map((session) => (
            <button
              key={session.info.sessionId}
              className={
                "sidebar-button session-button " +
                (active && selected === session.info.sessionId
                  ? "selected"
                  : "")
              }
              disabled={session.closing}
              onClick={() => {
                onSelect();
                onLive(session);
              }}
            >
              <Bot size={14} />
              <span>{session.title || "新会话"}</span>
              {session.running && <small>运行中</small>}
            </button>
          ))}
          {items
            .filter((item) => !persisted.has(item.sessionId))
            .map((item) => (
              <button
                key={item.sessionId}
                className="sidebar-button session-button"
                disabled={creating}
                onClick={() => {
                  onSelect();
                  onResume(item.sessionId);
                }}
              >
                <Bot size={14} />
                <span>{item.title || "未命名会话"}</span>
              </button>
            ))}
          {(pending || loading) && (
            <p className="sidebar-empty">正在读取会话…</p>
          )}
          {!pending && !loading && !items.length && !live.length && (
            <p className="sidebar-empty">暂无会话</p>
          )}
          {error && (
            <p role="alert" className="sidebar-empty">
              {error}
            </p>
          )}
          {history === null && (
            <IconButton
              label={`刷新 ${project.name} 会话`}
              disabled={pending}
              onClick={() => setRevision((n) => n + 1)}
            >
              <RefreshCw size={13} />
            </IconButton>
          )}
        </div>
      )}
    </section>
  );
}
