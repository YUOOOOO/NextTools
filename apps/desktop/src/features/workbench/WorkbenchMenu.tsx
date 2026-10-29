import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import {
  dispatchWorkbenchCommand,
  runWorkbenchCommand,
  useWorkbenchSession,
} from "./workbench-session";

export function WorkbenchToolBridge() {
  const setPage = useAppStore((state) => state.setPage);
  useEffect(() => {
    const onTool = async (event: Event) => {
      const result = await runWorkbenchCommand((event as CustomEvent<unknown>).detail);
      if (result.ok) setPage("workbench");
    };
    window.addEventListener("pi-workbench-tool", onTool);
    return () => window.removeEventListener("pi-workbench-tool", onTool);
  }, [setPage]);
  return null;
}


export function WorkbenchMenu() {
  const { t } = useTranslation();
  const session = useWorkbenchSession();
  const closedPages = Object.values(session.pages).filter(
    (page) => page.id !== "overview" && !session.openIds.includes(page.id),
  );
  return (
    <aside className="sidebar sidebar-surface workbench-menu" aria-label={t("workbench.menu")}>
      <nav className="sidebar-body workbench-menu-body">
        {session.openIds.map((id) => {
          const page = session.pages[id];
          if (!page) return null;
          return (
            <button
              key={id}
              type="button"
              className="workbench-menu-item"
              aria-current={session.activeId === id ? "page" : undefined}
              onClick={() => dispatchWorkbenchCommand({ action: "select", id })}
            >
              {page.title ?? (page.titleKey ? t(page.titleKey) : page.id)}
            </button>
          );
        })}
        {closedPages.map((page) => (
          <button
            key={page.id}
            type="button"
            className="workbench-menu-item"
            disabled={page.available === false}
            onClick={() => dispatchWorkbenchCommand({ action: "open", id: page.id })}
          >
            {page.title ?? (page.titleKey ? t(page.titleKey) : page.id)}
          </button>
        ))}
        {session.pages.example || session.openIds.includes("example") ? null : (
          <button
            type="button"
            className="workbench-menu-item"
            onClick={() => dispatchWorkbenchCommand({ action: "open", id: "example" })}
          >
            {t("workbench.openExample")}
          </button>
        )}
      </nav>
    </aside>
  );
}
