import { randomUUID, createHash } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });
const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
const signature = (kind, request) => createHash("sha256").update(JSON.stringify([kind, request])).digest("hex");

/** Ephemeral remote views of authoritative desktop requests. Never an approval authority. */
export function createConversationInteractiveBridge({ authorize, getHost, getSidecar, currentTurn,
  pending, resolvePermission, resolveAsk, redact = (value) => value, now = Date.now, ttlMs = 600_000 }) {
  let generation = 0;
  const cards = new Map();
  const locks = new Set();
  const owner = (context) => JSON.stringify([context.scope, context.caller.id]);
  function check(context, host, sidecar, args, sessionId) {
    if (context.signal.aborted) throw fail("cancelled");
    if (getHost() !== host || getSidecar() !== sidecar) throw fail("agent_unavailable");
    if (authorize(args, context) !== sessionId) throw fail("session_not_shared");
  }
  function sweep() {
    for (const [id, card] of cards) if (card.expires <= now()) cards.delete(id);
  }
  async function snapshot(args, context) {
    const epoch = generation;
    const sessionId = authorize(args, context);
    const host = getHost(), sidecar = getSidecar();
    check(context, host, sidecar, args, sessionId);
    if (!host || !sidecar) throw fail("agent_unavailable");
    const turnId = currentTurn(sessionId);
    if (!turnId) return { sessionId, turnId: null, requests: [], host, sidecar };
    const value = await pending(sessionId);
    if (epoch !== generation) throw fail("card_expired");
    check(context, host, sidecar, args, sessionId);
    if (currentTurn(sessionId) !== turnId) throw fail("card_expired");
    const requests = [];
    for (const [kind, rows] of [["permission", value?.permissions], ["ask", value?.asks]]) {
      for (const request of Array.isArray(rows) ? rows.slice(0, 32) : []) {
        if (!request || request.sessionId !== sessionId || typeof request.requestId !== "string" || !request.requestId ||
            typeof request.toolCallId !== "string" || !request.toolCallId) continue;
        if (kind === "ask" && (!Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 16)) continue;
        requests.push({ kind, request, signature: signature(kind, request) });
      }
    }
    return { sessionId, turnId, requests, host, sidecar };
  }
  function project(card) {
    const request = card.request;
    if (card.kind === "permission") return {
      id: card.id, kind: card.kind, toolName: text(request.toolName, 200),
      preview: text(typeof redact(request.argsPreview) === "string" ? redact(request.argsPreview) : JSON.stringify(redact(request.argsPreview) ?? ""), 8000),
      risk: text(request.risk, 40), reason: text(redact(request.reason), 1000),
    };
    return { id: card.id, kind: card.kind, questions: request.questions.map((question) => ({
      question: text(redact(question.question), 300), multiSelect: question.multiSelect === true,
      options: (Array.isArray(question.options) ? question.options : []).slice(0, 100).flatMap((option, index) => {
        const key = card.request.questions.indexOf(question) + ":" + index;
        if (!card.optionIds.has(key)) card.optionIds.set(key, randomUUID());
        const id = card.optionIds.get(key);
        if (typeof option === "string" && option.trim()) return [{ id, label: text(redact(option), 1000) }];
        if (option && typeof option.label === "string" && option.label.trim()) return [{ id, label: text(redact(option.label), 1000), ...(typeof option.description === "string" ? { description: text(redact(option.description), 2000) } : {}) }];
        return [];
      }),
    })) };
  }
  const safe = (fn) => async (args, context) => {
    try { return await fn(args, context); }
    catch (error) {
      const code = ["cancelled", "agent_unavailable", "session_not_shared", "session_not_found", "invalid_conversation", "card_expired", "card_busy", "invalid_answer"].includes(error?.code) ? error.code : "interactive_unavailable";
      throw fail(code);
    }
  };
  return {
    list: safe(async (args, context) => {
      sweep();
      const snap = await snapshot(args, context), who = owner(context), out = [];
      for (const [id, card] of cards) {
        if (card.owner === who && card.sessionId === snap.sessionId &&
            (card.host !== snap.host || card.sidecar !== snap.sidecar || card.turnId !== snap.turnId || !snap.requests.some((r) => r.signature === card.signature))) cards.delete(id);
      }
      for (const item of snap.requests) {
        let card = [...cards.values()].find((c) => c.owner === who && c.sessionId === snap.sessionId && c.turnId === snap.turnId && c.host === snap.host && c.sidecar === snap.sidecar && c.signature === item.signature);
        if (!card) {
          if (cards.size >= 1024) throw fail("card_busy");
          card = { ...item, id: randomUUID(), owner: who, sessionId: snap.sessionId, turnId: snap.turnId, expires: now() + ttlMs, host: snap.host, sidecar: snap.sidecar, optionIds: new Map() };
          cards.set(card.id, card);
        }
        out.push(project(card));
      }
      return { cards: out };
    }),
    resolve: safe(async (args, context) => {
      sweep();
      const sessionId = authorize(args, context), card = cards.get(args.id);
      if (!card || card.owner !== owner(context) || card.sessionId !== sessionId) throw fail("card_expired");
      let resolution;
      if (card.kind === "permission") {
        if (args.decision !== "allow-once" && args.decision !== "deny") throw fail("invalid_answer");
        resolution = { requestId: card.request.requestId, decision: args.decision };
      } else {
        const answers = args.answers;
        if (!Array.isArray(answers) || answers.length !== card.request.questions.length) throw fail("invalid_answer");
        let characters = 0;
        const normalized = [];
        for (let index = 0; index < answers.length; index++) {
          const answer = answers[index];
          if (answer === null) { normalized.push(null); continue; }
          if (!Array.isArray(answer) || answer.length > 100 || (!card.request.questions[index].multiSelect && answer.length > 1)) throw fail("invalid_answer");
          const seen = new Set(), values = [];
          for (const raw of answer) {
            let value = raw;
            if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 1 && typeof raw.option === "string") {
              const options = card.request.questions[index].options || [];
              const position = options.findIndex((_option, optionIndex) => card.optionIds.get(index + ":" + optionIndex) === raw.option);
              if (position < 0) throw fail("invalid_answer");
              value = typeof options[position] === "string" ? options[position] : options[position].label;
            }
            if (typeof value !== "string" || !value.trim() || value.length > 4000 || seen.has(value)) throw fail("invalid_answer");
            characters += value.length; seen.add(value); values.push(value);
          }
          normalized.push(values);
        }
        if (characters > 16000) throw fail("invalid_answer");
        resolution = { sessionId, requestId: card.request.requestId, answers: normalized };
      }
      const lock = JSON.stringify([context.scope, sessionId, card.turnId, card.kind, card.request.requestId]);
      if (locks.has(lock)) throw fail("card_busy");
      locks.add(lock);
      try {
        const snap = await snapshot(args, context);
        if (cards.get(card.id) !== card || card.expires <= now() || card.host !== snap.host || card.sidecar !== snap.sidecar || snap.turnId !== card.turnId || !snap.requests.some((r) => r.signature === card.signature)) throw fail("card_expired");
        check(context, snap.host, snap.sidecar, args, sessionId);
        const result = card.kind === "permission" ? await resolvePermission(resolution) : await resolveAsk(resolution);
        if (result?.ok !== true) throw fail("card_expired");
        // Consume every token for this request, including another tab's view.
        for (const [id, item] of cards) if (item.sessionId === sessionId && item.turnId === card.turnId && item.kind === card.kind && item.request.requestId === card.request.requestId) cards.delete(id);
        return { ok: true };
      } catch (error) {
        cards.delete(card.id);
        if (["card_expired", "cancelled", "agent_unavailable", "session_not_shared"].includes(error?.code)) throw error;
        throw fail("card_expired");
      } finally { locks.delete(lock); }
    }),
    dispose() { generation++; cards.clear(); },
  };
}
