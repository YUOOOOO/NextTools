import { useTranslation } from "react-i18next";
import { PluginViewTab } from "../components/workpanel/PluginViewTab";
import { useWorkbenchSession } from "../features/workbench/workbench-session";

export function WorkbenchPage() {
  const { t } = useTranslation();
  const session = useWorkbenchSession();
  const active = session.activeId ? session.pages[session.activeId] : undefined;
  const label = active ? active.title ?? (active.titleKey ? t(active.titleKey) : active.id) : "";
  const pluginId = active?.pluginId;
  const viewId = active?.viewId;
  const showPluginView = Boolean(
    active &&
      active.status === "ready" &&
      active.available !== false &&
      pluginId &&
      viewId,
  );

  return (
    <main className="workbench-page">
      {active ? (
        <section className="workbench-page-panel">
          {active.status === "ready" && active.available !== false && !showPluginView ? (
            <p>{t(active.id === "example" ? "workbench.exampleBody" : "workbench.empty")}</p>
          ) : null}
          {active.status === "unavailable" || (active.status === "ready" && active.available === false) ? (
            <p role="alert">{t("workbench.unavailable")}</p>
          ) : null}
          {active.status === "disabled" ? <p>{t("workbench.disabled")}</p> : null}
          {showPluginView && pluginId && viewId ? (
            <PluginViewTab
              pluginId={pluginId}
              viewId={viewId}
              title={label}
              releaseOnUnmount
            />
          ) : null}
        </section>
      ) : (
        <p>{t("workbench.empty")}</p>
      )}
    </main>
  );
}
