import { useRef, useState } from "react";
import { FloatingFocusManager, useFloating } from "@floating-ui/react";
import { useTranslation } from "react-i18next";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { CloseIcon, LoaderIcon } from "@/components/icons";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
export function JoinNetworkDialog({
  onConfirm,
  onCancel,
  official = false,
}: {
  onConfirm: (url: string, identifier: string, password: string, register: boolean) => Promise<void>;
  onCancel: () => void;
  official?: boolean;
}) {
  const { t } = useTranslation("app"),
    { t: common } = useTranslation("common");
  const [url, setUrl] = useState(""),
    [identifier, setIdentifier] = useState(""),
    [password, setPassword] = useState(""),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null),
    flight = useRef(false);
  const { refs, context } = useFloating({ open: true });
  const close = () => {
    if (!flight.current) {
      setPassword("");
      onCancel();
    }
  };
  async function submit() {
    if (flight.current || (!official && !url.trim()) || !identifier.trim() || !password) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(url.trim(), identifier.trim(), password, !official && register);
      setPassword("");
      onCancel();
    } catch (failure) {
      setPassword("");
      setError(
        failure instanceof Error ? failure.message : t("agentNetwork.errors.failed"),
      );
      setBusy(false);
    } finally {
      flight.current = false;
    }
  }
  return (
    <OverlayBackdrop
      portal
      className="z-[260] px-4"
      onClose={busy ? undefined : close}
    >
      <FloatingFocusManager context={context} initialFocus={input}>
        <section
          ref={refs.setFloating}
          role="dialog"
          aria-modal="true"
          aria-labelledby="join-network-title"
          className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !isImeComposingEvent(e)) {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="join-network-title" className="text-lg font-semibold">
              {t(official ? "agentNetwork.login" : "agentNetwork.joinSelfhost")}
            </h2>
            <button
              type="button"
              onClick={close}
              disabled={busy}
              aria-label={common("actions.close")}
              className="rounded-lg p-2 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {!official && (
              <>
                <label htmlFor="network-url" className="mb-2 block text-sm font-medium">
                  {t("agentNetwork.serviceUrl")}
                </label>
                <input
                  ref={input}
                  id="network-url"
                  type="url"
                  autoComplete="off"
                  placeholder="https://your-network.workers.dev"
                  value={url}
                  disabled={busy}
                  onChange={(e) => setUrl(e.target.value)}
                  className="mb-4 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                />
              </>
            )}
            <label htmlFor="network-account" className="mb-2 block text-sm font-medium">
              {t("agentNetwork.accountIdentifier")}
            </label>
            <input
              ref={official ? input : undefined}
              id="network-account"
              type="text"
              autoComplete="username"
              value={identifier}
              disabled={busy}
              onChange={(e) => setIdentifier(e.target.value)}
              className="mb-4 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            <label htmlFor="network-password" className="mb-2 block text-sm font-medium">
              {t("agentNetwork.accountPassword")}
            </label>
            <input
              id="network-password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            {!official && (
              <>
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={register} disabled={busy} onChange={(e) => setRegister(e.target.checked)} />
                  {t("agentNetwork.createAccount")}
                </label>
                <p className="mt-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                  {t("agentNetwork.selfhostHint")}
                </p>
              </>
            )}
            {error && (
              <p role="alert" className="mt-3 text-sm text-[var(--error)]">{error}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={close} disabled={busy} className="rounded-lg px-4 py-2 text-sm hover:bg-[var(--paper-inset)]">
                {common("actions.cancel")}
              </button>
              <button type="submit" disabled={busy || (!official && !url.trim()) || !identifier.trim() || !password} className="flex items-center gap-2 rounded-lg bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)] disabled:opacity-50">
                {busy && <LoaderIcon className="h-4 w-4 animate-spin" />}
                {t(busy ? (official ? "agentNetwork.loggingIn" : "agentNetwork.joiningSelfhost") : (official ? "agentNetwork.login" : "agentNetwork.join"))}
              </button>
            </div>
          </form>
        </section>
      </FloatingFocusManager>
    </OverlayBackdrop>
  );
}
