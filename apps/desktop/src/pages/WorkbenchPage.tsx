import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";
import { dispatchWorkbenchCommand, useWorkbenchSession } from "../features/workbench/workbench-session";

export function WorkbenchPage() {
  const { t } = useTranslation();
  const session = useWorkbenchSession();
  const active = session.activeId ? session.pages[session.activeId] : undefined;

  return (
    <main className="workbench-page">
      {active ? (
        <section className="workbench-page-panel">
          <div className="workbench-page-panel-heading">
            <h1>{t(active.titleKey)}</h1>
            {active.id !== "overview" ? (
              <Button type="button" onClick={() => dispatchWorkbenchCommand({ action: "close", id: active.id })}>
                {t("workbench.closePage")}
              </Button>
            ) : null}
          </div>
          {active.status === "ready" ? <p>{t(active.id === "example" ? "workbench.exampleBody" : "workbench.empty")}</p> : null}
          {active.status === "unavailable" ? <p role="alert">{t("workbench.unavailable")}</p> : null}
          {active.status === "disabled" ? <p>{t("workbench.disabled")}</p> : null}
          {active.id === "example" ? (
            <div className="workbench-page-actions">
              <Button type="button" onClick={() => dispatchWorkbenchCommand({ action: "setStatus", id: active.id, status: "disabled" })}>
                {t("workbench.disable")}
              </Button>
              <Button type="button" onClick={() => dispatchWorkbenchCommand({ action: "setStatus", id: active.id, status: "unavailable" })}>
                {t("workbench.markUnavailable")}
              </Button>
              <Button type="button" onClick={() => dispatchWorkbenchCommand({ action: "setStatus", id: active.id, status: "ready" })}>
                {t("workbench.restore")}
              </Button>
            </div>
          ) : null}
        </section>
      ) : (
        <p>{t("workbench.empty")}</p>
      )}
    </main>
  );
}
