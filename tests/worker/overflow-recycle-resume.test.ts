import { describe, it, expect, beforeEach } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

function makeSession(): ActiveSession {
  return {
    sessionDbId: 77,
    contentSessionId: 'content-77',
    memorySessionId: 'memory-77',
    project: 'project',
    platformSource: 'claude',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 3,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

/** Let the deferred resume timer (setTimeout 0) run. */
function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5));
}

function buildRoutes(session: ActiveSession, startSession: () => Promise<void>) {
  let finalizeCalls = 0;
  let removed = 0;
  let active: ActiveSession | undefined = session;

  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => {
      removed += 1;
      active = undefined;
    },
  };

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => { finalizeCalls += 1; } } as any,
  );

  return { routes, stats: () => ({ finalizeCalls, removed, active }) };
}

describe('observer resumes itself after recycling its conversation (#3800)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
  });

  it('starts a replacement generation without waiting for another captured tool call', async () => {
    // The failure this guards: recycling resets the claimed batch to pending and
    // aborts, but the documented restart path needs a LATER ingest. On the last
    // observation of a session no later ingest arrives, so that work would sit
    // in the pending buffer forever and never be recorded.
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        session.abortReason = 'overflow:recycle';
        return;
      }
      // The replacement generation stays alive.
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(2);
  });

  it('does not resume once the recycle budget is exhausted', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'overflow:exhausted';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    // Exactly one start: giving up must stay given up, or the pause is not a pause.
    expect(starts).toBe(1);
  });

  it('does not resume on a quota pause — that one waits for the user', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'quota:weekly';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
  });

  it('does not resume on an auth pause', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes } = buildRoutes(session, async () => {
      starts += 1;
      session.abortReason = 'auth:observer_text';
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(starts).toBe(1);
  });

  it('preserves the session across a recycle instead of finalizing it', async () => {
    const session = makeSession();
    let starts = 0;

    const { routes, stats } = buildRoutes(session, async () => {
      starts += 1;
      if (starts === 1) {
        session.abortReason = 'overflow:recycle';
        return;
      }
      await new Promise<void>(() => {});
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    // Finalizing would drop the batch the recycle just reset to pending.
    expect(stats().finalizeCalls).toBe(0);
    expect(stats().removed).toBe(0);
    expect(stats().active).toBe(session);
  });
});
