const initial = () => ({ counter: 0, revision: 0 });
let state = initial();

function invalid(message) {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

function execute(args, { signal }) {
  signal.throwIfAborted();
  const action = args.action ?? "get";
  if (action === "get") return { ...state };

  let next;
  if (action === "reset") {
    next = initial();
  } else if (action === "increment") {
    const delta = args.delta ?? 1;
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(state.counter + delta)) {
      invalid("delta and resulting counter must be safe integers");
    }
    next = { ...state, counter: state.counter + delta };
  } else {
    invalid("action must be get, increment or reset");
  }

  state = { ...next, revision: state.revision + 1 };
  return { ...state };
}

module.exports.onLoad = async () => {
  await pi.workbench.registerService({
    name: "data",
    description: "Read, increment or reset the counter shared with the Data Lab Workbench page.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "increment", "reset"] },
        delta: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute,
  });
};
