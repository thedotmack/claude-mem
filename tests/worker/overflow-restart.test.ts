import { describe, it, expect, mock, spyOn } from 'bun:test';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

function makeSession(): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: 'content-42',
    memorySessionId: 'memory-42',
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
    consecutiveContextOverflows: 1,
    overflowRetryPending: true,
    lastGeneratorActivity: Date.now(),
  };
}

function makeRoutes(sessionManager: unknown, openRouterAgent: unknown): SessionRoutes {
  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    {} as any,
    {} as any,
    openRouterAgent as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => {} } as any,
  );

  (routes as any).getSelectedProvider = () => 'openrouter';
  (routes as any).applyTierRouting = async () => {};
  return routes;
}

describe('overflow generator restart', () => {
  it('starts exactly one fresh observer generator after overflow cleanup when work remains', async () => {
    const session = makeSession();
    let firstResolve: (() => void) | null = null;
    const firstRun = new Promise<void>(resolve => {
      firstResolve = resolve;
    });
    let secondResolve: (() => void) | null = null;
    const secondRun = new Promise<void>(resolve => {
      secondResolve = resolve;
    });
    let activeSession: ActiveSession | undefined = session;
    let starts = 0;
    const openRouterAgent = {
      startSession: async (active: ActiveSession) => {
        starts++;
        if (starts === 1) {
          active.abortReason = 'overflow:observer_text';
          active.abortController.abort();
          await firstRun;
          return;
        }
        await secondRun;
      },
    };
    const sessionManager = {
      getSession: () => activeSession,
      getMessageBuffer: () => ({
        getPendingCount: () => activeSession ? 1 : 0,
        peekTypes: () => [],
      }),
      removeSessionImmediate: mock(() => {
        activeSession = undefined;
      }),
    };
    const routes = makeRoutes(sessionManager, openRouterAgent);
    const ensureSpy = spyOn(routes, 'ensureGeneratorRunning');

    await routes.ensureGeneratorRunning(42, 'init');
    const firstPromise = session.generatorPromise;
    expect(firstPromise).not.toBeNull();
    firstResolve?.();
    await firstPromise;

    expect(starts).toBe(2);
    expect(ensureSpy.mock.calls.filter(([, source]) => source === 'observation')).toHaveLength(1);
    expect(activeSession).toBe(session);

    const secondPromise = session.generatorPromise;
    expect(secondPromise).not.toBeNull();
    secondResolve?.();
    await secondPromise;
    expect(activeSession).toBeUndefined();
  });

  it('does not restart after overflow cleanup when the buffer is empty or the session is gone', async () => {
    const session = makeSession();
    let activeSession: ActiveSession | undefined = session;
    let pendingCount = 0;
    const sessionManager = {
      getSession: () => activeSession,
      getMessageBuffer: () => ({ getPendingCount: () => pendingCount }),
    };
    const routes = makeRoutes(sessionManager, { startSession: async () => {} });
    const ensureSpy = spyOn(routes, 'ensureGeneratorRunning').mockImplementation(async () => {});

    await (routes as any).restartAfterOverflow(42);
    expect(ensureSpy).not.toHaveBeenCalled();

    pendingCount = 1;
    session.overflowRetryPending = false;
    await (routes as any).restartAfterOverflow(42);
    expect(ensureSpy).not.toHaveBeenCalled();

    session.overflowRetryPending = true;
    session.abortReason = 'shutdown';
    await (routes as any).restartAfterOverflow(42);
    expect(ensureSpy).not.toHaveBeenCalled();

    activeSession = undefined;
    await (routes as any).restartAfterOverflow(42);
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('does not enter the overflow restart path for quota, auth, idle, or shutdown exits', async () => {
    for (const reason of ['quota:observer_text', 'auth:observer_text', 'idle', 'shutdown']) {
      const session = makeSession();
      let runResolve: (() => void) | null = null;
      const run = new Promise<void>(resolve => {
        runResolve = resolve;
      });
      let activeSession: ActiveSession | undefined = session;
      const openRouterAgent = {
        startSession: async (active: ActiveSession) => {
          active.abortReason = reason;
          active.abortController.abort();
          await run;
        },
      };
      const sessionManager = {
        getSession: () => activeSession,
        getMessageBuffer: () => ({
          getPendingCount: () => 1,
          peekTypes: () => [],
        }),
        removeSessionImmediate: () => {
          activeSession = undefined;
        },
      };
      const routes = makeRoutes(sessionManager, openRouterAgent);
      const restartSpy = spyOn(routes as any, 'restartAfterOverflow');

      await routes.ensureGeneratorRunning(42, 'init');
      const generatorPromise = session.generatorPromise;
      expect(generatorPromise).not.toBeNull();
      runResolve?.();
      await generatorPromise;

      expect(restartSpy).not.toHaveBeenCalled();
    }
  });

  it('reserves a generator start while tier routing is still awaiting', async () => {
    const session = makeSession();
    let tierResolve: (() => void) | null = null;
    const tierRouting = new Promise<void>(resolve => {
      tierResolve = resolve;
    });
    let runResolve: (() => void) | null = null;
    const run = new Promise<void>(resolve => {
      runResolve = resolve;
    });
    let starts = 0;
    const openRouterAgent = {
      startSession: async () => {
        starts++;
        await run;
      },
    };
    const sessionManager = {
      getSession: () => session,
      getMessageBuffer: () => ({ getPendingCount: () => 1 }),
      removeSessionImmediate: () => {},
    };
    const routes = makeRoutes(sessionManager, openRouterAgent);
    (routes as any).applyTierRouting = () => tierRouting;

    const firstStart = routes.ensureGeneratorRunning(42, 'init');
    await Promise.resolve();
    const secondStart = routes.ensureGeneratorRunning(42, 'observation');

    expect(starts).toBe(0);
    expect(session.generatorPromise).not.toBeNull();

    tierResolve?.();
    await Promise.all([firstStart, secondStart]);
    expect(starts).toBe(1);

    const generatorPromise = session.generatorPromise;
    runResolve?.();
    await generatorPromise;
  });
});
