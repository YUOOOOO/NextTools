import type { TaskCallContext } from "./conversation-task-bridge.mjs";
export function createConversationInteractiveBridge(options: {
  authorize(args: Record<string, unknown>, context: TaskCallContext): string;
  getHost(): unknown;
  getSidecar(): unknown;
  currentTurn(sessionId: string): string | null;
  pending(sessionId: string): Promise<unknown>;
  resolvePermission(resolution: unknown): Promise<unknown>;
  resolveAsk(resolution: unknown): Promise<unknown>;
  redact?(value: unknown): unknown;
}): {
  list(args: Record<string, unknown>, context: TaskCallContext): Promise<{ cards: Array<Record<string, unknown>> }>;
  resolve(args: Record<string, unknown>, context: TaskCallContext): Promise<{ ok: boolean }>;
  dispose(): void;
};
