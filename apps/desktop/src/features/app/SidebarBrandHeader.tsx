import { useTranslation } from "react-i18next";
import { BrandLogo } from "../../components/BrandLogo";
import { IconSidebar } from "../../components/icons";
import { TooltipButton } from "../../components/ui";

/** One drag/title row spanning both navigation columns. */
export function SidebarBrandHeader({ onHome, onToggleSidebar, sidebarToggleShortcut }: {
  onHome: () => void;
  onToggleSidebar: () => void;
  sidebarToggleShortcut: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="sidebar-header sidebar-brand-header">
      <TooltipButton type="button" className="brand no-drag" data-nav="home"
        tooltip={t("nav.home")} ariaLabel={t("nav.home")} onClick={onHome}>
        <BrandLogo size={20} />
        <span>{t("app.shellName")}</span>
      </TooltipButton>
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
