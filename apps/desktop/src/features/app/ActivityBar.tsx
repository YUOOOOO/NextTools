import { useTranslation } from "react-i18next";
import {
  IconBot,
  IconClock,
  IconCode,
  IconPlug,
  IconSettings,
} from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import { NotificationCenter } from "../../components/NotificationCenter";
import { ACTIVITY_BAR_WIDTH, ACTIVITY_NAVIGATION, selectActivityPage } from "./activity-navigation";
import { useAppStore } from "../../stores/app-store";

const icons = {
  chat: IconBot,
  workbench: IconCode,
  scheduled: IconClock,
  plugins: IconPlug,
} as const;

export function ActivityBar() {
  const { t } = useTranslation();
  const page = useAppStore((state) => state.page);
  const onPageChange = useAppStore((state) => state.setPage);
  return (
    <nav className="activity-bar" style={{ width: ACTIVITY_BAR_WIDTH }} aria-label={t("nav.primaryNavigation")}>
      <div className="activity-bar-top">
        {ACTIVITY_NAVIGATION.map((item) => {
          const Icon = icons[item.icon];
          const selected = page === item.page;
          const label = t(item.labelKey);
          return (
            <TooltipButton
              key={item.page}
              className="activity-bar-button"
              tooltip={label}
              ariaLabel={label}
              aria-current={selected ? "page" : undefined}
              data-page={item.page}
              data-nav={item.page}
              onClick={() => {
                selectActivityPage(page, item.page, onPageChange);
              }}
            >
              <Icon size={22} />
            </TooltipButton>
          );
        })}
      </div>
      <div className="activity-bar-bottom">
        <NotificationCenter
          triggerClassName="activity-bar-button"
          iconSize={22}
          placement="right"
        />
        <TooltipButton
          className="activity-bar-button"
          tooltip={t("nav.settings")}
          ariaLabel={t("nav.settings")}
          aria-current={page === "settings" ? "page" : undefined}
          data-nav="settings"
          onClick={() => { if (page !== "settings") onPageChange("settings"); }}
        >
          <IconSettings size={22} />
        </TooltipButton>
      </div>
    </nav>
  );
}
