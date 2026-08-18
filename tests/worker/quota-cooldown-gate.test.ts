import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Isolate the observer-health ledger the failure path writes (recordObserverFailure).
process.env.CLAUDE_MEM_DATA_DIR = '/tmp/claude-mem-quota-cooldown-test';

import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import {
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  getQuotaCooldown,
  isQuotaCooldownActive,
  recordQuotaExhausted,
  clearQuotaCooldownIfCurrent,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

function makeSession(sessionDbId = 42): ActiveSession {
  return {
    sessionDbId,
    contentSessionId: `content-${sessionDbId}`,
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

describe('quota-cooldown breaker', () => {
  const realDateNow = Date.now;

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    Date.now = realDateNow;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it('is active immediately after arming and expires after the cooldown', () => {
    const state = recordQuotaExhausted('openrouter', "You've used your allowance");
    expect(getQuotaCooldown('openrouter')).toBe(state);
    expect(isQuotaCooldownActive(state, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS)).toBe(true);

    Date.now = () => realDateNow() + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    expect(isQuotaCooldownActive(state, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS)).toBe(false);
  });

  it('is keyed per provider', () => {
    recordQuotaExhausted('openrouter', 'capped');
    expect(getQuotaCooldown('openrouter')).not.toBeNull();
    expect(getQuotaCooldown('gemini')).toBeNull();
  });

  it('clears only the matching cooldown generation (a stale success cannot wipe a newer one)', () => {
    const stale = recordQuotaExhausted('openrouter', 'first cap');
    const fresh = recordQuotaExhausted('openrouter', 'second cap');
    expect(fresh.generation).toBeGreaterThan(stale.generation);

    // A success owned by the older generation must not clear the newer cooldown.
    clearQuotaCooldownIfCurrent('openrouter', stale.generation);
    expect(getQuotaCooldown('openrouter')).not.toBeNull();

    // The owning generation clears it.
    clearQuotaCooldownIfCurrent('openrouter', fresh.generation);
    expect(getQuotaCooldown('openrouter')).toBeNull();
  });
});

describe('quota-cooldown generator gate', () => {
  const realDateNow = Date.now;

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    // A leaked claude_cli setup-required status (e.g. from claude-setup-gate)
    // would trip the Claude gate and skip the start before the quota path runs.
    resetDependencyStatusesForTesting();
    Date.now = realDateNow;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  function makeRoutes(session: ActiveSession, provider: { startSession: () => Promise<void> }) {
    const sessionManager = {
      getSession: () => session,
      getMessageBuffer: () => ({
        getPendingCount: () => 1,
        peekTypes: () => [],
      }),
      removeSessionImmediate: () => {},
    };
    const routes = new SessionRoutes(
      sessionManager as any,
      {} as any,
      provider as any,           // claude generator
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      {} as any,
      {} as any,
      { finalizeSession: async () => {} } as any,
    );
    // Pin the selected provider so the test does not depend on env-driven
    // provider selection leaking in from other test files.
    (routes as any).getSelectedProvider = () => 'claude';
    return routes;
  }

  it('skips the generator start while the selected provider is in quota cooldown', async () => {
    const session = makeSession();
    let starts = 0;
    const routes = makeRoutes(session, {
      startSession: async () => { starts += 1; },
    });

    // Arm the breaker for the default-selected provider before any start.
    recordQuotaExhausted('claude', "You've used your inference allowance");

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');

    expect(starts).toBe(0);
    expect(session.generatorPromise).toBeNull();
  });

  it('arms the breaker when the generator fails with quota_exhausted', async () => {
    const session = makeSession();
    const routes = makeRoutes(session, {
      startSession: async () => {
        throw new ClassifiedProviderError("You've used your $30 CMEM Pro inference allowance", {
          kind: 'quota_exhausted',
          code: 'allowance_exhausted',
          cause: new Error('cap'),
        });
      },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;

    const cooldown = getQuotaCooldown('claude');
    expect(cooldown).not.toBeNull();
    expect(isQuotaCooldownActive(cooldown!, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS)).toBe(true);

    // The next start is now skipped — the loop is broken.
    let restarts = 0;
    const gated = makeRoutes(session, { startSession: async () => { restarts += 1; } });
    session.generatorPromise = null;
    await gated.ensureGeneratorRunning(session.sessionDbId, 'observation');
    expect(restarts).toBe(0);
  });

  it('admits exactly one probe after the cooldown expires (a concurrent session stays suppressed)', async () => {
    const armed = recordQuotaExhausted('claude', "You've used your inference allowance");

    // Cooldown has elapsed for both sessions.
    Date.now = () => realDateNow() + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const sessionA = makeSession(1);
    let startsA = 0;
    const routesA = makeRoutes(sessionA, { startSession: async () => { startsA += 1; } });
    await routesA.ensureGeneratorRunning(sessionA.sessionDbId, 'observation');
    await sessionA.generatorPromise;

    // A admitted the single probe and re-armed the cooldown with a fresh
    // generation, so B — reaching the gate afterwards — is suppressed.
    expect(startsA).toBe(1);
    const reArmed = getQuotaCooldown('claude');
    expect(reArmed).not.toBeNull();
    expect(reArmed!.generation).toBeGreaterThan(armed.generation);
    expect(sessionA.quotaProbeGeneration).toBe(reArmed!.generation);

    const sessionB = makeSession(2);
    let startsB = 0;
    const routesB = makeRoutes(sessionB, { startSession: async () => { startsB += 1; } });
    await routesB.ensureGeneratorRunning(sessionB.sessionDbId, 'observation');

    expect(startsB).toBe(0);
    expect(sessionB.generatorPromise).toBeNull();
  });
});
