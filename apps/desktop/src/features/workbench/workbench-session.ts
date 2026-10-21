import { useSyncExternalStore } from "react";

export type WorkbenchPageStatus = "ready" | "unavailable" | "disabled";

export type WorkbenchPageRecord = {
  id: string;
  titleKey: "workbench.title" | "workbench.exampleTitle";
  status: WorkbenchPageStatus;
};

export type WorkbenchSession = {
  pages: Record<string, WorkbenchPageRecord>;
  openIds: string[];
  activeId: string | null;
};

const OVERVIEW = "overview";
const EXAMPLE = "example";

export function createWorkbenchSession(): WorkbenchSession {
  return {
    pages: {
      [OVERVIEW]: { id: OVERVIEW, titleKey: "workbench.title", status: "ready" },
    },
    openIds: [OVERVIEW],
    activeId: OVERVIEW,
  };
}

export function openWorkbenchPage(session: WorkbenchSession, id: string): WorkbenchSession {
  if (session.openIds.includes(id)) {
    return { ...session, activeId: id };
  }
  const page = session.pages[id] ?? (
    id === EXAMPLE
      ? { id: EXAMPLE, titleKey: "workbench.exampleTitle" as const, status: "ready" as const }
      : null
  );
  if (!page) return session;
  return {
    pages: { ...session.pages, [id]: page },
    openIds: [...session.openIds, id],
    activeId: id,
  };
}

export function closeWorkbenchPage(session: WorkbenchSession, id: string): WorkbenchSession {
  const openIds = session.openIds.filter((openId) => openId !== id);
  const activeId = session.activeId === id ? openIds.at(-1) ?? null : session.activeId;
  return { ...session, openIds, activeId };
}

export function selectWorkbenchPage(session: WorkbenchSession, id: string): WorkbenchSession {
  if (!session.openIds.includes(id) || session.activeId === id) return session;
  return { ...session, activeId: id };
}

export function setWorkbenchPageStatus(
  session: WorkbenchSession,
  id: string,
  status: WorkbenchPageStatus,
): WorkbenchSession {
  const page = session.pages[id];
  if (!page || page.status === status) return session;
  return {
    ...session,
    pages: { ...session.pages, [id]: { ...page, status } },
  };
}

export type WorkbenchCommand =
  | { action: "open" | "close" | "select"; id: string }
  | { action: "setStatus"; id: string; status: WorkbenchPageStatus };

const KNOWN_PAGES = {
  overview: { id: OVERVIEW, titleKey: "workbench.title" },
  example: { id: EXAMPLE, titleKey: "workbench.exampleTitle" },
} as const;

export const WORKBENCH_SESSION_KEY = "pi.desktop.workbenchSession";

export function applyWorkbenchCommand(
  session: WorkbenchSession,
  command: WorkbenchCommand,
): WorkbenchSession {
  switch (command.action) {
    case "open":
      return openWorkbenchPage(session, command.id);
    case "close":
      return closeWorkbenchPage(session, command.id);
    case "select":
      return selectWorkbenchPage(session, command.id);
    case "setStatus":
      return setWorkbenchPageStatus(session, command.id, command.status);
  }
}

function isStatus(value: unknown): value is WorkbenchPageStatus {
  return value === "ready" || value === "unavailable" || value === "disabled";
}

export function restoreWorkbenchSession(value: unknown): WorkbenchSession {
  const base = createWorkbenchSession();
  if (!value || typeof value !== "object") return base;
  const raw = value as { pages?: unknown; openIds?: unknown; activeId?: unknown };
  const pages = { ...base.pages };
  if (raw.pages && typeof raw.pages === "object") {
    for (const [id, page] of Object.entries(raw.pages)) {
      const known = KNOWN_PAGES[id as keyof typeof KNOWN_PAGES];
      if (!known || !page || typeof page !== "object") continue;
      const status = (page as { status?: unknown }).status;
      pages[id] = { id, titleKey: known.titleKey, status: isStatus(status) ? status : "ready" };
    }
  }
  const openIds = Array.isArray(raw.openIds)
    ? [...new Set(raw.openIds.filter((id): id is string => typeof id === "string" && id in pages))]
    : base.openIds;
  const activeId = typeof raw.activeId === "string" && openIds.includes(raw.activeId)
    ? raw.activeId
    : openIds.at(-1) ?? null;
  return { pages, openIds, activeId };
}

function storage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function loadWorkbenchSession(): WorkbenchSession {
  const store = storage();
  if (!store) return createWorkbenchSession();
  try {
    const raw = store.getItem(WORKBENCH_SESSION_KEY);
    return restoreWorkbenchSession(raw ? JSON.parse(raw) : undefined);
  } catch {
    return createWorkbenchSession();
  }
}

export function saveWorkbenchSession(session: WorkbenchSession): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(WORKBENCH_SESSION_KEY, JSON.stringify(session));
  } catch {
    // A full or blocked store must not stop the page from changing.
  }
}

export type WorkbenchToolResult =
  | { ok: true; activeId: string | null; openIds: string[]; status: WorkbenchPageStatus | null }
  | { ok: false; error: string };

export function executeWorkbenchTool(input: unknown): WorkbenchToolResult {
  if (!input || typeof input !== "object") return { ok: false, error: "missing command" };
  const raw = input as { action?: unknown; id?: unknown; status?: unknown };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return { ok: false, error: "missing id" };
  let command: WorkbenchCommand | null = null;
  if (raw.action === "open" || raw.action === "close" || raw.action === "select") {
    command = { action: raw.action, id };
  } else if (raw.action === "setStatus" && (raw.status === "ready" || raw.status === "unavailable" || raw.status === "disabled")) {
    command = { action: "setStatus", id, status: raw.status };
  }
  if (!command) return { ok: false, error: "unsupported command" };
  const before = currentSession;
  dispatchWorkbenchCommand(command);
  if (currentSession === before && raw.action === "open") return { ok: false, error: "unknown page" };
  const active = currentSession.activeId ? currentSession.pages[currentSession.activeId] : undefined;
  return {
    ok: true,
    activeId: currentSession.activeId,
    openIds: currentSession.openIds,
    status: active?.status ?? null,
  };
}

let currentSession = loadWorkbenchSession();
const listeners = new Set<() => void>();

function publish(next: WorkbenchSession) {
  currentSession = next;
  saveWorkbenchSession(next);
  for (const listener of listeners) listener();
}

export function dispatchWorkbenchCommand(command: WorkbenchCommand) {
  publish(applyWorkbenchCommand(currentSession, command));
}

export function useWorkbenchSession(): WorkbenchSession {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentSession,
    () => currentSession,
  );
}
