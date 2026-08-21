import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { getEventHandler } from '../../../src/cli/handlers/index.js';
import { sessionInitHandler } from '../../../src/cli/handlers/session-init.js';
import { contextHandler } from '../../../src/cli/handlers/context.js';
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

  it('prepends session-init semantic additionalContext to context output', async () => {
    const handler = getEventHandler('session-init-context');
    const input: NormalizedHookInput = {
      sessionId: 't',
      cwd: process.cwd(),
      platform: 'kimi',
    };

    const sessionInitSpy = spyOn(sessionInitHandler, 'execute').mockImplementation(async () => ({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'semantic context from session-init',
      },
    }));
    const contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'timeline context from context handler',
      },
    }));

    try {
      const result = await handler.execute(input);

      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput!.additionalContext).toBe(
        'semantic context from session-init\n\ntimeline context from context handler'
      );
      expect(result.hookSpecificOutput!.hookEventName).toBe('SessionStart');
    } finally {
      sessionInitSpy.mockRestore();
      contextSpy.mockRestore();
    }
  });
});
