export type TaskCallContext = {
  signal: AbortSignal;
  scope: string;
  isSessionShared?(sessionId: string): boolean;
  caller: { id: string; name?: string; kind?: string };
  emit(body: Record<string, unknown>): void;
};
export type TaskSidecar = {
  onNotification(handler: (method: string, params: unknown) => void): () => void;
};
export type InternalInvoke = (channel: string, args: unknown[]) => Promise<unknown>;
export function createConversationTaskBridge(options: {
  getHost(): { call(method: string, params: unknown): Promise<unknown> } | null;
  getSidecar(): TaskSidecar | null;
  prompt?: (request: { sessionId: string; content: string; messageId: string; inputSource?: "web" }) => Promise<unknown>;
  abort?: (request: { sessionId: string; turnId: string }) => Promise<unknown>;
  timeoutMs?: number;
}): {
  task(args: Record<string, unknown>, context: TaskCallContext): Promise<{ text: string }>;
  stop(args: Record<string, unknown>, context: TaskCallContext): Promise<{ stopped: boolean }>;
};
