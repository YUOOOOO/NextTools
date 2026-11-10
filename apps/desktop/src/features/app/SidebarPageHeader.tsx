import { useTranslation } from "react-i18next";
import { IconSidebar } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import type { AppState } from "../../stores/app-state";
import { activityPageLabelKey } from "./activity-navigation";

/**
 * Header of the menu column beside the activity rail: the active destination's
 * name, then the collapse control at the column's right edge. The product mark
 * lives in the rail itself, so this row never repeats it.
 */
export function SidebarPageHeader({ page, onToggleSidebar, sidebarToggleShortcut }: {
  page: AppState["page"];
  onToggleSidebar: () => void;
  sidebarToggleShortcut: string;
}) {
  const { t } = useTranslation();
  const labelKey = activityPageLabelKey(page);
  return (
    <div className="sidebar-header sidebar-page-header">
      <span className="sidebar-page-title" data-nav="page-title">
        {labelKey ? t(labelKey) : null}
      </span>
      <div className="sidebar-header-actions no-drag">
        <TooltipButton type="button" className="icon-btn icon-btn-square"
          tooltip={sidebarToggleShortcut ? `${t("nav.collapseSidebar")} (${sidebarToggleShortcut})` : t("nav.collapseSidebar")}
          ariaLabel={t("nav.collapseSidebar")} aria-expanded={true} data-nav="toggle-sidebar" onClick={onToggleSidebar}>
          <IconSidebar size={15} />
        </TooltipButton>
      </div>
    </div>
  );
}
