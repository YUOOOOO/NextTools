/**
 * Hard wall-clock budget for tool calls whose execution lifetime is owned by
 * NextTools. Runtime-native tool configurations keep their own timeout
 * authority until they explicitly adopt this policy.
 */
export const NEXTTOOLS_TOOL_CALL_TIMEOUT_MS = 300_000;
