import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";

export function UserMessageSource({ message }: { message: Pick<UiMessage, "role" | "inputSource"> }) {
  const { t } = useTranslation();
  if (message.role !== "user" || message.inputSource !== "web") return null;
  return <div className="message-meta message-input-source" data-input-source="web">
    <span className="message-meta-chip">{t("messageOrigin.web")}</span>
  </div>;
}
