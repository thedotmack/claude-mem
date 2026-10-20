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
import { claudeQuotaStandIn, setClaudeFallbackReadinessForTesting } from '../../src/shared/claude-fallback-readiness.js';
import { readObserverHealth, renderObserverQuotaCooldownNotice } from '../../src/shared/observer-health.js';
import {
  quotaServingProvider,
  resetQuotaFallbackStateForTesting,
  selectProviderForGenerator,
} from '../../src/services/worker/provider-dispatch.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

/**
 * CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD: while the primary Claude credential
 * is held for quota, the observer runs on the other one ('subscription' for a
 * spent API key, 'api-key' for a spent or guard-paused login), and goes back
 * once the primary's probe succeeds.
 *
 * The login is a real `.credentials.json` in a temp profile dir
 * (CLAUDE_MEM_CLAUDE_CONFIG_DIR), the same file hasClaudeSubscriptionLogin
 * reads; the fallback key is a real .env (CLAUDE_MEM_ENV_FILE).
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD',
  'CLAUDE_MEM_CLAUDE_CONFIG_DIR',
  'CLAUDE_MEM_ENV_FILE',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_TIER_ROUTING_ENABLED',
] as const;

const SPENT_KEY = 'Your credit balance is too low to access the Anthropic API.';
const SPENT_LOGIN = 'Memory capture paused by the Claude usage reserve guard.';
const TO_SUBSCRIPTION_LOG = 'API key quota exhausted; running the Claude observer on the subscription login until the key recovers';
const TO_API_KEY_LOG = 'Claude Code login paused for quota; running the Claude observer on the fallback API key until the login recovers';

let savedEnv: Record<string, string | undefined>;
let previousClaudeReadiness: (() => boolean) | null;
let spies: Array<ReturnType<typeof spyOn>>;
let warnLines: string[];
let tempDir: string;

function signIn(): void {
  writeFileSync(join(tempDir, '.credentials.json'), '{}');
}

function setFallbackKey(): void {
  writeFileSync(join(tempDir, '.env'), 'ANTHROPIC_FALLBACK_API_KEY=sk-ant-fallback\n', { mode: 0o600 });
}

function setUp(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-credential-fallback-'));
  Object.assign(process.env, {
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD: 'subscription',
    CLAUDE_MEM_CLAUDE_CONFIG_DIR: tempDir,
    CLAUDE_MEM_ENV_FILE: join(tempDir, '.env'),
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
  rmSync(tempDir, { recursive: true, force: true });
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

function buildRoutes(session: ActiveSession, claude: (s: ActiveSession) => Promise<void>) {
  let active: ActiveSession | undefined = session;
  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => { active = undefined; },
    getResumableSessionIds: () => (active && !active.generatorPromise ? [active.sessionDbId] : []),
  };
  return new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession: claude } as any,
    { startSession: async () => {} } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => {} } as any,
  );
}

/** Routes whose Claude agent records the credential override each start ran with. */
function recordingRoutes(session: ActiveSession) {
  const starts: Array<string | null | undefined> = [];
  const routes = buildRoutes(session, async (s) => { starts.push(s.claudeAuthOverride); await hang(); });
  return { routes, starts };
}

async function startOnce(session: ActiveSession) {
  const { routes, starts } = recordingRoutes(session);
  await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
  await nextTick();
  return starts;
}

describe('Claude credential fallback: admission', () => {
  beforeEach(setUp);
  afterEach(tearDown);
  afterAll(() => resetQuotaCooldownsForTesting());

  it("runs on the subscription login while the API key's breaker holds", async () => {
    signIn();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, 'api-key');

    expect(await startOnce(makeSession())).toEqual(['subscription']);
    expect(warnLines).toContain(TO_SUBSCRIPTION_LOG);
    expect(warnLines).not.toContain('Primary in quota cooldown and the quota fallback cannot serve; capture waits until it clears');
    // The key's breaker is untouched: it still decides when the key is re-probed.
    expect(getQuotaCooldown('claude')?.auth).toBe('api-key');
  });

  it("runs on the fallback API key while the login's breaker holds", async () => {
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD = 'api-key';
    setFallbackKey();
    recordQuotaExhausted('claude', SPENT_LOGIN, 'five_hour', undefined, undefined, 'subscription');

    expect(await startOnce(makeSession())).toEqual(['api-key']);
    expect(warnLines).toContain(TO_API_KEY_LOG);
    expect(getQuotaCooldown('claude')?.auth).toBe('subscription');
  });

  it('goes back to the primary once its window elapses, taking the probe without the override', async () => {
    signIn();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1, undefined, 'api-key');
    const session = makeSession();
    session.claudeAuthOverride = 'subscription';

    expect(await startOnce(session)).toEqual([null]);
    expect(getQuotaCooldown('claude')?.probeInFlightSinceMs).not.toBeNull();
  });

  it.each([
    ['the setting is off', () => { process.env.CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD = ''; signIn(); }, 'api-key'],
    ['there is no Claude Code login', () => {}, 'api-key'],
    ['the breaker was not armed by the primary credential', () => { signIn(); }, undefined],
    ['the setting names the held credential itself', () => { signIn(); }, 'subscription'],
    ['there is no fallback API key', () => { process.env.CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD = 'api-key'; }, 'subscription'],
    ['a gateway is configured', () => {
      signIn();
      writeFileSync(join(tempDir, '.env'), 'ANTHROPIC_BASE_URL=https://gateway.example\nANTHROPIC_API_KEY=sk-gw\n');
    }, 'api-key'],
  ] as const)('waits as before when %s', async (_label, arrange, auth) => {
    arrange();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, auth);

    expect(await startOnce(makeSession())).toEqual([]);
    expect(warnLines).toContain('Skipping generator start while the provider cooldown is active');
  });

  it('resumes the paused backlog while the primary is held', () => {
    signIn();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, 'api-key');
    const { routes } = recordingRoutes(makeSession());
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
  });
});

describe('Claude credential fallback: order and booking', () => {
  beforeEach(setUp);
  afterEach(tearDown);
  afterAll(() => resetQuotaCooldownsForTesting());

  it('tries the other credential before the provider fallback, and the provider fallback once both are held', () => {
    signIn();
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'gemini';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = 'gemini-key';
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, 'api-key');
    expect(selectProviderForGenerator().provider).toBe('claude');

    // The login's own run hit its limit: re-armed untagged, so both are spent.
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');
    expect(selectProviderForGenerator().provider).toBe('gemini');
  });

  it.each([
    ['an API-key run spending its allowance', 'api-key', null, 'quota:observer_text', 'api-key'],
    ['a login run paused by the quota guard', 'subscription', null, 'quota:five_hour:quota_guard', 'subscription'],
    ['a quota-fallback run', 'api-key', 'subscription', 'quota:observer_text', undefined],
  ] as const)('tags the breaker armed by %s', async (_label, observerAuth, override, abortReason, expectedAuth) => {
    const session = makeSession();
    // Quota prose or the guard: the run aborts without throwing.
    const routes = buildRoutes(session, async (s) => {
      s.observerAuth = observerAuth;
      s.claudeAuthOverride = override;
      s.abortReason = abortReason;
      s.abortController.abort();
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
    clearTimeout(session.scheduledResumeTimer);

    expect(getQuotaCooldown('claude')?.window).toBe(abortReason.split(':')[1]);
    expect(getQuotaCooldown('claude')?.auth).toBe(expectedAuth);
  });

  it.each([
    ['subscription', 'api-key', () => signIn(), 'memory is running on your Claude Code subscription login'],
    ['api-key', 'subscription', () => setFallbackKey(), 'memory is running on your fallback API key (ANTHROPIC_FALLBACK_API_KEY)'],
  ] as const)('tells the session start which credential memory runs on (%s), until both are spent', (target, held, arrange, notice) => {
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD = target;
    arrange();
    recordQuotaExhausted('claude', SPENT_KEY, undefined, undefined, undefined, held);
    expect(claudeQuotaStandIn()).toBe(target);
    expect(quotaServingProvider('claude')).toBe('claude');
    expect(renderObserverQuotaCooldownNotice(readObserverHealth()!)).toContain(notice);

    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');
    expect(claudeQuotaStandIn()).toBeNull();
    expect(quotaServingProvider('claude')).toBeNull();
  });
});
