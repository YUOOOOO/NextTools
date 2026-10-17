import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

let encoded = '';
for await (const chunk of process.stdin) {
  encoded += chunk;
  if (encoded.length > 250_000) process.exit(1);
}
const input = JSON.parse(encoded);
if (typeof input.apiKey !== 'string' || input.apiKey.length < 1 || input.apiKey.length > 4096
  || typeof input.prompt !== 'string' || input.prompt.length < 1 || input.prompt.length > 200_000
  || typeof input.model !== 'string' || !/^claude-[a-zA-Z0-9._-]{1,100}$/.test(input.model)
  || (input.resume !== undefined && typeof input.resume !== 'string')) process.exit(1);
await mkdir('/workspace/work', { recursive: true });
await mkdir('/workspace/.home', { recursive: true });
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
let apiKey = input.apiKey;
input.apiKey = '';
const apiProxy = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2_000_000) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk);
  }
  try {
    const upstream = await fetch(`https://api.anthropic.com${request.url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': request.headers['anthropic-version'] ?? '2023-06-01',
        ...(typeof request.headers['anthropic-beta'] === 'string' ? { 'anthropic-beta': request.headers['anthropic-beta'] } : {}),
      },
      body: Buffer.concat(chunks),
    });
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    });
    if (!upstream.body) response.end();
    else for await (const chunk of upstream.body) response.write(chunk);
    response.end();
  } catch {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  }
});
await new Promise((resolve, reject) => {
  apiProxy.once('error', reject);
  apiProxy.listen(0, '127.0.0.1', resolve);
});
const address = apiProxy.address();
if (!address || typeof address === 'string') process.exit(1);
let successful = false;
try {
  const session = query({ prompt: input.prompt, options: {
    cwd: '/workspace/work', model: input.model, resume: input.resume,
    settingSources: [], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    maxTurns: 40,
    systemPrompt: { type: 'preset', preset: 'claude_code', append:
      'You are Nexo, the account owner’s cloud assistant. Your persistent files are in /workspace/work. Work only on this account’s tasks. Explain errors honestly. Never claim access to the user’s desktop or other accounts.' },
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/workspace/.home', LANG: 'C.UTF-8',
      ANTHROPIC_API_KEY: 'nexo-local-proxy', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  } });
  for await (const message of session) {
    if (message.type === 'system' && message.subtype === 'init') emit({ type: 'session', sessionId: message.session_id });
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') emit({ type: 'assistant', text: block.text });
        if (block.type === 'tool_use') emit({ type: 'tool', name: block.name });
      }
    }
    if (message.type === 'result') {
      successful = message.subtype === 'success' && !message.is_error;
      emit({ type: 'result', sessionId: message.session_id, success: successful });
    }
  }
} catch {
  emit({ type: 'result', success: false });
} finally {
  apiKey = '';
  await new Promise(resolve => apiProxy.close(resolve));
}
if (!successful) process.exitCode = 1;
