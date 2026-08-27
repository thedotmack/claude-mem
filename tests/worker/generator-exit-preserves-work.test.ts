import { describe, it, expect, mock } from 'bun:test';

import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';

/**
 * #3752, second half.
 *
 * Resetting the claimed batch back to pending only survives if the generator
 * exit that follows does NOT finalize the session — finalizeSession removes it
 * and the preservation is undone. `quota` and `auth` were already on that list;
 * `transport` had to join them, and nothing else in the codebase would have
 * caught its absence.
 */
function buildSession(abortReason: string): ActiveSession {
  return {
    sessionDbId: 7,
    abortReason,
    abortController: new AbortController(),
    generatorPromise: Promise.resolve(),
    currentProvider: 'claude',
  } as unknown as ActiveSession;
}

function buildDeps() {
  const finalizeSession = mock(() => Promise.resolve());
  const removeSessionImmediate = mock(() => {});
  const sessionManager = {
    getMessageBuffer: () => ({ getPendingCount: () => 3 }),
    removeSessionImmediate,
  } as unknown as SessionManager;
  const completionHandler = { finalizeSession } as unknown as SessionCompletionHandler;
  return { deps: { sessionManager, completionHandler }, finalizeSession, removeSessionImmediate };
}

describe('handleGeneratorExit — reasons that preserve claimed work', () => {
  for (const reason of ['transport:observer_text', 'quota:observer_text', 'auth:observer_text']) {
    it(`leaves the session alive for ${reason}`, async () => {
      const { deps, finalizeSession, removeSessionImmediate } = buildDeps();

      await handleGeneratorExit(buildSession(reason), reason, deps);

      expect(finalizeSession).not.toHaveBeenCalled();
      expect(removeSessionImmediate).not.toHaveBeenCalled();
    });
  }

  it('still finalizes on an ordinary idle exit', async () => {
    const { deps, finalizeSession, removeSessionImmediate } = buildDeps();

    await handleGeneratorExit(buildSession('idle'), 'idle', deps);

    expect(finalizeSession).toHaveBeenCalledWith(7);
    expect(removeSessionImmediate).toHaveBeenCalledWith(7);
  });
});
