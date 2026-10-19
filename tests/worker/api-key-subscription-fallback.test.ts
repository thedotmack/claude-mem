import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { logger } from '../../src/utils/logger.js';
import {
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  getQuotaCooldown,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import {
  canSubscriptionStandInForApiKey,
  setClaudeFallbackReadinessForTesting,
} from '../../src/shared/claude-fallback-readiness.js';
import { quotaServingProvider, resetQuotaFallbackStateForTesting } from '../../src/services/worker/provider-dispatch.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

/**
 * CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD=subscription: a Claude observer whose
 * ANTHROPIC_API_KEY spent its allowance keeps running on the Claude Code login,
 * and goes back to the key once its probe succeeds.
 *
 * The login is a real `.credentials.json` in a temp profile dir
 * (CLAUDE_MEM_CLAUDE_CONFIG_DIR), the same file hasClaudeSubscriptionLogin reads.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD',
  'CLAUDE_MEM_CLAUDE_CONFIG_DIR',
  'CLAUDE_MEM_TIER_ROUTING_ENABLED',
] as const;

const SPENT_KEY = 'Your credit balance is too low to access the Anthropic API.';

let savedEnv: Record<string, string | undefined>;
let previousClaudeReadiness: (() => boolean) | null;
let spies: Array<ReturnType<typeof spyOn>>;
let warnLines: string[];
let profileDir: string;

function signIn(): void {
  writeFileSync(join(profileDir, '.credentials.json'), '{}');
}

function setUp(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  profileDir = mkdtempSync(join(tmpdir(), 'claude-mem-subscription-standin-'));
  Object.assign(process.env, {
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD: 'subscription',
    CLAUDE_MEM_CLAUDE_CONFIG_DIR: profileDir,
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
  });
  resetQuotaCooldownsForTesting();
  resetDependencyStatusesForTesting();
  resetQuotaFallbackStateForTesting();
  previousClaudeReadiness = setClaudeFallbackReadinessForTesting(() => true);
  warnLines = [];
  spies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation((_c: string, message: string) => { warnLines.push(message); }),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
}

function tearDown(): void {
  spies.forEach(spy => spy.mockRestore());
  setClaudeFallbackReadinessForTesting(previousClaudeReadiness);
  resetQuotaCooldownsForTesting();
  resetQuotaFallbackStateForTesting();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(profileDir, { recursive: true, force: true });
}

function makeSession(): ActiveSession {
  return {
    sessionDbId: 92,
    contentSessionId: 'content-92',
    memorySessionId: 'memory-92',
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
    pausedReason: 'quota',
  };
}

function hang(): Promise<void> {
  return new Promise<void>(() => {});
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5));
}

/** Routes whose Claude agent records the credential override each start ran with. */
function buildRoutes(session: ActiveSession) {
  const starts: Array<'oauth' | null | undefined> = [];
  let active: ActiveSession | undefined = session;
  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => { active = undefined; },
    getResumableSessionIds: () => (active && !active.generatorPromise ? [active.sessionDbId] : []),
  };
  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession: async (s: ActiveSession) => { starts.push(s.claudeAuthOverride); await hang(); } } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => {} } as any,
  );
  return { routes, starts };
}

describe('API key to subscription fallback: admission', () => {
  beforeEach(setUp);
  afterEach(tearDown);
  afterAll(() => resetQuotaCooldownsForTesting());

  it("runs on the subscription login while the API key's breaker holds", async () => {
    signIn();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, 'api-key');
    const session = makeSession();
    const { routes, starts } = buildRoutes(session);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await nextTick();

    expect(starts).toEqual(['oauth']);
    expect(warnLines).toContain('API key quota exhausted; running the Claude observer on the subscription login until the key recovers');
    expect(warnLines).not.toContain('Primary in quota cooldown and the quota fallback cannot serve; capture waits until it clears');
    // The key's breaker is untouched: it still decides when the key is re-probed.
    expect(getQuotaCooldown('claude')?.auth).toBe('api-key');
  });

  it('goes back to the key once its window elapses, taking the probe without the override', async () => {
    signIn();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1, undefined, 'api-key');
    const session = makeSession();
    session.claudeAuthOverride = 'oauth';
    const { routes, starts } = buildRoutes(session);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await nextTick();

    expect(starts).toEqual([null]);
    expect(getQuotaCooldown('claude')?.probeInFlightSinceMs).not.toBeNull();
  });

  it.each([
    ['the setting is off', () => { process.env.CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD = ''; signIn(); }, 'api-key'],
    ['there is no Claude Code login', () => {}, 'api-key'],
    ['the breaker was not armed by an API key', () => { signIn(); }, undefined],
  ] as const)('waits as before when %s', async (_label, arrange, auth) => {
    arrange();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, auth);
    const session = makeSession();
    const { routes, starts } = buildRoutes(session);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await nextTick();

    expect(starts).toEqual([]);
    expect(warnLines).toContain('Skipping generator start while the provider cooldown is active');
  });

  it.each([
    ['an API-key run', null, 'api-key'],
    ['a subscription stand-in', 'oauth', undefined],
  ] as const)('tags the breaker armed by %s spending its allowance', async (_label, override, expectedAuth) => {
    signIn();
    const session = makeSession();
    let active: ActiveSession | undefined = session;
    const routes = new SessionRoutes(
      {
        getSession: () => active,
        getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
        removeSessionImmediate: () => { active = undefined; },
        getResumableSessionIds: () => [],
      } as any,
      {} as any,
      {
        // Quota prose from the observer: ResponseProcessor aborts without throwing.
        startSession: async (s: ActiveSession) => {
          s.observerAuth = 'api-key';
          s.claudeAuthOverride = override;
          s.abortReason = 'quota:observer_text';
          s.abortController.abort();
        },
      } as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      {} as any,
      {} as any,
      { finalizeSession: async () => {} } as any,
    );

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
    clearTimeout(session.scheduledResumeTimer);

    expect(getQuotaCooldown('claude')?.window).toBe('observer_text');
    expect(getQuotaCooldown('claude')?.auth).toBe(expectedAuth);
  });

  it('resumes the paused backlog while the key is held', () => {
    signIn();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, 'api-key');
    const { routes } = buildRoutes(makeSession());
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
  });

  it('tells the session start that memory is on the subscription, until both are spent', () => {
    signIn();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, 'api-key');
    expect(canSubscriptionStandInForApiKey()).toBe(true);
    expect(quotaServingProvider('claude')).toBe('claude');

    // The login's own run hit its limit: re-armed untagged, capture pauses.
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');
    expect(canSubscriptionStandInForApiKey()).toBe(false);
    expect(quotaServingProvider('claude')).toBeNull();
  });
});
