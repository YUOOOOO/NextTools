import { randomUUID } from "node:crypto";
import { messageText } from "./conversation-sync-client.mjs";

const failure = (code) => Object.assign(new Error(code), { code });

/** Owns only sessions created for hub conversations. Execution goes through the
 * normal desktop Agent IPC handlers, never directly through agent.prompt. */
export function createConversationTaskBridge({ getHost, getSidecar, prompt, abort, timeoutMs = 600_000 }) {
  const sessions = new Map();
  const active = new Map();

  function keyFor(args, context) {
    const conversation = args?.conversation;
    const caller = context?.caller?.id;
    if (typeof conversation !== "string" || !conversation.trim() || conversation.length > 256 ||
        typeof caller !== "string" || !caller || typeof context?.scope !== "string" || !context.scope) {
      throw failure("invalid_conversation");
    }
    return JSON.stringify([context.scope, caller, conversation]);
  }

  return {
    async task(args, context) {
      const key = keyFor(args, context);
      if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 65_536) throw failure("invalid_text");
      if (active.has(key) || active.size >= 8) throw failure("busy");
      if (context.signal.aborted) throw failure("cancelled");
      const host = getHost();
      const sidecar = getSidecar();
      if (!host || !sidecar || !prompt || !abort) throw failure("agent_unavailable");
      const controller = new AbortController();
      const state = { controller };
      active.set(key, state);
      const cancel = () => controller.abort();
      context.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, timeoutMs);
      timer.unref?.();
      let unsubscribe = () => {};
      let sessionId;
      let turnId;
      let terminal = false;
      let abortPromise;
      const abortTurn = () => {
        if (!turnId || terminal) return Promise.resolve();
        abortPromise ??= abort({ sessionId, turnId });
        return abortPromise;
      };
      const check = () => {
        if (controller.signal.aborted || context.signal.aborted) throw failure("cancelled");
        if (getHost() !== host || getSidecar() !== sidecar) throw failure("agent_unavailable");
      };
      const emit = (body) => {
        if (!controller.signal.aborted && !context.signal.aborted) context.emit(body);
      };
      try {
        sessionId = sessions.get(key);
        if (!sessionId) {
          if (sessions.size >= 512) throw failure("conversation_limit");
          const created = await host.call("session.create", { title: "Web", mode: "agent" });
          sessionId = created?.session?.id;
          if (typeof sessionId !== "string" || !sessionId) throw failure("agent_unavailable");
          sessions.set(key, sessionId);
        }
        check();
        // session.create ignores arbitrary permissionMode. Configure the dedicated
        // session explicitly: a remote task must not inherit unattended execution.
        await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "ask" });
        check();
        let resolveEnd;
        let rejectEnd;
        const ended = new Promise((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
        // Admission can fail after a fast terminal notification. Always observe it.
        ended.catch(() => {});
        let settled = false;
        let finalText = "";
        let buffered = [];
        const finish = (error) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          controller.signal.removeEventListener("abort", onCancel);
          if (error) rejectEnd(error);
          else resolveEnd({ text: finalText });
        };
        const onCancel = () => finish(failure("cancelled"));
        controller.signal.addEventListener("abort", onCancel, { once: true });
        const receive = (envelope) => {
          if (settled || controller.signal.aborted || context.signal.aborted ||
              envelope?.sessionId !== sessionId || envelope.parentToolCallId || envelope.agentName) return;
          if (!turnId) {
            if (buffered.length >= 1024) { cancel(); return; }
            buffered.push(envelope);
            return;
          }
          if (envelope.turnId !== turnId) return;
          if (getHost() !== host || getSidecar() !== sidecar) { cancel(); return; }
          const event = envelope.event;
          if (event?.type === "tool_start") {
            // Do not forward tool arguments, results, reasoning or credentials.
            emit({ stage: "tool", name: String(event.toolName ?? "tool"), summary: "" });
          } else if (event?.type === "message_update" && event.message?.role === "assistant") {
            if (typeof event.deltaText === "string" && event.deltaText) {
              emit({ stage: "text", text: event.deltaText, interim: false, delta: true });
            }
          } else if (event?.type === "message_end" && event.message?.role === "assistant") {
            finalText = messageText(event.message);
            emit({ stage: "text", text: finalText, interim: false });
          } else if (event?.type === "error") {
            terminal = true;
            finish(failure("task_failed"));
          } else if (event?.type === "agent_end") {
            terminal = true;
            finish(finalText ? undefined : failure("no_answer"));
          }
        };
        unsubscribe = sidecar.onNotification((method, envelope) => {
          if (method === "agent.event") receive(envelope);
        });
        emit({ stage: "thinking" });
        check();
        const admitted = await prompt({ sessionId, content: args.text, messageId: randomUUID() });
        if (admitted?.accepted !== true || typeof admitted.turnId !== "string" || !admitted.turnId) {
          throw failure("admission_failed");
        }
        turnId = admitted.turnId;
        check();
        const pending = buffered;
        buffered = [];
        for (const envelope of pending) receive(envelope);
        const result = await ended;
        check();
        emit({ stage: "done" });
        return result;
      } catch (error) {
        // A cancelled call may finish admission later; abort only its exact turn.
        // Keep its busy lease until that admission/abort has settled.
        if (turnId && !terminal) {
          try { await abortTurn(); } catch { throw failure("abort_failed"); }
        }
        const code = ["cancelled", "agent_unavailable", "conversation_limit", "admission_failed", "no_answer", "task_failed"].includes(error?.code)
          ? error.code : "task_failed";
        emit({ stage: "error", code, message: code });
        throw failure(code);
      } finally {
        unsubscribe();
        controller.abort();
        context.signal.removeEventListener("abort", cancel);
        clearTimeout(timer);
        if (active.get(key) === state) active.delete(key);
      }
    },
    async stop(args, context) {
      const state = active.get(keyFor(args, context));
      if (!state) return { stopped: false };
      state.controller.abort();
      return { stopped: true };
    },
  };
}
