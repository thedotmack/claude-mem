import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { logger } from '../../src/utils/logger.js';
import { clearQuotaCooldown, isQuotaCooldownActive, recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import { resetQuotaFallbackStateForTesting } from '../../src/services/worker/provider-dispatch.js';
import { setClaudeFallbackReadinessForTesting } from '../../src/shared/claude-fallback-readiness.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

/**
 * Drives the real SessionRoutes generator lifecycle (dispatch, admission, the
 * exit handling, and the periodic resume sweep) with fake provider agents, the
 * same harness shape as overflow-recycle-resume.test.ts. Settings are pinned
 * with env vars, which SettingsDefaultsManager applies last.
 *
 * A quota or auth exit discards the session's buffered work
 * (docs/architecture/observer-lifecycle.md): no sweep, fallback, or recovered
 * provider sends it later. Fresh work still goes through dispatch and
 * admission, so the quota fallback serves the next captured event. The
 * worker's periodic sweep (SessionRoutes.resumePendingSessions) only resumes
 * pauses that keep their work, paced on the provider dispatch returns.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_PROVIDER_BY_SOURCE',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_MODEL',
  'CLAUDE_MEM_TIER_ROUTING_ENABLED',
] as const;

const GEMINI_WITH_CLAUDE_FALLBACK = {
  CLAUDE_MEM_PROVIDER: 'gemini',
  CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key',
  CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude',
};

function makeSession(): ActiveSession {
  return {
    sessionDbId: 88,
    contentSessionId: 'content-88',
    memorySessionId: 'memory-88',
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

/** Let deferred starts run. */
function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5));
}

/** A generator that stays alive, as a real one does while it consumes work. */
function hang(): Promise<void> {
  return new Promise<void>(() => {});
}

interface FakeAgents {
  claude: (session: ActiveSession) => Promise<void>;
  gemini: (session: ActiveSession) => Promise<void>;
}

function buildRoutes(session: ActiveSession, agents: FakeAgents) {
  let finalizeCalls = 0;
  let discards = 0;
  let pending = 1;
  let active: ActiveSession | undefined = session;
  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => pending, peekTypes: () => [] }),
    discardBufferedWork: () => {
      discards += 1;
      const dropped = pending;
      pending = 0;
      return dropped;
    },
    removeSessionImmediate: () => {
      active = undefined;
    },
    // The sweep's view of SessionManager: a session paused for a reason that
    // keeps its buffered work, with work buffered and no generator (the real
    // filter also skips pending timers). Quota and auth are not among them.
    getResumableSessionIds: () => (
      active && !active.generatorPromise && pending > 0
        && [null, undefined, 'rate_limit', 'overflow', 'provider_switch', 'response_stall'].includes(active.pausedReason)
        ? [active.sessionDbId]
        : []
    ),
  };
  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession: agents.claude } as any,
    { startSession: agents.gemini } as any,
    { startSession: async () => {} } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => { finalizeCalls += 1; } } as any,
  );
  return {
    routes,
    stats: () => ({ finalizeCalls, discards, pending, active }),
    /** A new captured event buffers fresh work. */
    captureFreshWork: () => { pending = 1; },
  };
}

describe('quota fallback in SessionRoutes', () => {
  let savedEnv: Record<string, string | undefined>;
  let infoLines: string[];
  let warnLines: string[];
  let spies: Array<ReturnType<typeof spyOn>>;

  function pin(env: Record<string, string>): void {
    Object.assign(process.env, { CLAUDE_MEM_OPENROUTER_API_KEY: '', CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false' }, env);
  }

  /** Run the periodic sweep, as the worker does once a minute, and let any start it schedules run. */
  async function sweep(routes: InstanceType<typeof SessionRoutes>): Promise<number> {
    const scheduled = routes.resumePendingSessions('periodic-resume');
    await nextTick();
    return scheduled;
  }

  /**
   * The sweep scheduled nothing. Start counts alone cannot show this: a resume
   * dispatched to a held provider is refused by admission and starts nothing,
   * so the skip line is what would give it away.
   */
  async function expectNoResume(routes: InstanceType<typeof SessionRoutes>): Promise<void> {
    expect(await sweep(routes)).toBe(0);
    expect(infoLines.filter(line => line.startsWith('Generator auto-starting (periodic-resume'))).toEqual([]);
    expect(warnLines).not.toContain('Skipping generator start while the provider cooldown is active');
  }

  let previousClaudeReadiness: (() => boolean) | null;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    resetQuotaFallbackStateForTesting();
    // A Claude login exists, so Claude can take fallback work.
    previousClaudeReadiness = setClaudeFallbackReadinessForTesting(() => true);
    infoLines = [];
    warnLines = [];
    spies = [
      spyOn(logger, 'info').mockImplementation((_component: string, message: string) => { infoLines.push(message); }),
      spyOn(logger, 'warn').mockImplementation((_component: string, message: string) => { warnLines.push(message); }),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    setClaudeFallbackReadinessForTesting(previousClaudeReadiness);
    spies.forEach(spy => spy.mockRestore());
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetQuotaCooldownsForTesting();
    resetQuotaFallbackStateForTesting();
  });

  // The quota breaker is process-global; see overflow-recycle-resume.test.ts.
  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('sends a session-less Telegram wrap-up to the provider its input source maps to', async () => {
    pin({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_PROVIDER_BY_SOURCE: '{"codex":"codex"}' });
    let formatter: ((input: any) => Promise<string>) | undefined;
    const wrapupInput = { sessionDbId: 1, contentSessionId: 'c', project: 'p', platformSource: 'codex', summaryText: 's' };
    new SessionRoutes(
      { getSession: () => undefined, setTelegramWrapupFormatter: (fn: any) => { formatter = fn; } } as any,
      {} as any,
      { formatTelegramWrapup: async () => 'claude' } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { formatTelegramWrapup: async () => 'codex' } as any,
    );

    expect(await formatter!(wrapupInput)).toBe('codex');
    expect(await formatter!({ ...wrapupInput, platformSource: 'claude' })).toBe('claude');
  });

  it('paces the sweep per session on the provider its source maps to', async () => {
    pin({
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'off',
      CLAUDE_MEM_PROVIDER_BY_SOURCE: '{"claude":"claude"}',
    });
    const session = makeSession();
    session.pausedReason = 'rate_limit';
    let claudeStarts = 0;
    const { routes } = buildRoutes(session, {
      gemini: async () => {},
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    // The global provider is held, but this session's own provider is healthy.
    recordQuotaExhausted('gemini', 'Daily limit reached');
    expect(await sweep(routes)).toBe(1);
    expect(claudeStarts).toBe(1);
  });

  it('holds the sweep when the mapped provider is held, though the global one is healthy', async () => {
    pin({
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'off',
      CLAUDE_MEM_PROVIDER_BY_SOURCE: '{"claude":"claude"}',
    });
    const session = makeSession();
    session.pausedReason = 'rate_limit';
    const { routes } = buildRoutes(session, {
      gemini: async () => {},
      claude: async () => { await hang(); },
    });

    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    await expectNoResume(routes);
  });

  /** Start the session on a captured event and let its run end. */
  async function runOnce(routes: InstanceType<typeof SessionRoutes>, session: ActiveSession): Promise<void> {
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
  }

  it('discards work buffered at a quota exit; the next captured event starts fresh on the fallback', async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes, stats, captureFreshWork } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'quota:quota_exhausted'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await runOnce(routes, session);
    expect(geminiStarts).toBe(1);
    expect(session.pausedReason).toBe('quota');
    expect(isQuotaCooldownActive('gemini')).toBe(true);
    expect(stats()).toMatchObject({ discards: 1, pending: 0, finalizeCalls: 0, active: session });

    // No sweep sends the discarded work to the fallback.
    await expectNoResume(routes);
    expect(claudeStarts).toBe(0);

    // Fresh activity goes through dispatch, which takes the fallback.
    captureFreshWork();
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    expect(claudeStarts).toBe(1);
    expect(geminiStarts).toBe(1);
  });

  it('discards work buffered at an auth exit, and no sweep sends it to the fallback', async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes, stats } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'auth:auth_invalid'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await runOnce(routes, session);
    expect(session.pausedReason).toBe('auth');
    expect(stats()).toMatchObject({ discards: 1, pending: 0, finalizeCalls: 0, active: session });

    await expectNoResume(routes);
    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(0);
  });

  it('refuses and discards fresh work when the fallback is itself in a quota cooldown', async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes, stats, captureFreshWork } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'quota:quota_exhausted'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await runOnce(routes, session);
    expect(geminiStarts).toBe(1);
    expect(stats().discards).toBe(1);
    await expectNoResume(routes);

    // Both credentials are held: admission starts nothing and keeps no backlog.
    captureFreshWork();
    await runOnce(routes, session);
    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(0);
    expect(warnLines).toContain('Skipping generator start while the provider cooldown is active');
    expect(stats()).toMatchObject({ discards: 2, pending: 0, finalizeCalls: 0, active: session });
  });

  it('with the fallback turned off, fresh work during the cooldown is refused and discarded', async () => {
    pin({ CLAUDE_MEM_PROVIDER: 'gemini', CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key', CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'off' });
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes, stats, captureFreshWork } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'quota:quota_exhausted'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await runOnce(routes, session);
    expect(stats().discards).toBe(1);
    await expectNoResume(routes);

    captureFreshWork();
    await runOnce(routes, session);
    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(0);
    expect(stats()).toMatchObject({ discards: 2, pending: 0, finalizeCalls: 0 });
  });

  it('does not route fresh work to the quota fallback on the cmem-gateway branch', async () => {
    // The gateway trial-expiry branch sends work to Claude regardless of the
    // quota fallback rule, so with Claude's fresh breaker armed, fresh work is
    // refused there: the quota fallback never routes around the cmem branch.
    pin({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_test-key',  // the gateway only takes a cm_pro_ key (#4276)
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_PRO_FALLBACK_AT: new Date().toISOString(),
      CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'gemini',
    });
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes, stats, captureFreshWork } = buildRoutes(session, {
      gemini: async () => { geminiStarts += 1; await hang(); },
      claude: async (s) => { claudeStarts += 1; s.abortReason = 'quota:seven_day'; },
    });

    await runOnce(routes, session);
    expect(claudeStarts).toBe(1);
    expect(stats().discards).toBe(1);
    await expectNoResume(routes);

    captureFreshWork();
    await runOnce(routes, session);
    expect(claudeStarts).toBe(1);
    expect(geminiStarts).toBe(0);
    expect(stats().discards).toBe(2);
  });

  it("a fallback run's own quota exit discards its work too: the recovered primary gets only fresh work", async () => {
    // A generator keeps running on the fallback after the primary recovers
    // elsewhere. When it then hits its own quota, its buffered work is dropped,
    // not resumed on the primary; the next captured event starts there.
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    recordQuotaExhausted('gemini', 'Daily limit reached');
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes, stats, captureFreshWork } = buildRoutes(session, {
      gemini: async () => { geminiStarts += 1; await hang(); },
      claude: async (s) => {
        claudeStarts += 1;
        clearQuotaCooldown('gemini'); // another session's gemini probe succeeded meanwhile
        s.abortReason = 'quota:seven_day';
      },
    });

    await runOnce(routes, session);
    expect(claudeStarts).toBe(1);
    expect(isQuotaCooldownActive('claude')).toBe(true);
    expect(stats()).toMatchObject({ discards: 1, pending: 0, finalizeCalls: 0 });

    await expectNoResume(routes);
    expect(geminiStarts).toBe(0);

    captureFreshWork();
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(1);
  });

  it('runs the configured fallback model on a fallback run', async () => {
    pin({ ...GEMINI_WITH_CLAUDE_FALLBACK, CLAUDE_MEM_QUOTA_FALLBACK_MODEL: 'claude-haiku-4-5-20251001' });
    recordQuotaExhausted('gemini', 'Daily limit reached');
    const session = makeSession();
    let modelAtStart: string | undefined = 'not started';
    const { routes } = buildRoutes(session, {
      gemini: async () => { await hang(); },
      claude: async (s) => { modelAtStart = s.modelOverride; await hang(); },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');

    expect(modelAtStart).toBe('claude-haiku-4-5-20251001');
  });

  it('leaves the model alone on a fallback run when no fallback model is set', async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    recordQuotaExhausted('gemini', 'Daily limit reached');
    const session = makeSession();
    let modelAtStart: string | undefined = 'not started';
    const { routes } = buildRoutes(session, {
      gemini: async () => { await hang(); },
      claude: async (s) => { modelAtStart = s.modelOverride; await hang(); },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');

    expect(modelAtStart).toBeUndefined();
  });

  it('never applies the fallback model outside the fallback path', async () => {
    pin({
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_GEMINI_API_KEY: '',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'gemini',
      CLAUDE_MEM_QUOTA_FALLBACK_MODEL: 'claude-haiku-4-5-20251001',
    });
    const session = makeSession();
    let modelAtStart: string | undefined = 'not started';
    const { routes } = buildRoutes(session, {
      gemini: async () => { await hang(); },
      claude: async (s) => { modelAtStart = s.modelOverride; await hang(); },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');

    expect(modelAtStart).toBeUndefined();
  });
});
