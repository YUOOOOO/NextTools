import type { TaskCallContext } from "./conversation-task-bridge.mjs";

type FetchResponse = { ok: boolean; status?: number; json(): Promise<unknown> };
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
export type ConversationSyncStatus = {
  signedIn: boolean;
  baseUrl?: string;
  account?: string;
  accepted?: number;
  state?: unknown;
};
export function validateBaseUrl(value: unknown): string;
export function directFetch(url: string, init?: FetchInit): Promise<FetchResponse>;
export function messageText(message: unknown): string;
export function toSyncChanges(sessions: unknown, deviceId?: string): {
  conversations: Array<{ cid: string; kind: string; title: string; created_at: number; updated_at: number; project_id?: string; project_name?: string; execution_device?: string; session_id?: string }>;
  messages: Array<{ mid: string; cid: string; role: string; text: string; created_at: number }>;
};
export function createConversationSync(options: {
  filePath: string;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
  encryptionAvailable(): boolean;
  fetchImpl?: (url: string, init: FetchInit) => Promise<FetchResponse>;
  listSessions(): Promise<unknown[]>;
  onCall?: (action: string, args: Record<string, unknown>, context: TaskCallContext) => Promise<unknown>;
  WebSocketImpl?: typeof WebSocket;
  deviceId?: string;
}): {
  getState(): Promise<ConversationSyncStatus>;
  register(input: unknown): Promise<ConversationSyncStatus>;
  signIn(input: unknown): Promise<ConversationSyncStatus>;
  signOut(): Promise<ConversationSyncStatus>;
  push(): Promise<ConversationSyncStatus>;
};
