import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ConversationSyncStatus } from "../../lib/api";
import { Button, Input, PasswordInput } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

const DEFAULT_SERVER = "http://127.0.0.1:8788";

export function ConversationSyncCard() {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_SERVER);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<ConversationSyncStatus>({ signedIn: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.conversationSyncGetState().then((next) => {
      if (!alive) return;
      setStatus(next);
      if (next.baseUrl) setBaseUrl(next.baseUrl);
    }).catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      alive = false;
    };
  }, []);

  async function run(action: () => Promise<ConversationSyncStatus>) {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      setStatus(next);
      if (next.baseUrl) setBaseUrl(next.baseUrl);
      if (!next.signedIn) {
        setAccount("");
        setPassword("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const counts = status.state?.counts;
  return (
    <SettingsCard title={t("settings.conversationSync.title")}>
      <p className="settings-config-sync-intro">{t("settings.conversationSync.description")}</p>
      {error ? <p className="settings-config-sync-alert-text" role="alert">{error}</p> : null}
      <SettingsRow title={t("settings.conversationSync.server")}>
        <Input
          value={baseUrl}
          disabled={status.signedIn || busy}
          aria-label={t("settings.conversationSync.server")}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </SettingsRow>
      {status.signedIn ? (
        <SettingsRow
          title={status.account || t("settings.conversationSync.signedIn")}
          description={t("settings.conversationSync.counts", {
            conversations: counts?.conversations ?? 0,
            messages: counts?.messages ?? 0,
            cursor: status.state?.cursor ?? 0,
          })}
        >
          <div className="settings-config-sync-actions">
            <Button variant="primary" disabled={busy} onClick={() => void run(() => api.conversationSyncPush())}>
              {t("settings.conversationSync.syncNow")}
            </Button>
            <Button disabled={busy} onClick={() => void run(() => api.conversationSyncSignOut())}>
              {t("settings.conversationSync.signOut")}
            </Button>
          </div>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow title={t("settings.conversationSync.account")}>
            <Input
              value={account}
              disabled={busy}
              autoComplete="username"
              aria-label={t("settings.conversationSync.account")}
              onChange={(event) => setAccount(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow title={t("settings.conversationSync.password")}>
            <div className="settings-config-sync-password-actions">
              <PasswordInput
                value={password}
                disabled={busy}
                autoComplete="current-password"
                aria-label={t("settings.conversationSync.password")}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Button
                variant="primary"
                disabled={busy || !account.trim() || !password}
                onClick={() => void run(() => api.conversationSyncSignIn({ baseUrl, account, password }))}
              >
                {t("settings.conversationSync.signIn")}
              </Button>
              <Button
                disabled={busy || !account.trim() || !password}
                onClick={() => void run(() => api.conversationSyncRegister({ baseUrl, account, password }))}
              >
                {t("settings.conversationSync.register")}
              </Button>
            </div>
          </SettingsRow>
        </>
      )}
    </SettingsCard>
  );
}
