export function createConversationAutoSync(options: {
  sync: { getState(): Promise<{ signedIn: boolean; state?: unknown }>; push(): Promise<unknown> };
  onError(error: unknown): void;
  intervalMs?: number;
}): { start(): void; request(): void; dispose(): void };
