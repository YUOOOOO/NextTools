// Object identity remains inside Main. Serialized renderer/model fields are not provenance.
const webRequests = new WeakSet();
export function markWebPrompt(request) { webRequests.add(request); return request; }
export function consumeWebPromptSource(request) {
  if (!request || typeof request !== "object" || !webRequests.has(request)) return undefined;
  webRequests.delete(request);
  return "web";
}
