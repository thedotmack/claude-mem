import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getEventHandler } from '../../../src/cli/handlers/index.js';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

const ORIGINAL_PORT = process.env.CLAUDE_MEM_WORKER_PORT;
const CLOSED_PORT = '65432';

describe('sessionInitContextHandler composite', () => {
  beforeAll(() => {
    process.env.CLAUDE_MEM_WORKER_PORT = CLOSED_PORT;
  });

  afterAll(() => {
    if (ORIGINAL_PORT === undefined) {
      delete process.env.CLAUDE_MEM_WORKER_PORT;
    } else {
      process.env.CLAUDE_MEM_WORKER_PORT = ORIGINAL_PORT;
    }
  });

  it('resolves against an unreachable worker and returns hookSpecificOutput', async () => {
    const handler = getEventHandler('session-init-context');
    const input: NormalizedHookInput = {
      sessionId: 't',
      cwd: process.cwd(),
      platform: 'kimi',
    };

    const result = await handler.execute(input);

    expect(result).toBeDefined();
    expect(result.hookSpecificOutput).toBeDefined();
    expect(typeof result.hookSpecificOutput).toBe('object');
  });
});
