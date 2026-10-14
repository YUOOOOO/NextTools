import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

function asToolResult(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : (JSON.stringify(value) ?? "null") }],
    details: value,
  };
}

export function createHostTools(sessionId, hostCall) {
  const tool = (name, label, description, properties) => defineTool({
    name,
    label,
    description,
    promptSnippet: description,
    parameters: Type.Object(properties, { additionalProperties: false }),
    async execute(_toolCallId, input, signal) {
      const result = await hostCall("tool.invoke", { sessionId, toolName: name, input }, signal);
      return asToolResult(result);
    },
  });
  return [
    tool("workspace_read", "Read file", "Read an authorized UTF-8 file in the workspace through the desktop Host.", {
      path: Type.String({ minLength: 1, description: "Workspace-relative file path" }),
    }),
    tool("workspace_list", "List directory", "List an authorized workspace directory through the desktop Host.", {
      path: Type.Optional(Type.String({ description: "Workspace-relative directory; omit for root" })),
    }),
    tool("workspace_write", "Write file", "Write UTF-8 file content through the desktop Host; requires desktop approval.", {
      path: Type.String({ minLength: 1, description: "Workspace-relative file path" }),
      content: Type.String({ description: "Complete UTF-8 file content" }),
    }),
    tool("shell_execute", "Run command", "Run a command in the workspace through the desktop Host; requires desktop approval.", {
      command: Type.String({ minLength: 1, description: "Command interpreted by the Host's workspace shell" }),
    }),
    tool("git_status", "Git status", "Show Git working-tree status through the desktop Host.", {}),
    tool("git_diff", "Git diff", "Show the Git diff through the desktop Host.", {
      staged: Type.Optional(Type.Boolean({ description: "Show staged changes instead of unstaged changes" })),
    }),
    tool("git_log", "Git log", "Show recent Git commits through the desktop Host.", {
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    tool("git_branch", "Git branches", "List local and remote Git branches through the desktop Host.", {}),
    tool("git_commit", "Git commit", "Create a Git commit through the desktop Host; requires desktop approval.", {
      message: Type.String({ minLength: 1 }),
    }),
    tool("git_push", "Git push", "Push the branch through the desktop Host; requires desktop approval.", {
      remote: Type.Optional(Type.String({ minLength: 1 })),
      branch: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ];
}

export function createMcpTools(sessionId, hostCall, definitions) {
  if (!Array.isArray(definitions)) return [];
  const seen = new Set();
  return definitions.flatMap((definition) => {
    const name = typeof definition?.name === "string" ? definition.name.trim() : "";
    if (!/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name) || seen.has(name)) return [];
    seen.add(name);
    const rawSchema = definition.inputSchema;
    const parameters = rawSchema && typeof rawSchema === "object" && !Array.isArray(rawSchema) && rawSchema.type === "object"
      ? rawSchema
      : Type.Object({}, { additionalProperties: true });
    const description = typeof definition.description === "string" && definition.description.trim()
      ? definition.description.trim()
      : `Invoke the authorized MCP tool ${name} through the desktop Host.`;
    return [defineTool({
      name,
      label: typeof definition.label === "string" && definition.label.trim() ? definition.label.trim() : name,
      description,
      promptSnippet: description,
      parameters,
      async execute(_toolCallId, input, signal) {
        const result = await hostCall("tool.invoke", { sessionId, toolName: name, input }, signal);
        return asToolResult(result);
      },
    })];
  });
}

export function createSkillTool(sessionId, hostCall) {
  return defineTool({
    name: "skill_read",
    label: "Read Skill",
    description: "Read an enabled Skill instruction or reference file through the desktop Host. Scripts are not executable.",
    promptSnippet: "Use skill_read with a filePath shown by an available Skill to load its instructions on demand.",
    parameters: Type.Object({ filePath: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_toolCallId, input, signal) {
      return asToolResult(await hostCall("tool.invoke", { sessionId, toolName: "skill_read", input }, signal));
    },
  });
}
