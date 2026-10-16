import { PermissionGate, PiBackend } from "@percho/backend";
import { ExtensionDialogHost } from "../../../../vendor/percho/packages/backend/src/session/extension-dialog-host.ts";

// Pinned to the vendored @percho/backend 0.1.0 SessionRegistry entry shape.
// This is the only compatibility seam that touches Percho's internal registry;
// prompts, cancellation, history, events, and disposal remain Percho operations.
export class PerchoHostBridge {
  constructor(forwardEvent) {
    this.backend = new PiBackend({
      permissionGates: false,
      permissionExtension: false,
      projectTrust: false,
      webFetch: false,
      subagentPreferBuiltin: false,
      tools: [],
    });
    this.liveByPersisted = new Map();
    this.unsubscribeEvents = this.backend.onEvent((persistedId, event) => {
      const liveId = this.liveByPersisted.get(persistedId);
      if (liveId) forwardEvent(liveId, event);
    });
  }

  attach(liveId, session, cwd) {
    const persistedId = session.sessionId;
    if (this.liveByPersisted.has(persistedId))
      throw new Error(`Session already attached: ${persistedId}`);
    const gate = new PermissionGate(() => {});
    gate.bindSession(persistedId);
    const dialogs = new ExtensionDialogHost({
      onRequest() {},
      onResolved() {},
    });
    dialogs.bind(persistedId);
    const modeRef = { current: "default" };
    const unsubscribe = session.subscribe((event) =>
      this.backend.emitEvent(persistedId, event),
    );
    this.backend.registry.add({
      session,
      unsubscribe,
      cwd,
      gate,
      dialogs,
      modeRef,
    });
    this.liveByPersisted.set(persistedId, liveId);
    return persistedId;
  }

  async prompt(persistedId, text) {
    return this.backend.prompt(persistedId, text);
  }

  async abort(persistedId) {
    return this.backend.abort(persistedId);
  }

  async rename(persistedId, title) {
    return this.backend.setSessionName(persistedId, title);
  }

  async thinking(persistedId, level) {
    return this.backend.setThinkingLevel(persistedId, level);
  }

  async export(persistedId) {
    const entry = this.backend.registry.get(persistedId);
    if (!entry) throw new Error(`Session not found: ${persistedId}`);
    const manager = entry.session.sessionManager;
    const header = manager.getHeader();
    if (!header) throw new Error(`Session header missing: ${persistedId}`);
    // The pinned SDK's exportToJsonl writes a file and returns its path.
    // Return data only; the caller owns saving through the approved UI path.
    return `${[header, ...manager.getEntries()].map((item) => JSON.stringify(item)).join("\n")}\n`;
  }

  async messages(persistedId) {
    await this.backend.getSessionMessages(persistedId);
    const entry = this.backend.registry.get(persistedId);
    if (!entry) throw new Error(`Session not found: ${persistedId}`);
    return entry.session.sessionManager
      .getBranch()
      .flatMap((item) => (item.type === "message" ? [item.message] : []));
  }

  async close(persistedId) {
    const result = await this.backend.closeSession(persistedId);
    if (result.closed) this.liveByPersisted.delete(persistedId);
    return result;
  }

  dispose() {
    this.unsubscribeEvents();
    this.liveByPersisted.clear();
    this.backend.dispose();
  }
}
