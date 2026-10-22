/** One handler map for a plugin's Workbench service methods. */

export function declaredWorkbenchServiceNames(manifest) {
  const entries = manifest?.contributes?.workbenchServices;
  if (!Array.isArray(entries)) return new Set();
  return new Set(
    entries
      .map((entry) => (entry && typeof entry.name === "string" ? entry.name : ""))
      .filter((name) => name.length > 0),
  );
}

export function createWorkbenchServiceRegistry() {
  const handlers = new Map();
  return {
    has(name) {
      return handlers.has(name);
    },
    register(name, execute) {
      if (typeof name !== "string" || !name || typeof execute !== "function") {
        const error = new Error("workbench service name and execute are required");
        error.code = "INVALID_ARGUMENT";
        throw error;
      }
      if (handlers.has(name)) {
        const error = new Error(`workbench service already registered: ${name}`);
        error.code = "CONFLICT";
        throw error;
      }
      handlers.set(name, execute);
    },
    remove(name) {
      handlers.delete(name);
    },
    clear() {
      handlers.clear();
    },
    call(name, args, context) {
      const execute = handlers.get(name);
      if (!execute) {
        const error = new Error(`workbench service not registered: ${name}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return execute(args ?? {}, context);
    },
  };
}
