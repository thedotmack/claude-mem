import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { logger } from '../../src/utils/logger.js';
import { clearQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import { resetQuotaFallbackStateForTesting } from '../../src/services/worker/provider-dispatch.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

/**
 * Drives the real SessionRoutes generator lifecycle (dispatch, admission, the
 * exit handling, and the periodic resume sweep) with fake provider agents, the
 * same harness shape as overflow-recycle-resume.test.ts. Settings are pinned
 * with env vars, which SettingsDefaultsManager applies last.
 *
 * Quota-paused work has no resume of its own: the worker's periodic sweep
 * (SessionRoutes.resumePendingSessions, once a minute) paces itself on the
 * provider dispatch returns, so it restarts the work wherever it can run.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
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
  let active: ActiveSession | undefined = session;
  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => {
      active = undefined;
    },
    // The sweep's view of SessionManager: a paused session with buffered work
    // and no generator (the real filter also skips pending timers).
    getResumableSessionIds: () => (
      active && !active.generatorPromise && ['quota', 'rate_limit'].includes(active.pausedReason ?? '')
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
  return { routes, stats: () => ({ finalizeCalls, active }) };
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

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    resetQuotaFallbackStateForTesting();
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

  it('resumes work paused by a quota exit onto the fallback on the next sweep, with no further hook event', async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes, stats } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'quota:quota_exhausted'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(0);
    expect(session.pausedReason).toBe('quota');

    expect(await sweep(routes)).toBe(1);
    expect(claudeStarts).toBe(1);
    expect(infoLines).toContain('Generator auto-starting (periodic-resume) using Claude SDK');
    expect(stats().finalizeCalls).toBe(0);
  });

  it('does not resume when the fallback is itself in a quota cooldown', async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'quota:quota_exhausted'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(0);
    await expectNoResume(routes);
  });

  it('does not resume an auth pause, even with a fallback configured', async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'auth:auth_invalid'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(0);
    await expectNoResume(routes);
  });

  it('with no fallback configured, a quota pause waits out its cooldown', async () => {
    pin({ CLAUDE_MEM_PROVIDER: 'gemini', CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key' });
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes } = buildRoutes(session, {
      gemini: async (s) => { geminiStarts += 1; s.abortReason = 'quota:quota_exhausted'; },
      claude: async () => { claudeStarts += 1; await hang(); },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(geminiStarts).toBe(1);
    expect(claudeStarts).toBe(0);
    await expectNoResume(routes);
  });

  it('does not resume when dispatch would not use the fallback (cmem-gateway branch)', async () => {
    // The gateway trial-expiry branch sends work to Claude regardless of the
    // quota fallback rule, so the sweep finds Claude's fresh breaker and starts
    // nothing: the quota fallback never routes around the cmem branch.
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
    const { routes } = buildRoutes(session, {
      gemini: async () => { geminiStarts += 1; await hang(); },
      claude: async (s) => { claudeStarts += 1; s.abortReason = 'quota:seven_day'; },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(claudeStarts).toBe(1);
    expect(geminiStarts).toBe(0);
    await expectNoResume(routes);
  });

  it("schedules at most one resume: the fallback's own quota exit does not start another", async () => {
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    recordQuotaExhausted('gemini', 'Daily limit reached');
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes } = buildRoutes(session, {
      gemini: async () => { geminiStarts += 1; await hang(); },
      claude: async (s) => { claudeStarts += 1; s.abortReason = 'quota:seven_day'; },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();

    expect(claudeStarts).toBe(1);
    expect(geminiStarts).toBe(0);
    await expectNoResume(routes);
  });

  it("resumes a fallback run's own quota exit on the primary once the primary has recovered", async () => {
    // A generator keeps running on the fallback after the primary recovers
    // elsewhere; when it then hits its own quota, the primary can take the work.
    pin(GEMINI_WITH_CLAUDE_FALLBACK);
    recordQuotaExhausted('gemini', 'Daily limit reached');
    const session = makeSession();
    let geminiStarts = 0;
    let claudeStarts = 0;
    const { routes } = buildRoutes(session, {
      gemini: async () => { geminiStarts += 1; await hang(); },
      claude: async (s) => {
        claudeStarts += 1;
        clearQuotaCooldown('gemini'); // another session's gemini probe succeeded meanwhile
        s.abortReason = 'quota:seven_day';
      },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
    expect(claudeStarts).toBe(1);
    expect(geminiStarts).toBe(0);

    expect(await sweep(routes)).toBe(1);
    expect(geminiStarts).toBe(1);
    expect(infoLines).toContain('Generator auto-starting (periodic-resume) using Gemini');
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
