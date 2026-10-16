import type { AgentSessionInfo } from "@nexttools/protocol";

export type AgentTimelineItem = {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool";
  title: string;
  text: string;
  status?: "running" | "done" | "error";
};
export type AgentApproval = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
};
export type LiveAgentSession = {
  info: AgentSessionInfo & { persistedSessionId?: string };
  title: string;
  messages: AgentTimelineItem[];
  input: string;
  running: boolean;
  stopping: boolean;
  closing: boolean;
  unavailable: boolean;
  error: string;
  approvals: AgentApproval[];
  resolving: Set<string>;
  messageSequence: number;
};
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function stringField(
  value: Record<string, unknown> | null,
  key: string,
): string {
  return typeof value?.[key] === "string" ? value[key] : "";
}
export function displayJson(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}
export function createLiveSession(info: AgentSessionInfo): LiveAgentSession {
  return {
    info,
    title: "新会话",
    messages: [],
    input: "",
    running: false,
    stopping: false,
    closing: false,
    unavailable: false,
    error: "",
    approvals: [],
    resolving: new Set(),
    messageSequence: 0,
  };
}
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      const item = asRecord(block);
      return stringField(item, "text") || stringField(item, "thinking");
    })
    .filter(Boolean)
    .join("\n");
}
function renderMessage(value: unknown, id: string): AgentTimelineItem[] {
  const message = asRecord(value);
  const role = stringField(message, "role");
  if (role === "user")
    return [
      {
        id,
        kind: "user",
        title: "你",
        text: contentText(message?.content),
        status: "done",
      },
    ];
  if (role === "toolResult")
    return [
      {
        id: `tool-${stringField(message, "toolCallId")}`,
        kind: "tool",
        title: stringField(message, "toolName") || "工具",
        text: contentText(message?.content),
        status: message?.isError ? "error" : "done",
      },
    ];
  if (role !== "assistant") return [];
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((value, index): AgentTimelineItem[] => {
    const block = asRecord(value);
    const type = stringField(block, "type");
    if (type !== "text" && type !== "thinking") return [];
    return [
      {
        id: `${id}-${index}`,
        kind: type === "thinking" ? "thinking" : "assistant",
        title: type === "thinking" ? "思考" : "Pi",
        text: stringField(block, type),
        status: message?.stopReason === "error" ? "error" : "done",
      },
    ];
  });
}
function upsert(
  items: AgentTimelineItem[],
  next: AgentTimelineItem,
): AgentTimelineItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item, position) => (position === index ? next : item));
}
export function reduceAgentEvent(
  session: LiveAgentSession,
  value: unknown,
): LiveAgentSession {
  const event = asRecord(value);
  if (!event) return session;
  const type = stringField(event, "type");
  if (type === "session_ready")
    return {
      ...session,
      info: {
        ...session.info,
        persistedSessionId:
          stringField(event, "persistedSessionId") ||
          stringField(event, "sessionId") ||
          session.info.persistedSessionId,
        model: stringField(event, "model") || session.info.model,
      },
    };
  if (type === "session_info_changed")
    return { ...session, title: stringField(event, "name") || session.title };
  if (type === "session_restored") {
    const source = Array.isArray(event.messages) ? event.messages : [];
    let messages: AgentTimelineItem[] = [];
    source.forEach((message, index) => {
      for (const item of renderMessage(message, `history-${index}`))
        messages = upsert(messages, item);
    });
    return { ...session, messages, messageSequence: source.length };
  }
  if (type === "approval") {
    const requestId = stringField(event, "requestId");
    if (
      !requestId ||
      session.approvals.some((item) => item.requestId === requestId)
    )
      return session;
    return {
      ...session,
      approvals: [
        ...session.approvals,
        {
          requestId,
          sessionId: session.info.sessionId,
          toolName: stringField(event, "toolName"),
          input: event.input,
        },
      ],
    };
  }
  if (type === "approval_resolved") {
    const requestId = stringField(event, "requestId");
    const resolving = new Set(session.resolving);
    resolving.delete(requestId);
    return {
      ...session,
      approvals: session.approvals.filter(
        (item) => item.requestId !== requestId,
      ),
      resolving,
    };
  }
  if (type === "agent_start") return { ...session, running: true, error: "" };
  if (type === "agent_settled" || type === "error") {
    const error =
      type === "error"
        ? displayJson(event.error ?? event.message ?? "Agent 运行失败")
        : session.error;
    return {
      ...session,
      running: false,
      stopping: false,
      error,
      approvals: [],
      resolving: new Set(),
      messages: session.messages.map((item) =>
        item.status === "running"
          ? { ...item, status: type === "error" ? "error" : "done" }
          : item,
      ),
    };
  }
  if (type === "message_start") {
    const message = asRecord(event.message);
    if (message?.role === "assistant")
      return { ...session, messageSequence: session.messageSequence + 1 };
    if (message?.role !== "user") return session;
    const text = contentText(message.content);
    // The local user row is optimistic; replace it when Pi acknowledges it.
    const index = session.messages.findIndex(
      (item) => item.id.startsWith("local-user-") && item.text === text,
    );
    if (index >= 0)
      return {
        ...session,
        messages: session.messages.map((item, i) =>
          i === index
            ? { ...item, id: `user-${session.messageSequence}` }
            : item,
        ),
        messageSequence: session.messageSequence + 1,
      };
    return {
      ...session,
      messages: [
        ...session.messages,
        ...renderMessage(message, `user-${session.messageSequence}`),
      ],
      messageSequence: session.messageSequence + 1,
    };
  }
  if (type === "message_update") {
    const update = asRecord(event.assistantMessageEvent);
    const updateType = stringField(update, "type");
    if (updateType !== "text_delta" && updateType !== "thinking_delta")
      return session;
    const kind = updateType === "thinking_delta" ? "thinking" : "assistant";
    const id = `assistant-${session.messageSequence}-${Number(update?.contentIndex ?? 0)}`;
    const previous = session.messages.find((item) => item.id === id);
    return {
      ...session,
      messages: upsert(session.messages, {
        id,
        kind,
        title: kind === "thinking" ? "思考" : "Pi",
        text: (previous?.text ?? "") + stringField(update, "delta"),
        status: "running",
      }),
    };
  }
  if (type === "message_end") {
    const message = asRecord(event.message);
    if (message?.role === "user") return session;
    let messages = session.messages;
    for (const item of renderMessage(
      message,
      `assistant-${session.messageSequence}`,
    ))
      messages = upsert(messages, item);
    return {
      ...session,
      messages,
      error: stringField(message, "errorMessage") || session.error,
    };
  }
  if (type.startsWith("tool_execution_")) {
    const id = `tool-${stringField(event, "toolCallId")}`;
    const previous = session.messages.find((item) => item.id === id);
    const result = asRecord(event.result ?? event.partialResult);
    const done = type === "tool_execution_end";
    return {
      ...session,
      messages: upsert(session.messages, {
        id,
        kind: "tool",
        title: stringField(event, "toolName") || previous?.title || "工具",
        text: result
          ? contentText(result.content) || displayJson(result.details)
          : previous?.text || displayJson(event.args),
        status: done ? (event.isError ? "error" : "done") : "running",
      }),
    };
  }
  return session;
}
