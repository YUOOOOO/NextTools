import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { dispatchWorkbenchCommand, runWorkbenchCommand, useWorkbenchSession } from "./workbench-session";

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
  return (
    <aside className="sidebar sidebar-surface workbench-menu" aria-label={t("workbench.menu")}>
      <nav className="sidebar-body workbench-menu-body">
        {session.openIds.map((id) => {
          const page = session.pages[id];
          if (!page) return null;
          const label = page.title ?? (page.titleKey ? t(page.titleKey) : page.id);
          return (
            <button
              key={id}
              type="button"
              className="workbench-menu-item"
              aria-current={session.activeId === id ? "page" : undefined}
              onClick={() => dispatchWorkbenchCommand({ action: "select", id })}
            >
              {label}
            </button>
          );
        })}
        {Object.values(session.pages)
          .filter((page) => page.id !== "overview" && !session.openIds.includes(page.id))
          .map((page) => (
            <Button
              key={page.id}
              type="button"
              disabled={page.available === false}
              onClick={() => dispatchWorkbenchCommand({ action: "open", id: page.id })}
            >
              {page.title ?? (page.titleKey ? t(page.titleKey) : page.id)}
            </Button>
          ))}
        {session.pages.example || session.openIds.includes("example") ? null : (
          <Button type="button" onClick={() => dispatchWorkbenchCommand({ action: "open", id: "example" })}>
            {t("workbench.openExample")}
          </Button>
        )}
      </nav>
    </aside>
  );
}
