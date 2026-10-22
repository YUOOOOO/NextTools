import { useSyncExternalStore } from "react";

export type WorkbenchPageStatus = "ready" | "unavailable" | "disabled";

export type WorkbenchPageRecord = {
  id: string;
  titleKey?: "workbench.title" | "workbench.exampleTitle";
  title?: string;
  status: WorkbenchPageStatus;
  pluginId?: string;
  viewId?: string;
  available?: boolean;
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
      if (!page || typeof page !== "object") continue;
      const status = (page as { status?: unknown }).status;
      const nextStatus = isStatus(status) ? status : "ready";
      const known = KNOWN_PAGES[id as keyof typeof KNOWN_PAGES];
      if (known) {
        pages[id] = { id, titleKey: known.titleKey, status: nextStatus };
        continue;
      }
      const rawPage = page as { title?: unknown; pluginId?: unknown; viewId?: unknown; available?: unknown };
      if (typeof rawPage.pluginId !== "string" || typeof rawPage.viewId !== "string") continue;
      pages[id] = {
        id,
        title: typeof rawPage.title === "string" ? rawPage.title : id,
        status: nextStatus,
        pluginId: rawPage.pluginId,
        viewId: rawPage.viewId,
        available: rawPage.available !== false,
      };
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

export type WorkbenchHostClient = {
  get: (migrate?: unknown) => Promise<{ session: unknown }>;
  apply: (command: WorkbenchCommand) => Promise<{
    ok: boolean;
    error?: string;
    session?: unknown;
    activeId?: string | null;
    openIds?: string[];
    status?: WorkbenchPageStatus | null;
  }>;
};

let hostClient: WorkbenchHostClient | null = null;
let hostActive = false;
let hydration: Promise<void> | null = null;

function readLocalRaw(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(WORKBENCH_SESSION_KEY);
  } catch {
    return null;
  }
}

function commandResult(session: WorkbenchSession): WorkbenchToolResult {
  const active = session.activeId ? session.pages[session.activeId] : undefined;
  return {
    ok: true,
    activeId: session.activeId,
    openIds: session.openIds,
    status: active?.status ?? null,
  };
}

function parseWorkbenchCommand(input: unknown): WorkbenchCommand | { error: string } {
  if (!input || typeof input !== "object") return { error: "missing command" };
  const raw = input as { action?: unknown; id?: unknown; status?: unknown };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return { error: "missing id" };
  if (raw.action === "open" || raw.action === "close" || raw.action === "select") {
    return { action: raw.action, id };
  }
  if (
    raw.action === "setStatus" &&
    (raw.status === "ready" || raw.status === "unavailable" || raw.status === "disabled")
  ) {
    return { action: "setStatus", id, status: raw.status };
  }
  return { error: "unsupported command" };
}

export function parseWorkbenchSlash(body: string):
  | { kind: "show" }
  | { kind: "command"; command: WorkbenchCommand }
  | { kind: "error"; error: string } {
  const text = body.trim();
  if (!text) return { kind: "show" };
  const [action, id, extra] = text.split(/\s+/);
  if (extra) return { kind: "error", error: "unsupported command" };
  if (!id) return { kind: "error", error: "missing id" };
  if (action === "open" || action === "close" || action === "select") {
    return { kind: "command", command: { action, id } };
  }
  if (action === "disable") return { kind: "command", command: { action: "setStatus", id, status: "disabled" } };
  if (action === "ready" || action === "restore") {
    return { kind: "command", command: { action: "setStatus", id, status: "ready" } };
  }
  if (action === "unavailable") {
    return { kind: "command", command: { action: "setStatus", id, status: "unavailable" } };
  }
  return { kind: "error", error: "unsupported command" };
}


const pageReleases = new Map<string, Set<() => void>>();

export function retainWorkbenchPage(id: string, release: () => void): () => void {
  const releases = pageReleases.get(id) ?? new Set<() => void>();
  releases.add(release);
  pageReleases.set(id, releases);
  return () => releases.delete(release);
}

function releaseDisabledPages(before: WorkbenchSession, next: WorkbenchSession) {
  for (const [id, page] of Object.entries(next.pages)) {
    if (page.status !== "disabled" || before.pages[id]?.status === "disabled") continue;
    const releases = pageReleases.get(id);
    pageReleases.delete(id);
    if (!releases) continue;
    for (const release of releases) release();
  }
}

export function replaceWorkbenchSession(value: unknown) {
  const before = currentSession;
  const next = restoreWorkbenchSession(value);
  releaseDisabledPages(before, next);
  publish(next, false);
}


function publish(next: WorkbenchSession, persistLocal: boolean) {
  currentSession = next;
  if (persistLocal && !hostActive) saveWorkbenchSession(next);
  for (const listener of listeners) listener();
}

function applyLocal(command: WorkbenchCommand): WorkbenchToolResult {
  const before = currentSession;
  const next = applyWorkbenchCommand(before, command);
  if (next === before && command.action === "open") return { ok: false, error: "unknown page" };
  releaseDisabledPages(before, next);
  publish(next, true);
  return commandResult(next);
}

export async function hydrateWorkbenchFromHost(client: WorkbenchHostClient): Promise<"host" | "local"> {
  const run = (async () => {
    const raw = readLocalRaw();
    let migrate: unknown;
    if (raw) {
      try {
        migrate = JSON.parse(raw);
      } catch {
        migrate = undefined;
      }
    }
    try {
      const result = await client.get(migrate);
      hostClient = client;
      hostActive = true;
      if (raw) storage()?.removeItem(WORKBENCH_SESSION_KEY);
      publish(restoreWorkbenchSession(result.session), false);
      return "host" as const;
    } catch {
      hostClient = null;
      hostActive = false;
      return "local" as const;
    }
  })();
  hydration = run.then(() => undefined, () => undefined);
  return run;
}

export function disconnectWorkbenchHost() {
  hostClient = null;
  hostActive = false;
  hydration = null;
}

export function executeWorkbenchTool(input: unknown): WorkbenchToolResult {
  const command = parseWorkbenchCommand(input);
  if ("error" in command) return { ok: false, error: command.error };
  return applyLocal(command);
}

export function dispatchWorkbenchCommand(command: WorkbenchCommand): Promise<WorkbenchToolResult> {
  return runWorkbenchCommand(command);
}

export async function runWorkbenchCommand(input: unknown): Promise<WorkbenchToolResult> {
  const command = parseWorkbenchCommand(input);
  if ("error" in command) return { ok: false, error: command.error };
  if (hydration) await hydration;
  if (hostActive && hostClient) {
    try {
      const result = await hostClient.apply(command);
      if (!result.ok) return { ok: false, error: result.error ?? "unknown page" };
      if (result.session) {
        const next = restoreWorkbenchSession(result.session);
        releaseDisabledPages(currentSession, next);
        publish(next, false);
      }
      return {
        ok: true,
        activeId: result.activeId ?? null,
        openIds: result.openIds ?? [],
        status: result.status ?? null,
      };
    } catch {
      hostActive = false;
      hostClient = null;
    }
  }
  return applyLocal(command);
}

export type WorkbenchToolResult =
  | { ok: true; activeId: string | null; openIds: string[]; status: WorkbenchPageStatus | null }
  | { ok: false; error: string };


let currentSession = loadWorkbenchSession();
const listeners = new Set<() => void>();

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
