import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { logger } from '../../../../src/utils/logger.js';

/**
 * #3454: `/api/sessions/init` used to start a generator with nothing queued,
 * which bought one INIT turn per user prompt — including prompts that never use
 * a tool — and could take the single cmem-gateway re-probe on the way in. The
 * start gate now runs first in ensureGeneratorRunningLocked, before provider
 * selection, so an empty queue never selects a provider (and so never claims a
 * gateway or quota probe) and never sends a request.
 *
 * Provider selection is observed through the same mock.module seam as
 * session-routes-provider-switch.test.ts; the real module is re-installed in
 * afterAll because bun's mock.module is process-global.
 */
import * as realProviderDispatch from '../../../../src/services/worker/provider-dispatch.js';
const realProviderDispatchSnapshot = { ...realProviderDispatch };

let providerSelections = 0;
mock.module('../../../../src/services/worker/provider-dispatch.js', () => ({
  ...realProviderDispatchSnapshot,
  selectProviderForGenerator: () => {
    providerSelections += 1;
    return { provider: 'openrouter', gatewayProbeClaimId: null };
  },
  getSelectedProvider: () => 'openrouter',
}));

import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

// This file drives admitAndStartGenerator for real once work is queued, which
// claims and releases the real quota probe.
guardSharedQuotaCooldownSingleton('session-routes-empty-queue-gate.test.ts');

afterAll(() => {
  mock.module('../../../../src/services/worker/provider-dispatch.js', () => realProviderDispatchSnapshot);
});

function makeSession(): ActiveSession {
  return {
    sessionDbId: 3454,
    contentSessionId: 'content-3454',
    memorySessionId: null,
    project: 'test-project',
    platformSource: 'claude-code',
    userPrompt: 'a prompt that may never use a tool',
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

function makeHarness() {
  const session = makeSession();
  let pendingCount = 0;
  const openRouterStartSession = mock(async () => {});
  const sessionManager = {
    getSession: mock((id: number) => (id === session.sessionDbId ? session : undefined)),
    getMessageBuffer: mock(() => ({
      getPendingCount: () => pendingCount,
      peekTypes: () => [] as Array<{ message_type: string }>,
    })),
    removeSessionImmediate: mock(() => {}),
  };
  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession: mock(async () => {}) } as any,
    { startSession: mock(async () => {}) } as any,
    { startSession: openRouterStartSession } as any,
    {} as any,
    {} as any,
    { finalizeSession: mock(() => Promise.resolve()) } as any,
  );
  return {
    session,
    routes,
    openRouterStartSession,
    enqueue: () => { pendingCount += 1; },
  };
}

describe('SessionRoutes.ensureGeneratorRunning — empty-queue start gate (#3454)', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    providerSelections = 0;
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  it('an /init with nothing queued selects no provider and sends nothing', async () => {
    const harness = makeHarness();

    await harness.routes.ensureGeneratorRunning(harness.session.sessionDbId, 'init');

    // No selection means no gateway re-probe or quota probe could be claimed.
    expect(providerSelections).toBe(0);
    expect(harness.openRouterStartSession).not.toHaveBeenCalled();
    expect(harness.session.generatorPromise).toBeNull();
  });

  it('the first queued observation starts the generator', async () => {
    const harness = makeHarness();
    await harness.routes.ensureGeneratorRunning(harness.session.sessionDbId, 'init');

    harness.enqueue();
    await harness.routes.ensureGeneratorRunning(harness.session.sessionDbId, 'observation');
    await harness.session.generatorPromise;

    expect(providerSelections).toBe(1);
    expect(harness.openRouterStartSession).toHaveBeenCalledTimes(1);
  });

  for (const source of ['overflow-recycle', 'response-stall', 'transport-resume']) {
    it(`a ${source} resume with nothing buffered starts nothing`, async () => {
      const harness = makeHarness();

      await harness.routes.ensureGeneratorRunning(harness.session.sessionDbId, source);

      expect(providerSelections).toBe(0);
      expect(harness.openRouterStartSession).not.toHaveBeenCalled();
    });
  }
});
