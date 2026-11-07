import { afterEach, describe, expect, it } from 'bun:test';
import {
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';
import type { SettingsDefaults } from '../../../src/shared/SettingsDefaultsManager.js';

const OUTAGE_NOTICE = 'claude-mem worker unreachable for 3 consecutive hooks — memory features are degraded, but your prompts are not blocked.';

/** Worker down: every worker call falls back, and the notice store answers with `pendingNotice`. */
function useUnreachableWorker(pendingNotice: string | null): Array<string | undefined> {
  const noticeRequests: Array<string | undefined> = [];
  setSessionInitDependenciesForTesting({
    loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }) as unknown as SettingsDefaults,
    resolveRuntimeContext: () => ({ runtime: 'worker' }),
    shouldTrackProject: () => true,
    executeWithWorkerFallback: async () => ({ continue: true, reason: 'worker_unreachable' }) as never,
    isWorkerFallback: () => true,
    consumeWorkerOutageNotice: async (sessionId) => {
      noticeRequests.push(sessionId);
      return pendingNotice;
    },
  });
  return noticeRequests;
}

async function submitPrompt() {
  return sessionInitHandler.execute({
    sessionId: 'session-outage',
    cwd: '/tmp/session-init-worker-outage',
    platform: 'claude-code',
    prompt: 'a prompt that must never be blocked',
  });
}

describe('sessionInitHandler during a worker outage (plan-17 step 2)', () => {
  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  it('lets the prompt through and shows the pending outage notice as systemMessage', async () => {
    const noticeRequests = useUnreachableWorker(OUTAGE_NOTICE);

    const result = await submitPrompt();

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.systemMessage).toBe(OUTAGE_NOTICE);
    expect(noticeRequests).toEqual(['session-outage']);
  });

  it('lets the prompt through silently when no notice is pending', async () => {
    useUnreachableWorker(null);

    const result = await submitPrompt();

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.systemMessage).toBeUndefined();
  });
});
