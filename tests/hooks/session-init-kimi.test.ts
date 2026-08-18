// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../src/cli/handlers/session-init.js';

/**
 * Kimi context delivery (2026-07-29): Kimi's CLI discards SessionStart hook
 * results, so the memory block must ride the first UserPromptSubmit of a
 * session (contextInjected === false) as plain-text additionalContext.
 */

const CTX = '# [proj] recent context\n\n- stuff';

function makeDeps(over: {
  promptNumber: number;
  calls: Array<{ url: string; method: string }>;
}) {
  return {
    executeWithWorkerFallback: async (url: string, method: string) => {
      over.calls.push({ url, method });
      if (url === '/api/sessions/init') {
        return { sessionDbId: 1, promptNumber: over.promptNumber, contextInjected: false };
      }
      if (url.startsWith('/api/context/inject')) return CTX;
      throw new Error(`unexpected call: ${url}`);
    },
    isWorkerFallback: (value: unknown) =>
      typeof value === 'object' && value !== null && 'reason' in value && (value as any).reason === 'worker_unreachable',
    loadFromFileOnce: () => ({}) as any,
    resolveRuntimeContext: () => ({ runtime: 'worker' as const }),
    logServerFallback: () => {},
    shouldTrackProject: () => true,
  };
}

describe('session-init — Kimi first-prompt context delivery', () => {
  beforeEach(() => {
    setSessionInitDependenciesForTesting();
  });
  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  const input = {
    sessionId: 'kimi-sess-1',
    cwd: '/tmp',
    platform: 'kimi',
    prompt: 'привет, что делали?',
  };

  it('delivers the context block on the first prompt (promptNumber=1)', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    setSessionInitDependenciesForTesting(makeDeps({ promptNumber: 1, calls }));

    const result = await sessionInitHandler.execute(input as any);

    expect(calls.some(c => c.url.startsWith('/api/context/inject'))).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toBe(`<claude-mem-context>\n${CTX}\n</claude-mem-context>`);
  });

  it('skips delivery on later prompts — even when contextInjected=false (observer dies on idle)', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    setSessionInitDependenciesForTesting(makeDeps({ promptNumber: 5, calls }));

    const result = await sessionInitHandler.execute(input as any);

    expect(calls.some(c => c.url.startsWith('/api/context/inject'))).toBe(false);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('does not deliver for other platforms', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    setSessionInitDependenciesForTesting(makeDeps({ promptNumber: 1, calls }));

    const result = await sessionInitHandler.execute({ ...input, platform: 'claude-code' } as any);

    expect(calls.some(c => c.url.startsWith('/api/context/inject'))).toBe(false);
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
