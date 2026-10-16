import { lazy, Suspense, useEffect, useState } from "react";
import type { HostSnapshot } from "@nexttools/protocol";
import { host, nativeHostAvailable } from "./host";
import { MobileApp } from "./mobile/MobileApp";

const DesktopApp = lazy(() =>
  import("./App").then(({ App }) => ({ default: App })),
);

function Desktop() {
  return (
    <Suspense
      fallback={
        <main className="client-startup" role="status">
          正在打开工作台…
        </main>
      }
    >
      <DesktopApp />
    </Suspense>
  );
}

export function ClientRoot() {
  const preview =
    import.meta.env.DEV &&
    new URLSearchParams(location.search).get("preview") === "ios";
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!nativeHostAvailable || preview) return;
    let active = true;
    setError("");
    void host.snapshot().then(
      (value) => {
        if (active) setSnapshot(value);
      },
      (cause) => {
        if (active) setError(String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, preview]);

  if (preview) return <MobileApp initialSnapshot={null} />;
  if (!nativeHostAvailable) return <Desktop />;
  if (!snapshot)
    return (
      <main className="client-startup" aria-busy={!error}>
        <h1>NextTools</h1>
        {error ? (
          <>
            <p role="alert">无法连接本机 Host：{error}</p>
            <button onClick={() => setAttempt((value) => value + 1)}>
              重新连接
            </button>
          </>
        ) : (
          <p role="status">正在连接本机 Host…</p>
        )}
      </main>
    );
  return snapshot.platform === "ios" || snapshot.platform === "android" ? (
    <MobileApp initialSnapshot={snapshot} />
  ) : (
    <Desktop />
  );
}
