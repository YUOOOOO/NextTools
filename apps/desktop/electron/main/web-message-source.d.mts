export function markWebPrompt<T extends object>(request: T): T;
export function consumeWebPromptSource(request: unknown): "web" | undefined;
