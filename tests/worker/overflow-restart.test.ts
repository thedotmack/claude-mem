import { describe, it, expect, beforeEach } from 'bun:test';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';

/**
 * Observer context overflow (#2956): when a Claude SDK generator's live
 * conversation fills up, ResponseProcessor aborts it with
 * abortReason='overflow:observer_text' and keeps the claimed batch in the
 * session buffer. The generator exit must then start a fresh generator right
 * away while work is still buffered — an ingest-driven restart may never come
 * (the wall is usually hit during a long burst of reads, after which ingest
 * stops and ensureGeneratorRunning is never called again).
 */

function makeSession(): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: 'content-42',
    memorySessionId: null,
    project: 'project',
    platformSource: 'claude',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
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

interface Harness {
  routes: SessionRoutes;
  session: ActiveSession;
  counters: { starts: number; finalizes: number; removes: number };
  setPending: (n: number) => void;
}

function makeHarness(onStart: (session: ActiveSession, startNo: number) => Promise<void>): Harness {
  const session = makeSession();
  let activeSession: ActiveSession | undefined = session;
  let pending = 1;
  const counters = { starts: 0, finalizes: 0, removes: 0 };

  const sessionManager = {
    getSession: () => activeSession,
    getMessageBuffer: () => ({
      getPendingCount: () => pending,
      peekTypes: () => [],
    }),
    removeSessionImmediate: () => {
      counters.removes += 1;
      activeSession = undefined;
    },
  };

  const claudeProvider = {
    startSession: async (s: ActiveSession) => {
      counters.starts += 1;
      await onStart(s, counters.starts);
    },
  };

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    claudeProvider as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    {
      finalizeSession: async () => {
        counters.finalizes += 1;
      },
    } as any,
  );

  return { routes, session, counters, setPending: (n: number) => { pending = n; } };
}

async function settle(session: ActiveSession): Promise<void> {
  // Drain generator promises until no generator is live: the first promise's
  // .finally may install a replacement generator.
  for (let i = 0; i < 5 && session.generatorPromise; i++) {
    await session.generatorPromise;
  }
}

describe('observer overflow → fresh-context generator restart (#2956)', () => {
  beforeEach(() => {
    resetDependencyStatusesForTesting();
  });

  it('restarts the generator once after an overflow abort while work is still buffered', async () => {
    const h = makeHarness(async (s, startNo) => {
      if (startNo === 1) {
        // What ResponseProcessor does on 'Prompt is too long': preserve the
        // batch (buffer still has 1), abort with the overflow reason.
        s.abortReason = 'overflow:observer_text';
        s.abortController.abort();
        return;
      }
      // The replacement generator drains the preserved batch and exits idle.
      h.setPending(0);
    });

    await h.routes.ensureGeneratorRunning(h.session.sessionDbId, 'observation');
    await settle(h.session);

    expect(h.counters.starts).toBe(2);
    // Only the second, normal exit finalizes the session.
    expect(h.counters.finalizes).toBe(1);
    expect(h.counters.removes).toBe(1);
    expect(h.session.generatorPromise).toBeNull();
  });

  it('does not restart when the overflow exit leaves nothing buffered, and keeps the session alive', async () => {
    const h = makeHarness(async (s) => {
      h.setPending(0);
      s.abortReason = 'overflow:observer_text';
      s.abortController.abort();
    });

    await h.routes.ensureGeneratorRunning(h.session.sessionDbId, 'observation');
    await settle(h.session);

    expect(h.counters.starts).toBe(1);
    expect(h.counters.finalizes).toBe(0);
    expect(h.counters.removes).toBe(0);
    expect(h.session.generatorPromise).toBeNull();
  });

  it('bounds the restart chain: a replacement that overflows again on an empty buffer stops', async () => {
    const h = makeHarness(async (s, startNo) => {
      if (startNo === 1) {
        s.abortReason = 'overflow:observer_text';
        s.abortController.abort();
        return;
      }
      // Second generator: ResponseProcessor dropped the batch (buffer now 0)
      // and aborted again — no further restart must follow.
      h.setPending(0);
      s.abortReason = 'overflow:observer_text';
      s.abortController.abort();
    });

    await h.routes.ensureGeneratorRunning(h.session.sessionDbId, 'observation');
    await settle(h.session);

    expect(h.counters.starts).toBe(2);
    expect(h.counters.finalizes).toBe(0);
    expect(h.counters.removes).toBe(0);
  });
});
