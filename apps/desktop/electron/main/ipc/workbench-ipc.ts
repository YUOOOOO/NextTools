import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export function registerWorkbenchIpc({
  registrar,
  getHost,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
}): void {
  registrar.handle(IPC.invoke.workbenchGet, async (migrate?: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return host.call("workbench.get", migrate === undefined ? {} : { migrate });
  });
  registrar.handle(IPC.invoke.workbenchApply, async (command: unknown) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    if (!command || typeof command !== "object") throw new Error("invalid workbench command");
    return host.call("workbench.apply", command);
  });
}
