export const REMOTE_ACTIONS: string[];
export function remoteSummary(action: string, args?: Record<string, unknown>): string;
export function runRemoteAction(
  action: string,
  args?: Record<string, unknown>,
  deps?: { capture?: () => Promise<unknown>; open?: (path: string) => Promise<string> },
): Promise<unknown>;
