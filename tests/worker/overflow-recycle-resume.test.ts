import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
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

  // #2756 round-3 review finding (important) — this file drives
  // SessionRoutes.ensureGeneratorRunning() for real, which runs the real
  // (unmocked) generator-exit handling; the "does not resume on a quota
  // pause" test below legitimately arms the real, module-level
  // quota-cooldown singleton as a side effect of that exit path, and (like
  // every other test here) relies on the NEXT test's own `beforeEach`
  // rather than cleaning up immediately — verified: adding
  // guardSharedQuotaCooldownSingleton's per-test before/after assertion to
  // this file (tried and reverted) false-positives on exactly that
  // legitimate, by-design behavior. Without this `afterAll`, a leftover
  // armed cooldown would still be sitting there for whichever OTHER file
  // runs next in the same `bun test` process — this file shares that
  // singleton with tests/worker/quota-cooldown.test.ts (which already
  // carries this same afterAll) and
  // tests/worker/http/routes/session-routes-provider-switch.test.ts (guarded
  // via tests/shared/quota-cooldown-singleton-guard.ts). Matches the
  // existing precedent in quota-cooldown.test.ts rather than a per-test
  // guard, since only file-boundary cleanup is safe here.
  afterAll(() => {
    resetQuotaCooldownsForTesting();
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
