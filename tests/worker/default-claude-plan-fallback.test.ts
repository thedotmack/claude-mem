import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { logger } from '../../src/utils/logger.js';
import { paths } from '../../src/shared/paths.js';
import {
  RATE_LIMIT_RECHECK_COOLDOWN_MS,
  clearQuotaCooldown,
  getQuotaCooldown,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../src/shared/dependency-health.js';
import { setClaudeFallbackReadinessForTesting } from '../../src/shared/claude-fallback-readiness.js';
import { renderObserverQuotaCooldownNotice, type ObserverHealthState } from '../../src/shared/observer-health.js';
import {
  getSelectedProvider,
  readQuotaFallbackProvider,
  resetQuotaFallbackStateForTesting,
  routeAroundUnservableProvider,
  selectProviderForGenerator,
} from '../../src/services/worker/provider-dispatch.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

/**
 * The owner's directive: when the selected provider cannot serve, observer
 * work falls back to the Anthropic plan by default, on every install, and
 * goes back to the selected provider once it recovers.
 *
 * Settings are pinned with env vars (SettingsDefaultsManager applies them
 * last); "unset" reads the temp data dir's settings file, whose default is the
 * Anthropic plan as well.
 */
const CMEM_GATEWAY_BASE = 'https://cmem.ai/api/inference/v1';
const CMEM_MEMORY_KEY = 'cm_pro_0123456789abcdef01234567';

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CMEM_PRO_ORIGIN',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_MODEL',
  'CLAUDE_MEM_TIER_ROUTING_ENABLED',
] as const;

/** Memory on the cmem.ai gateway, the fallback setting left as an install has it. */
function pinGatewayPrimary(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_GATEWAY_BASE,
    CLAUDE_MEM_OPENROUTER_API_KEY: CMEM_MEMORY_KEY,
    CLAUDE_MEM_PRO_FALLBACK_AT: '',
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
  }, overrides);
}

let savedEnv: Record<string, string | undefined>;
let previousClaudeReadiness: (() => boolean) | null;
let spies: Array<ReturnType<typeof spyOn>>;
let infoLines: string[];
let warnLines: string[];

function setUp(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetQuotaCooldownsForTesting();
  resetDependencyStatusesForTesting();
  resetQuotaFallbackStateForTesting();
  // A Claude login exists unless a test says otherwise.
  previousClaudeReadiness = setClaudeFallbackReadinessForTesting(() => true);
  infoLines = [];
  warnLines = [];
  spies = [
    spyOn(logger, 'info').mockImplementation((_c: string, message: string) => { infoLines.push(message); }),
    spyOn(logger, 'warn').mockImplementation((_c: string, message: string) => { warnLines.push(message); }),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
}

function tearDown(): void {
  spies.forEach(spy => spy.mockRestore());
  setClaudeFallbackReadinessForTesting(previousClaudeReadiness);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetQuotaCooldownsForTesting();
  resetQuotaFallbackStateForTesting();
}

describe('default Anthropic-plan fallback: dispatch', () => {
  beforeEach(setUp);
  afterEach(tearDown);
  afterAll(() => resetQuotaCooldownsForTesting());

  it('defaults to the Anthropic plan, whether the setting is absent or persisted as "" by an older install', () => {
    pinGatewayPrimary();
    expect(readQuotaFallbackProvider()).toBe('claude');
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = '';
    expect(readQuotaFallbackProvider()).toBe('claude');
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'off';
    expect(readQuotaFallbackProvider()).toBeNull();
  });

  it('moves gateway work to Claude while a rate-limit / over-capacity breaker holds', () => {
    pinGatewayPrimary({ CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: '' });
    recordQuotaExhausted('openrouter', 'The observer is briefly over capacity.', 'rate_limit');
    expect(selectProviderForGenerator()).toEqual({ provider: 'claude', gatewayProbeClaimId: null, fallbackFrom: 'openrouter' });
    expect(getSelectedProvider()).toBe('claude');
    expect(warnLines).toContain('Primary cannot serve right now; memory runs on the Anthropic plan (Claude) until it recovers');
  });

  it('moves gateway work to Claude while an outage / unusable-reply breaker holds', () => {
    pinGatewayPrimary();
    expect(routeAroundUnservableProvider('openrouter', 'Empty response from OpenRouter', 'unavailable')).toBe('claude');
    expect(getQuotaCooldown('openrouter')?.window).toBe('unavailable');
    expect(selectProviderForGenerator().provider).toBe('claude');
  });

  it('stays on the primary, arming nothing, when no Claude login or key exists', () => {
    pinGatewayPrimary();
    setClaudeFallbackReadinessForTesting(() => false);
    expect(routeAroundUnservableProvider('openrouter', 'upstream 503', 'unavailable')).toBeNull();
    expect(getQuotaCooldown('openrouter')).toBeNull();
    recordQuotaExhausted('openrouter', 'The observer is briefly over capacity.', 'rate_limit');
    expect(selectProviderForGenerator()).toEqual({ provider: 'openrouter', gatewayProbeClaimId: null });
  });

  it("stays on the primary when the fallback is turned 'off'", () => {
    pinGatewayPrimary({ CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'off' });
    expect(routeAroundUnservableProvider('openrouter', 'upstream 503', 'unavailable')).toBeNull();
    recordQuotaExhausted('openrouter', 'The observer is briefly over capacity.', 'rate_limit');
    expect(selectProviderForGenerator()).toEqual({ provider: 'openrouter', gatewayProbeClaimId: null });
  });

  it('never falls back when Claude is the selected provider', () => {
    Object.assign(process.env, { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_OPENROUTER_API_KEY: '', CLAUDE_MEM_GEMINI_API_KEY: '' });
    expect(routeAroundUnservableProvider('claude', 'Anthropic overloaded', 'unavailable')).toBeNull();
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('re-probes the primary once the window elapses, and returns to it when it recovers', () => {
    pinGatewayPrimary();
    recordQuotaExhausted('openrouter', 'over capacity', 'rate_limit', Date.now() - RATE_LIMIT_RECHECK_COOLDOWN_MS - 1);
    expect(selectProviderForGenerator().provider).toBe('openrouter');
    clearQuotaCooldown('openrouter');
    expect(selectProviderForGenerator()).toEqual({ provider: 'openrouter', gatewayProbeClaimId: null });
  });

  it('tells the session start that memory is on the Anthropic plan', () => {
    const state = {
      quotaCooldown: {
        active: true,
        provider: 'openrouter',
        armedAt: 0,
        until: Date.now() + 60_000,
        window: 'rate_limit',
        message: 'over capacity',
        servingProvider: 'claude',
      },
    } as unknown as ObserverHealthState;
    expect(renderObserverQuotaCooldownNotice(state)).toContain('memory is running on your Anthropic plan (Claude)');
  });
});

// ---------------------------------------------------------------------------
// The generator lifecycle: a gateway failure moves the buffered work to Claude
// at once, with no further hook event.
// ---------------------------------------------------------------------------

function makeSession(): ActiveSession {
  return {
    sessionDbId: 91,
    contentSessionId: 'content-91',
    memorySessionId: 'memory-91',
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

function hang(): Promise<void> {
  return new Promise<void>(() => {});
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5));
}

/** A gateway generator that pauses on `error`, as the OpenAI-compatible base does. */
function pausingOn(error: ClassifiedProviderError, abortReason: string, starts: { n: number }) {
  return async (session: ActiveSession): Promise<void> => {
    starts.n += 1;
    session.abortReason = abortReason;
    session.abortController.abort();
    throw error;
  };
}

function buildRoutes(
  session: ActiveSession,
  agents: { claude: (s: ActiveSession) => Promise<void>; openrouter: (s: ActiveSession) => Promise<void> },
) {
  let active: ActiveSession | undefined = session;
  const sessionManager = {
    getSession: () => active,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    removeSessionImmediate: () => { active = undefined; },
    // The sweep's view: a paused session with buffered work and no generator,
    // filtered on the same automatically-retryable reasons SessionManager uses.
    getResumableSessionIds: () => (
      active && !active.generatorPromise
        && [null, undefined, 'quota', 'rate_limit', 'overflow', 'provider_switch', 'response_stall'].includes(active.pausedReason)
        ? [active.sessionDbId]
        : []
    ),
  };
  return new SessionRoutes(
    sessionManager as any,
    {} as any,
    { startSession: agents.claude } as any,
    { startSession: async () => {} } as any,
    { startSession: agents.openrouter } as any,
    {} as any,
    {} as any,
    { finalizeSession: async () => {} } as any,
  );
}

describe('default Anthropic-plan fallback: generator lifecycle', () => {
  beforeEach(setUp);
  afterEach(tearDown);
  afterAll(() => resetQuotaCooldownsForTesting());

  async function runGatewayFailure(error: ClassifiedProviderError, abortReason: string) {
    const session = makeSession();
    const gatewayStarts = { n: 0 };
    let claudeStarts = 0;
    const routes = buildRoutes(session, {
      openrouter: pausingOn(error, abortReason, gatewayStarts),
      claude: async () => { claudeStarts += 1; await hang(); },
    });
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
    await nextTick();
    clearTimeout(session.scheduledResumeTimer);
    return { gatewayStarts: gatewayStarts.n, claudeStarts: () => claudeStarts, session };
  }

  const overCapacity = (): ClassifiedProviderError => new ClassifiedProviderError('The observer is briefly over capacity.', {
    kind: 'rate_limit', code: 'rate_limited', retryAfterMs: 60_000, cause: null,
  });
  const upstreamDown = (): ClassifiedProviderError => new ClassifiedProviderError('upstream 503', {
    kind: 'transient', cause: null,
  });

  it('a gateway over-capacity refusal past its retries moves the work to Claude at once', async () => {
    pinGatewayPrimary({ CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: '' });
    const run = await runGatewayFailure(overCapacity(), 'rate_limit:rate_limit');
    expect(run.gatewayStarts).toBe(1);
    expect(run.claudeStarts()).toBe(1);
    expect(infoLines).toContain('Generator auto-starting (provider-fallback) using Claude SDK');
    expect(getQuotaCooldown('openrouter')?.window).toBe('rate_limit');
  });

  it('a gateway outage (5xx / network) past its retries moves the work to Claude at once', async () => {
    pinGatewayPrimary();
    const run = await runGatewayFailure(upstreamDown(), 'transport:transient');
    expect(run.claudeStarts()).toBe(1);
    expect(getQuotaCooldown('openrouter')?.window).toBe('unavailable');
  });

  it('a gateway key refusal moves the work to Claude (the trial-expiry fallback)', async () => {
    const settingsPath = paths.settings();
    const original = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : null;
    try {
      const settings = original ? JSON.parse(original) : {};
      writeFileSync(settingsPath, JSON.stringify({ ...settings, CLAUDE_MEM_PRO_FALLBACK_AT: '' }));
      pinGatewayPrimary();
      delete process.env.CLAUDE_MEM_PRO_FALLBACK_AT; // the marker lives in the file
      const refused = new ClassifiedProviderError('Your trial has ended.', {
        kind: 'auth_invalid', code: 'subscription_inactive', cause: null,
      });
      const run = await runGatewayFailure(refused, 'auth:auth_invalid');
      expect(run.claudeStarts()).toBe(1);
      expect(selectProviderForGenerator().provider).toBe('claude');
    } finally {
      if (original === null) writeFileSync(settingsPath, '{}');
      else writeFileSync(settingsPath, original);
    }
  });

  it('a signed-out Claude fallback is taken out of rotation, and the work returns to the recovered primary', async () => {
    pinGatewayPrimary();
    const session = makeSession();
    let gatewayStarts = 0;
    let claudeStarts = 0;
    let gatewayDown = true;
    const routes = buildRoutes(session, {
      openrouter: async (s) => {
        gatewayStarts += 1;
        if (!gatewayDown) { await hang(); return; }
        s.abortReason = 'transport:transient';
        s.abortController.abort();
        throw upstreamDown();
      },
      // Claude Code answers with its signed-out prose; ResponseProcessor
      // turns that into this abort reason without throwing.
      claude: async (s) => { claudeStarts += 1; s.abortReason = 'auth:observer_text'; },
    });

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;
    await nextTick();
    await session.generatorPromise;
    await nextTick();
    expect(gatewayStarts).toBe(1);
    expect(claudeStarts).toBe(1);

    // Claude is held for its refused credential, so the next event does not
    // start it again; the gateway is still held, so nothing starts.
    expect(getQuotaCooldown('claude')?.cause).toBe('auth');
    expect(selectProviderForGenerator().provider).toBe('openrouter');
    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await nextTick();
    expect(claudeStarts).toBe(1);
    expect(gatewayStarts).toBe(1);

    // The session is not stranded as an auth pause: once the gateway recovers,
    // the periodic sweep hands the work back to it.
    expect(session.pausedReason).toBe('provider_switch');
    gatewayDown = false;
    clearQuotaCooldown('openrouter');
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await nextTick();
    expect(gatewayStarts).toBe(2);
    expect(claudeStarts).toBe(1);
  });

  it('with no Claude login, the gateway failure waits as before', async () => {
    pinGatewayPrimary();
    setClaudeFallbackReadinessForTesting(() => false);
    const run = await runGatewayFailure(upstreamDown(), 'transport:transient');
    expect(run.claudeStarts()).toBe(0);
    expect(getQuotaCooldown('openrouter')).toBeNull();
  });

  it("with the fallback 'off', the gateway failure waits as before", async () => {
    pinGatewayPrimary({ CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'off' });
    const run = await runGatewayFailure(overCapacity(), 'rate_limit:rate_limit');
    expect(run.claudeStarts()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Repeated unusable replies: the batch goes to Claude instead of being dropped.
// ---------------------------------------------------------------------------

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations: () => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }),
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

const makeWorker = (): WorkerRef => ({ broadcastProcessingStatus: () => {} }) as unknown as WorkerRef;

async function claimOne(sm: SessionManager, sessionDbId: number, queue: boolean): Promise<void> {
  if (queue) {
    await sm.queueObservation(sessionDbId, {
      tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: `tu-${sessionDbId}`,
    });
  }
  const iterator = sm.getMessageIterator(sessionDbId);
  const claimed = await iterator.next();
  expect(claimed.done).toBe(false);
  await iterator.return?.();
}

describe('default Anthropic-plan fallback: unusable replies', () => {
  beforeEach(setUp);
  afterEach(tearDown);
  afterAll(() => resetQuotaCooldownsForTesting());

  async function answerTwice(sessionDbId: number) {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(sessionDbId, 'do the thing', 1);
    session.memorySessionId = `mem-${sessionDbId}`;
    session.currentProvider = 'openrouter';
    await claimOne(sm, sessionDbId, true);
    const confirmSpy = spyOn(sm, 'confirmClaimedMessages');
    const answer = () => processAgentResponse('', session, makeDbManager(), sm, makeWorker(), 0, null, 'OpenRouter');
    await answer();
    session.abortController = new AbortController();
    session.abortReason = null;
    await claimOne(sm, sessionDbId, false);
    await answer();
    return { sm, session, confirmSpy };
  }

  it('hands a batch the gateway answered twice without XML to Claude instead of dropping it', async () => {
    pinGatewayPrimary();
    const { sm, session, confirmSpy } = await answerTwice(301);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(sm.getMessageBuffer().getPendingCount(301)).toBe(1);
    expect(session.abortReason).toStartWith('output_retry:');
    expect(getQuotaCooldown('openrouter')?.window).toBe('unavailable');
    expect(selectProviderForGenerator().provider).toBe('claude');
  });

  it('still drops it when Claude cannot take the work', async () => {
    pinGatewayPrimary();
    setClaudeFallbackReadinessForTesting(() => false);
    const { sm, confirmSpy } = await answerTwice(302);
    expect(confirmSpy).toHaveBeenCalledWith(302);
    expect(sm.getMessageBuffer().getPendingCount(302)).toBe(0);
    expect(getQuotaCooldown('openrouter')).toBeNull();
  });
});
