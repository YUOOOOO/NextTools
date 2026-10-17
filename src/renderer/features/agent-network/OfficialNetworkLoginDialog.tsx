import { useTranslation } from "react-i18next";
import { joinOfficialNetworkConnection, networkErrorKey } from "@/api/agentNetwork";
import { acceptNetworkRegistry } from "./store";
import { JoinNetworkDialog } from "./JoinNetworkDialog";

export function OfficialNetworkLoginDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("app");
  return (
    <JoinNetworkDialog
      official
      onCancel={onClose}
      onConfirm={async (_url, identifier, password) => {
        try {
          acceptNetworkRegistry(await joinOfficialNetworkConnection(identifier, password, false));
        } catch (failure) {
          throw new Error(t(`agentNetwork.errors.${networkErrorKey(failure)}`));
        }
      }}
    />
  );
}
