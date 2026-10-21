export const ACTIVITY_BAR_WIDTH = 48;

export type ActivityNavigationItem = {
  page: import("../../stores/app-state").AppState["page"];
  labelKey: "nav.agent" | "nav.workbench" | "scheduled.title" | "nav.plugins";
  icon: "chat" | "workbench" | "scheduled" | "plugins";
};

export const ACTIVITY_NAVIGATION: readonly ActivityNavigationItem[] = [
  { page: "chat", labelKey: "nav.agent", icon: "chat" },
  { page: "workbench", labelKey: "nav.workbench", icon: "workbench" },
  { page: "scheduled", labelKey: "scheduled.title", icon: "scheduled" },
  { page: "plugins", labelKey: "nav.plugins", icon: "plugins" },
];

export function selectActivityPage(
  current: import("../../stores/app-state").AppState["page"],
  next: import("../../stores/app-state").AppState["page"],
  setPage: (page: import("../../stores/app-state").AppState["page"]) => void,
): void {
  if (current !== next) setPage(next);
}
