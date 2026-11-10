import { IPC } from "@pi-desktop/shared";
import type { PluginRemoteSessionRequest } from "@pi-desktop/plugin-sdk";
import { createConversationTaskBridge, type InternalInvoke, type TaskCallContext, type TaskSidecar } from "./conversation-task-bridge.mjs";
import { createConversationInteractiveBridge } from "./conversation-interactive-bridge.mjs";
import { markWebPrompt } from "./web-message-source.mjs";

export type RemoteSessionHost = { call(method: string, params: unknown): Promise<unknown> };
export type RemoteSessionDependencies = {
  getHost(): RemoteSessionHost | null;
  getSidecar(): (RemoteSessionHost & TaskSidecar) | null;
  invoke: InternalInvoke;
  currentTurn(sessionId: string): string | null;
  getDevice(): { id: string; name: string; os: string };
  listSessions(): Promise<unknown[]>;
  runCall(action: string, args: Record<string, unknown>, fromWeb: boolean, signal: AbortSignal): Promise<unknown>;
  emit(pluginId: string, event: string, payload: unknown): void;
  onSessionsChanged(): void;
  redact(value: unknown): unknown;
};

/** Plugin-owned brokers preserve native approvals without exposing transports. */
interface RemoteOwner {
  calls: Map<string, AbortController>;
  tasks: {
    sessionFor(args: Record<string, unknown>, context: TaskCallContext): string;
    task(args: Record<string, unknown>, context: TaskCallContext): Promise<{ text: string }>;
    stop(args: Record<string, unknown>, context: TaskCallContext): Promise<{ stopped: boolean }>;
  };
  interactive: {
    list(args: Record<string, unknown>, context: TaskCallContext): Promise<{ cards: Array<Record<string, unknown>> }>;
    resolve(args: Record<string, unknown>, context: TaskCallContext): Promise<{ ok: boolean }>;
    dispose(): void;
  };
}

export function createPluginRemoteSessions(options: RemoteSessionDependencies) {
  function createOwner() {
    const calls = new Map<string, AbortController>();
    const tasks = createConversationTaskBridge({
      getHost: options.getHost, getSidecar: options.getSidecar,
      prompt: ({ inputSource, ...prompt }) => options.invoke(IPC.invoke.agentPrompt, [inputSource === "web" ? markWebPrompt(prompt) : prompt]),
      abort: (request) => options.invoke(IPC.invoke.agentAbort, [request]),
    });
    const interactive = createConversationInteractiveBridge({
      authorize: (args, context) => tasks.sessionFor(args, context),
      getHost: options.getHost, getSidecar: options.getSidecar, currentTurn: options.currentTurn,
      pending: (sessionId) => options.invoke(IPC.invoke.pendingInteractive, [{ sessionId }]),
      resolvePermission: (resolution) => options.invoke(IPC.invoke.toolResolvePermission, [resolution]),
      resolveAsk: (resolution) => options.invoke(IPC.invoke.askToolResolve, [resolution]),
      redact: options.redact,
    });
    return { calls, tasks, interactive };
  }
  const owners = new Map<string, RemoteOwner>();
  const pendingCalls = new Map<string, Map<string, AbortController>>();
  let pendingCount = 0;
  function reset(pluginId: string) {
    const owner = owners.get(pluginId);
    if (!owner) return;
    owners.delete(pluginId);
    for (const controller of owner.calls.values()) controller.abort();
    owner.interactive.dispose();
  }
  return {
    async getDevice(_pluginId: string) { return options.getDevice(); },
    async list(_pluginId: string): Promise<unknown[]> {
      const host = options.getHost();
      if (!host) throw new Error("host_unavailable");
      const sessions = await options.listSessions();
      if (options.getHost() !== host) throw new Error("host_changed");
      return sessions;
    },
    async isDeleted(_pluginId: string, sessionId: string): Promise<boolean> {
      if (typeof sessionId !== "string" || !/^[a-z0-9][a-z0-9._:-]{3,63}$/.test(sessionId)) throw new Error("invalid_session");
      const host = options.getHost();
      if (!host) throw new Error("host_unavailable");
      const result = await host.call("session.get", { id: sessionId, messageLimit: 1 });
      if (options.getHost() !== host) throw new Error("host_changed");
      return !!result && typeof result === "object" && "session" in result && result.session === null;
    },
    async invoke(pluginId: string, input: PluginRemoteSessionRequest): Promise<unknown> {
      if (!input || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 256 ||
          typeof input.scope !== "string" || !input.scope || input.scope.length > 2048 ||
          !input.caller || typeof input.caller.id !== "string" || !input.caller.id || input.caller.id.length > 256 ||
          !["web", "computer", "phone"].includes(input.caller.kind) ||
          typeof input.action !== "string" || !input.args || typeof input.args !== "object" || Array.isArray(input.args) ||
          !Array.isArray(input.sharedSessionIds) || input.sharedSessionIds.length > 10000 ||
          input.sharedSessionIds.some((id) => typeof id !== "string")) throw new Error("invalid_remote_request");
      let owner = owners.get(pluginId);
      if (!owner) {
        if (owners.size >= 64) throw new Error("remote_owner_limit");
        owner = createOwner();
        owners.set(pluginId, owner);
      }
      let pending = pendingCalls.get(pluginId);
      if (pending?.has(input.requestId)) throw new Error("duplicate_request");
      if ((pending?.size ?? 0) >= 32 || pendingCount >= 256) throw new Error("busy");
      if (!pending) {
        pending = new Map<string, AbortController>();
        pendingCalls.set(pluginId, pending);
      }
      const controller = new AbortController();
      owner.calls.set(input.requestId, controller);
      pending.set(input.requestId, controller);
      pendingCount++;
      const shared = new Set(input.sharedSessionIds);
      const caller = { ...input.caller };
      const context = {
        signal: controller.signal, scope: input.scope, caller,
        isSessionShared: (sessionId: string) => shared.has(sessionId),
        emit: (event: Record<string, unknown>) => {
          if (!controller.signal.aborted && owners.get(pluginId) === owner) options.emit(pluginId, "remote-session:event", { requestId: input.requestId, event });
        },
      };
      const check = () => {
        if (controller.signal.aborted || owners.get(pluginId) !== owner) throw new Error("cancelled");
      };
      try {
        check();
        let result: unknown;
        if (input.action === "task" || input.action === "chat.send") {
          const args = input.action === "chat.send" ? { ...input.args, conversation: input.args.conversation ?? "chat" } : input.args;
          try {
            const task = await owner.tasks.task(args, context);
            result = input.action === "chat.send" ? { sessionId: owner.tasks.sessionFor(args, context), result: task } : task;
          }
          finally { options.onSessionsChanged(); }
        } else if (input.action === "interactive.list") result = await owner.interactive.list(input.args, context);
        else if (input.action === "interactive.resolve") result = await owner.interactive.resolve(input.args, context);
        else if (input.action === "stop") result = await owner.tasks.stop(input.args, context);
        else result = await options.runCall(input.action, input.args, caller.kind === "web", controller.signal);
        check();
        return result;
      } finally {
        if (owner.calls.get(input.requestId) === controller) owner.calls.delete(input.requestId);
        pending.delete(input.requestId);
        pendingCount--;
        if (!pending.size) pendingCalls.delete(pluginId);
      }
    },
    cancel(pluginId: string, requestId: string) { owners.get(pluginId)?.calls.get(requestId)?.abort(); },
    reset,
    dispose: reset,
  };
}
