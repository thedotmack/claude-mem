import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import { recordObserverSuccess } from '../../src/shared/observer-health.js';
import {
  activateFallback,
  clearFallback,
  isFallbackActive,
  PRO_FALLBACK_PROBE_INTERVAL_MS,
} from '../../src/shared/pro-fallback.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

/**
 * Generator-level pro-fallback behavior (data-loss review findings):
 *
 *  1. A definitive CMEM Pro gateway stop (allowance_exhausted /
 *     subscription_inactive) must route the generator exit through the
 *     quota/auth preservation branch — session and buffered batch retained —
 *     so the next generator start serves the batch on the fallback provider.
 *  2. With the marker active and no usable fallback (CLAUDE_MEM_FALLBACK_PROVIDER
 *     'none'), ensureGeneratorRunning must hold queued work instead of
 *     re-dispatching to the exhausted gateway, probing at most once per
 *     PRO_FALLBACK_PROBE_INTERVAL_MS.
 *
 * Uses the default marker path (pinned to a temp dir by tests/preload.ts via
 * CLAUDE_MEM_DATA_DIR) and env-var settings overrides, both cleaned up per test.
 */

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_FALLBACK_PROVIDER',
] as const;
const savedEnv: Record<string, string | undefined> = {};
const realDateNow = Date.now;

function makeSession(): ActiveSession {
  return {
    sessionDbId: 77,
    contentSessionId: 'content-77',
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
    lastGeneratorActivity: Date.now(),
  };
}

interface Harness {
  routes: SessionRoutes;
  session: ActiveSession;
  counters: {
    openRouterStarts: number;
    claudeStarts: number;
    geminiStarts: number;
    finalizerCalls: number;
    removeSessionImmediateCalls: number;
  };
}

function makeHarness(openRouterStartSession: () => Promise<void>): Harness {
  const session = makeSession();
  const counters = {
    openRouterStarts: 0,
    claudeStarts: 0,
    geminiStarts: 0,
    finalizerCalls: 0,
    removeSessionImmediateCalls: 0,
  };
  let activeSession: ActiveSession | undefined = session;

  const sessionManager = {
    getSession: () => activeSession,
    getMessageBuffer: () => ({
      getPendingCount: () => 1,
      peekTypes: () => [],
    }),
    removeSessionImmediate: () => {
      counters.removeSessionImmediateCalls += 1;
      activeSession = undefined;
    },
  };

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession: async () => { counters.claudeStarts += 1; } } as any,
    { startSession: async () => { counters.geminiStarts += 1; } } as any,
    {
      startSession: async () => {
        counters.openRouterStarts += 1;
        await openRouterStartSession();
      },
    } as any,
    {} as any,
    {} as any,
    {
      finalizeSession: async () => {
        counters.finalizerCalls += 1;
      },
    } as any,
  );

  return { routes, session, counters };
}

function definitiveProStop(): never {
  // Mirror OpenRouterProvider: maybeActivateProFallback persists the marker
  // before the classified error is rethrown through the generator.
  activateFallback('allowance_exhausted');
  throw new ClassifiedProviderError('OpenRouter error allowance_exhausted (status 402)', {
    kind: 'quota_exhausted',
    cause: new Error('402'),
    code: 'allowance_exhausted',
  });
}

describe('pro-fallback generator gate', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'test-key';
    resetDependencyStatusesForTesting();
    clearFallback();
    Date.now = realDateNow;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key]!;
    }
    clearFallback();
    recordObserverSuccess();
    Date.now = realDateNow;
  });

  it('preserves the session and batch on a definitive Pro stop, then serves on the fallback provider', async () => {
    process.env.CLAUDE_MEM_FALLBACK_PROVIDER = 'claude';
    const { routes, session, counters } = makeHarness(async () => definitiveProStop());

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;

    expect(counters.openRouterStarts).toBe(1);
    expect(isFallbackActive()).toBe(true);
    // Preserved, not finalized: the claimed batch stays in the live buffer.
    expect(counters.finalizerCalls).toBe(0);
    expect(counters.removeSessionImmediateCalls).toBe(0);
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();

    // Next start resolves to the fallback provider via the marker — the
    // preserved batch is served there (lossless switch).
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;

    expect(counters.claudeStarts).toBe(1);
    expect(counters.openRouterStarts).toBe(1);
  });

  it('preserves the batch on a definitive Pro stop even when the marker write failed', async () => {
    process.env.CLAUDE_MEM_FALLBACK_PROVIDER = 'claude';
    const { routes, session, counters } = makeHarness(async () => {
      // Marker persistence is fail-soft: simulate a failed write by throwing
      // the definitive classified error WITHOUT activating the marker.
      throw new ClassifiedProviderError('OpenRouter error allowance_exhausted (status 402)', {
        kind: 'quota_exhausted',
        cause: new Error('402'),
        code: 'allowance_exhausted',
      });
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;

    expect(isFallbackActive()).toBe(false);
    // Preservation keys off the classified code, not the marker state.
    expect(counters.finalizerCalls).toBe(0);
    expect(counters.removeSessionImmediateCalls).toBe(0);
  });

  it('keeps the pre-existing finalize path for a quota failure that is not a definitive Pro stop', async () => {
    process.env.CLAUDE_MEM_FALLBACK_PROVIDER = 'claude';
    const { routes, session, counters } = makeHarness(async () => {
      // No marker: e.g. openrouter.ai credits exhausted on a non-Pro base URL.
      throw new ClassifiedProviderError('OpenRouter quota exhausted (status 402)', {
        kind: 'quota_exhausted',
        cause: new Error('402'),
      });
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;

    expect(counters.openRouterStarts).toBe(1);
    expect(counters.finalizerCalls).toBe(1);
    expect(counters.removeSessionImmediateCalls).toBe(1);
  });

  it("fallback 'none': holds queued work instead of re-dispatching, probing once per interval", async () => {
    process.env.CLAUDE_MEM_FALLBACK_PROVIDER = 'none';
    const { routes, session, counters } = makeHarness(async () => definitiveProStop());

    // First failure activates the marker and is preserved, not finalized.
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    expect(counters.openRouterStarts).toBe(1);
    expect(counters.finalizerCalls).toBe(0);
    expect(counters.removeSessionImmediateCalls).toBe(0);

    // Marker fresh + no usable fallback: dispatch is held, buffer retained.
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    expect(counters.openRouterStarts).toBe(1);
    expect(session.generatorPromise).toBeNull();

    // After the probe interval one probe goes through; the definitive failure
    // re-arms the marker (activateFallback stamps the shimmed Date.now).
    Date.now = () => realDateNow() + PRO_FALLBACK_PROBE_INTERVAL_MS + 1;
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    expect(counters.openRouterStarts).toBe(2);
    expect(counters.finalizerCalls).toBe(0);
    expect(counters.removeSessionImmediateCalls).toBe(0);

    // Re-armed: held again until the next interval elapses.
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    expect(counters.openRouterStarts).toBe(2);
  });
});
