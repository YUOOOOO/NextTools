import { describe, expect, it } from 'vitest';

import { NEXTTOOLS_TOOL_CALL_TIMEOUT_MS } from './tool-call-policy';

describe('NEXTTOOLS_TOOL_CALL_TIMEOUT_MS', () => {
  it('allows NextTools-owned tools to run for five minutes', () => {
    expect(NEXTTOOLS_TOOL_CALL_TIMEOUT_MS).toBe(300_000);
  });
});
