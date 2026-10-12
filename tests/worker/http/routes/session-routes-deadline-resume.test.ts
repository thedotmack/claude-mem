import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ActiveSession } from '../../../../src/services/worker-types.js';
import { OpenRouterProvider } from '../../../../src/services/worker/OpenRouterProvider.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import {
  SessionManager,
  transportResumeDelayMs,
  MAX_TRANSPORT_RESUME_BASE_DELAY_MS,
} from '../../../../src/services/worker/SessionManager.js';
import { MAX_UNATTENDED_GATEWAY_RESUMES } from '../../../../src/services/worker/session/response-pacer.js';
import { handleGeneratorExit } from '../../../../src/services/worker/session/GeneratorExitHandler.js';
import { startGeneratorWithProvider } from '../../../../src/services/worker/session/GeneratorRunner.js';
import { ClassifiedProviderError } from '../../../../src/services/worker/provider-errors.js';
import { resolveLlmTimeoutMs, withRetry } from '../../../../src/services/worker/retry.js';
import { getQuotaCooldown, resetQuotaCooldownsForTesting } from '../../../../src/shared/quota-cooldown.js';
import { clearProFallback } from '../../../../src/shared/cmem-gateway.js';
import { getDependencyStatus, resetDependencyStatusesForTesting } from '../../../../src/shared/dependency-health.js';
import * as realProviderDispatch from '../../../../src/services/worker/provider-dispatch.js';
import * as realProcessRegistry from '../../../../src/supervisor/process-registry.js';

const providerDispatchSnapshot = { ...realProviderDispatch };
const processRegistrySnapshot = { ...realProcessRegistry };
mock.module('../../../../src/services/worker/provider-dispatch.js', () => ({
  ...providerDispatchSnapshot,
  selectProviderForGenerator: () => ({ provider: 'openrouter', gatewayProbeClaimId: null }),
  getSelectedProvider: () => 'openrouter',
}));

const { SessionRoutes } = await import('../../../../src/services/worker/http/routes/SessionRoutes.js');

function makeSession(): ActiveSession {
  return {
    sessionDbId: 4204,
    contentSessionId: 'ended-content-session',
    memorySessionId: 'memory-4204',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'last prompt',
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

describe('deadline-paused observer resumes without a new hook (#4204)', () => {
  const realSetTimeout = globalThis.setTimeout;
  let scheduled: Array<{ delayMs: number; run: () => void }>;

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    ModeManager.getInstance().loadMode('code');
    scheduled = [];
  });

  afterEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
  });

  afterAll(() => {
    mock.module('../../../../src/services/worker/provider-dispatch.js', () => providerDispatchSnapshot);
    mock.module('../../../../src/supervisor/process-registry.js', () => processRegistrySnapshot);
  });

  async function failDeleteDuringSubprocessExit(
    sessionManager: SessionManager,
    sessionDbId: number,
    beforeFailure?: () => void | Promise<void>,
  ) {
    let processLookups = 0;
    mock.module('../../../../src/supervisor/process-registry.js', () => ({
      ...processRegistrySnapshot,
      getSdkProcessForSession: () => ++processLookups === 1
        ? { pid: 123, pgid: 123, process: { exitCode: null } }
        : undefined,
      ensureSdkProcessExit: async () => {
        await Promise.resolve();
        await beforeFailure?.();
        throw new Error('forced subprocess teardown failure');
      },
    }));
    try {
      await expect(sessionManager.deleteSession(sessionDbId)).rejects.toThrow('forced subprocess teardown failure');
    } finally {
      mock.module('../../../../src/supervisor/process-registry.js', () => processRegistrySnapshot);
    }
  }

  function makeHarness(deadlineFailures: number) {
    const session = makeSession();
    // Only transport resumes use this clock. Provider deadlines and unrelated
    // worker timers remain real, including during the full-suite replay.
    const transportClock = {
      setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
        const handle = { unref() {} } as ReturnType<typeof setTimeout>;
        scheduled.push({ delayMs, run: callback });
        return handle;
      },
      clearTimeout(_timer: ReturnType<typeof setTimeout>): void {},
    };
    const sessionManager = new SessionManager({} as any, transportClock);
    // An earlier hook created this session. Keep the real manager and buffer;
    // the database-backed creation path is unrelated to transport recovery.
    (sessionManager as unknown as { sessions: Map<number, ActiveSession> }).sessions.set(session.sessionDbId, session);
    const buffer = sessionManager.getMessageBuffer();
    const messageId = buffer.enqueue(session.sessionDbId, {
      type: 'observation',
      tool_name: 'Read',
      tool_input: '{"file_path":"notes.txt"}',
      tool_response: 'content',
      prompt_number: 1,
    });
    let starts = 0;
    let processedId: number | undefined;
    let confirmedCount = 0;
    let finalizeCalls = 0;

    class DeadlineProvider extends OpenRouterProvider {
      protected override getConfig() {
        return { apiKey: 'test-key', model: 'test-model', apiUrl: 'https://openrouter.ai/api/v1/chat/completions' };
      }

      protected override async query() {
        return withRetry(
          signal => new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
          }),
          { label: 'observer request', perAttemptTimeoutMs: 20, maxRetries: 2 },
        );
      }

      override async startSession(current: ActiveSession): Promise<void> {
        starts += 1;
        if (starts > deadlineFailures) {
          for await (const pending of sessionManager.getMessageIterator(current.sessionDbId)) {
            processedId = pending._persistentId;
            confirmedCount = await sessionManager.confirmClaimedMessages(current.sessionDbId);
            break;
          }
          return;
        }
        await super.startSession(current);
      }
    }

    const provider = new DeadlineProvider({} as any, sessionManager);
    const routes = new SessionRoutes(
      sessionManager,
      {} as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      provider,
      {} as any,
      {} as any,
      { finalizeSession: async () => { finalizeCalls += 1; } } as any,
    );
    sessionManager.setGeneratorStarter((id, source) => routes.ensureGeneratorRunning(id, source));

    return {
      session,
      routes,
      sessionManager,
      buffer,
      messageId,
      stats: () => ({ starts, processedId, confirmedCount, finalizeCalls }),
      async startInitial() {
        // This is the final hook from an ended session; there are no later calls.
        await routes.ensureGeneratorRunning(session.sessionDbId, 'summarize');
        await session.generatorPromise;
      },
      async fireResume(index: number) {
        const timer = scheduled[index];
        if (!timer) throw new Error('No transport resume timer at index ' + index);
        timer.run();
        await new Promise<void>(resolve => realSetTimeout(resolve, 0));
        if (session.generatorPromise) await session.generatorPromise;
      },
    };
  }

  it('retries the same buffered observation after a per-attempt deadline', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();

    expect(harness.stats().starts).toBe(1);
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
    expect(harness.stats().finalizeCalls).toBe(0);
    expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBe(harness.session);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBeGreaterThan(0);

    await harness.fireResume(0);

    expect(harness.stats().starts).toBe(2);
    expect(harness.stats().processedId).toBe(harness.messageId);
    expect(harness.stats().confirmedCount).toBe(1);
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
  });

  it('backs off across repeated deadlines, then processes the original message', async () => {
    const harness = makeHarness(3);
    await harness.startInitial();

    for (let index = 0; index < 3; index++) {
      expect(scheduled).toHaveLength(index + 1);
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
      const nominalMs = Math.min(resolveLlmTimeoutMs() * 2 ** index, MAX_TRANSPORT_RESUME_BASE_DELAY_MS);
      expect(scheduled[index].delayMs).toBeGreaterThanOrEqual(nominalMs);
      expect(scheduled[index].delayMs).toBeLessThan(nominalMs * 1.25);
      await harness.fireResume(index);
    }

    expect(harness.stats().starts).toBe(4);
    expect(harness.stats().processedId).toBe(harness.messageId);
    expect(harness.stats().confirmedCount).toBe(1);
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
  });

  describe('unattended resume cap on the cmem gateway (plan tokens)', () => {
    const GATEWAY_ENV_KEYS = [
      'CLAUDE_MEM_PROVIDER', 'CLAUDE_MEM_OPENROUTER_BASE_URL', 'CMEM_PRO_ORIGIN', 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
    ] as const;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const key of GATEWAY_ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of GATEWAY_ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it('stops re-arming after the cap on the gateway; a hook-driven start still drains the work', async () => {
      // Settings apply env overrides last, so this pins memory on the gateway.
      process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://cmem.ai/api/inference/v1';
      const harness = makeHarness(MAX_UNATTENDED_GATEWAY_RESUMES + 1);
      await harness.startInitial();

      for (let index = 0; index < MAX_UNATTENDED_GATEWAY_RESUMES; index++) {
        expect(scheduled).toHaveLength(index + 1);
        await harness.fireResume(index);
      }

      // The initial run and every unattended probe hit the deadline; no
      // further timer is armed, and the work stays buffered, not dropped.
      expect(harness.stats().starts).toBe(MAX_UNATTENDED_GATEWAY_RESUMES + 1);
      expect(scheduled).toHaveLength(MAX_UNATTENDED_GATEWAY_RESUMES);
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
      expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBe(harness.session);
      expect(harness.stats().finalizeCalls).toBe(0);

      // Real user activity (the next hook) still drains the buffer.
      await harness.routes.ensureGeneratorRunning(harness.session.sessionDbId, 'observation');
      await harness.session.generatorPromise;
      expect(harness.stats().processedId).toBe(harness.messageId);
      expect(harness.stats().confirmedCount).toBe(1);
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
    });

    it('caps unattended resumes when the gateway serves as the opt-in quota fallback', async () => {
      // Memory's own provider is Gemini, but the gateway can take the work as
      // the quota fallback: every unattended resume there spends plan tokens too.
      process.env.CLAUDE_MEM_PROVIDER = 'gemini';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://cmem.ai/api/inference/v1';
      process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'openrouter';
      const harness = makeHarness(MAX_UNATTENDED_GATEWAY_RESUMES + 1);
      await harness.startInitial();

      for (let index = 0; index < MAX_UNATTENDED_GATEWAY_RESUMES; index++) {
        expect(scheduled).toHaveLength(index + 1);
        await harness.fireResume(index);
      }

      expect(scheduled).toHaveLength(MAX_UNATTENDED_GATEWAY_RESUMES);
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
      // The periodic sweep honours the same spent budget.
      harness.session.pausedReason = 'quota';
      expect(harness.sessionManager.getResumableSessionIds()).toEqual([]);
    });

    it('keeps resuming a user-owned OpenRouter key past the gateway cap', async () => {
      process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
      const harness = makeHarness(MAX_UNATTENDED_GATEWAY_RESUMES + 1);
      await harness.startInitial();

      for (let index = 0; index <= MAX_UNATTENDED_GATEWAY_RESUMES; index++) {
        expect(scheduled).toHaveLength(index + 1);
        await harness.fireResume(index);
      }

      expect(harness.stats().starts).toBe(MAX_UNATTENDED_GATEWAY_RESUMES + 2);
      expect(harness.stats().confirmedCount).toBe(1);
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
    });

    // One run that pauses the way an OpenAI-compatible provider does on a
    // classified error: label the pause, abort, and rethrow.
    async function runPausedGeneration(
      harness: ReturnType<typeof makeHarness>,
      abortReason: string,
      error: ClassifiedProviderError,
    ): Promise<void> {
      await startGeneratorWithProvider(harness.session, 'openrouter', 'observation', null, null, {
        sessionManager: harness.sessionManager,
        sdkAgent: {} as any,
        geminiAgent: {} as any,
        openRouterAgent: {
          startSession: async (current: ActiveSession) => {
            current.abortReason = abortReason;
            current.abortController.abort();
            throw error;
          },
        } as any,
        workerService: {} as any,
        completionHandler: { finalizeSession: async () => {} } as any,
        ensureGeneratorRunning: (id, source) => harness.routes.ensureGeneratorRunning(id, source),
        maybeSelfHealStaleClaudeSpawn: () => false,
      });
      await harness.session.generatorPromise;
    }

    function cancelScheduledResume(session: ActiveSession): void {
      clearTimeout(session.scheduledResumeTimer);
      session.scheduledResumeTimer = undefined;
    }

    it('shares one budget between transport and rate-limit resumes; spent, the breaker takes over', async () => {
      process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://cmem.ai/api/inference/v1';
      const harness = makeHarness(MAX_UNATTENDED_GATEWAY_RESUMES + 5);
      const rateLimited = () => new ClassifiedProviderError('Rate limited by the gateway', {
        kind: 'rate_limit',
        retryAfterMs: 60_000,
      });
      await harness.startInitial();
      await harness.fireResume(0);
      // Two unattended transport resumes are already scheduled...
      expect(scheduled).toHaveLength(2);
      expect(harness.session.consecutiveUnattendedGatewayResumes).toBe(2);

      // ...so one Retry-After resume still fits the budget,
      await runPausedGeneration(harness, 'rate_limit:rate_limit', rateLimited());
      expect(harness.session.scheduledResumeTimer).toBeDefined();
      expect(getQuotaCooldown('openrouter')).toBeNull();
      cancelScheduledResume(harness.session);

      // ...and the next does not: nothing is scheduled, and the breaker
      // withholds requests instead, as when the rate-limit resumes run out.
      await runPausedGeneration(harness, 'rate_limit:rate_limit', rateLimited());
      expect(harness.session.scheduledResumeTimer).toBeUndefined();
      expect(getQuotaCooldown('openrouter')?.window).toBe('rate_limit');
      // Nothing buffered was dropped.
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
      expect(harness.stats().finalizeCalls).toBe(0);
    });

    it('counts the move to the Anthropic plan after a cmem fallback against the same budget', async () => {
      process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://cmem.ai/api/inference/v1';
      const harness = makeHarness(0);
      const allowanceSpent = () => new ClassifiedProviderError('Your memory allowance is used up', {
        kind: 'quota_exhausted',
        code: 'allowance_exhausted',
      });
      try {
        harness.session.consecutiveUnattendedGatewayResumes = MAX_UNATTENDED_GATEWAY_RESUMES - 1;

        // The last resume the budget allows moves the work to Claude at once...
        await runPausedGeneration(harness, 'quota:quota_exhausted', allowanceSpent());
        expect(harness.session.scheduledResumeTimer).toBeDefined();
        cancelScheduledResume(harness.session);

        // ...and past it the work waits for the next hook, still buffered.
        await runPausedGeneration(harness, 'quota:quota_exhausted', allowanceSpent());
        expect(harness.session.scheduledResumeTimer).toBeUndefined();
        expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
        expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBe(harness.session);
      } finally {
        clearProFallback();
      }
    });

    it('keeps the periodic sweep off a session whose unattended gateway resumes are spent', () => {
      process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://cmem.ai/api/inference/v1';
      const harness = makeHarness(0);
      const sessionDbId = harness.session.sessionDbId;
      harness.session.pausedReason = 'quota';
      expect(harness.sessionManager.getResumableSessionIds()).toEqual([sessionDbId]);

      harness.session.consecutiveUnattendedGatewayResumes = MAX_UNATTENDED_GATEWAY_RESUMES;
      expect(harness.sessionManager.getResumableSessionIds()).toEqual([]);
      // The operator's explicit retry is not unattended.
      expect(harness.sessionManager.getResumableSessionIds(true)).toEqual([sessionDbId]);

      // Off the gateway the budget does not apply.
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
      expect(harness.sessionManager.getResumableSessionIds()).toEqual([sessionDbId]);
    });
  });

  describe('which pauses resume on the transport backoff', () => {
    function exitWith(reason: string) {
      const calls: string[] = [];
      const sessionManager = {
        getMessageBuffer: () => ({ getPendingCount: () => 1 }),
        scheduleTransportResume: () => { calls.push('schedule'); },
        clearTransportResume: () => { calls.push('clear'); },
      };
      const completionHandler = { finalizeSession: async () => { calls.push('finalize'); } };
      return handleGeneratorExit(makeSession(), reason, {
        sessionManager: sessionManager as any,
        completionHandler: completionHandler as any,
      }).then(() => calls);
    }

    // A deadline keeps its own code once withRetry labels it; the Claude CLI's
    // transport failure arrives as text. Both strand buffered work without this.
    for (const reason of ['transport:transient', 'transport:deadline_exceeded', 'transport:observer_text']) {
      it(`schedules a resume for ${reason}`, async () => {
        expect(await exitWith(reason)).toEqual(['schedule']);
      });
    }

    it('leaves a response stall to its own bounded resume', async () => {
      expect(await exitWith('transport:response_stall')).toEqual(['clear']);
    });

    it('clears a pending transport resume when a later run pauses for another reason', async () => {
      expect(await exitWith('rate_limit:rate_limit')).toEqual(['clear']);
    });
  });

  it('releases the probe permit when starting a resume rejects', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();
    harness.sessionManager.setGeneratorStarter(async () => {
      throw new Error('temporary starter failure');
    });

    await harness.fireResume(0);
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
    expect(scheduled).toHaveLength(2);

    harness.sessionManager.setGeneratorStarter((id, source) => harness.routes.ensureGeneratorRunning(id, source));
    await harness.fireResume(1);
    expect(harness.stats().starts).toBe(2);
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
  });

  for (const reason of ['quota:rate_limit', 'auth:auth_invalid']) {
    it('cancels a prior transport timer when a later ' + reason + ' pause takes over', async () => {
      const harness = makeHarness(1);
      await harness.startInitial();

      expect(scheduled).toHaveLength(1);
      await handleGeneratorExit(harness.session, reason, {
        sessionManager: harness.sessionManager,
        completionHandler: { finalizeSession: async () => {} } as any,
      });
      expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBe(harness.session);
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);

      await harness.fireResume(0);
      expect(harness.stats().starts).toBe(1);
      expect(scheduled).toHaveLength(1);
    });
  }

  it('restores a pending transport resume after subprocess teardown fails', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();
    expect(scheduled).toHaveLength(1);

    await failDeleteDuringSubprocessExit(harness.sessionManager, harness.session.sessionDbId, () => {
      // A running generator can consume shutdown before subprocess cleanup rejects.
      harness.session.abortReason = null;
    });

    expect(harness.sessionManager.isSessionDeleting(harness.session.sessionDbId)).toBe(false);
    expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBe(harness.session);
    expect(harness.session.abortReason).toBeNull();
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].delayMs).toBeGreaterThanOrEqual(resolveLlmTimeoutMs());

    await harness.fireResume(0); // the canceled timer must be inert
    expect(harness.stats().starts).toBe(1);
    await harness.fireResume(1);
    expect(harness.stats().starts).toBe(2);
    expect(harness.stats().processedId).toBe(harness.messageId);
  });

  it('rearms again when failed teardown leaves a settled generator promise stored', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();
    harness.session.generatorPromise = Promise.resolve();

    await failDeleteDuringSubprocessExit(harness.sessionManager, harness.session.sessionDbId, () => {
      harness.session.abortReason = null;
    });
    expect(scheduled).toHaveLength(2);

    await harness.fireResume(1);
    expect(harness.session.generatorPromise).toBeNull();
    expect(harness.stats().starts).toBe(1);
    expect(scheduled).toHaveLength(3);

    await harness.fireResume(2);
    expect(harness.stats().starts).toBe(2);
    expect(harness.stats().processedId).toBe(harness.messageId);
  });

  for (const reason of ['quota:rate_limit', 'auth:auth_invalid']) {
    it('does not restore a ' + reason + ' pause after subprocess teardown fails', async () => {
      const harness = makeHarness(1);
      await harness.startInitial();
      await handleGeneratorExit(harness.session, reason, {
        sessionManager: harness.sessionManager,
        completionHandler: { finalizeSession: async () => {} } as any,
      });
      const scheduledBeforeDelete = scheduled.length;

      await failDeleteDuringSubprocessExit(harness.sessionManager, harness.session.sessionDbId);

      expect(harness.sessionManager.isSessionDeleting(harness.session.sessionDbId)).toBe(false);
      expect(harness.session.abortReason).toBeNull();
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
      expect(scheduled).toHaveLength(scheduledBeforeDelete);
    });

    it('does not restore transport work when ' + reason + ' takes over during failing teardown', async () => {
      const harness = makeHarness(1);
      await harness.startInitial();
      expect(scheduled).toHaveLength(1);

      await failDeleteDuringSubprocessExit(harness.sessionManager, harness.session.sessionDbId, async () => {
        // GeneratorRunner consumes abortReason before handing this decision
        // to GeneratorExitHandler, so a reason snapshot alone reads null.
        harness.session.abortReason = null;
        await handleGeneratorExit(harness.session, reason, {
          sessionManager: harness.sessionManager,
          completionHandler: { finalizeSession: async () => {} } as any,
        });
      });

      expect(harness.sessionManager.isSessionDeleting(harness.session.sessionDbId)).toBe(false);
      expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBe(harness.session);
      expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
      expect(scheduled).toHaveLength(1);
      await harness.fireResume(0);
      expect(harness.stats().starts).toBe(1);
    });
  }

  it('leaves buffered work paused after a Claude setup-required exit', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();
    let failSetup!: (error: Error) => void;
    const setupRun = new Promise<void>((_resolve, reject) => { failSetup = reject; });
    await startGeneratorWithProvider(harness.session, 'claude', 'observation', null, null, {
      sessionManager: harness.sessionManager,
      sdkAgent: { startSession: () => setupRun } as any,
      geminiAgent: {} as any,
      openRouterAgent: {} as any,
      workerService: {} as any,
      completionHandler: { finalizeSession: async () => {} } as any,
      ensureGeneratorRunning: (id, source) => harness.routes.ensureGeneratorRunning(id, source),
      maybeSelfHealStaleClaudeSpawn: () => false,
    });
    const running = harness.session.generatorPromise!;

    scheduled[0].run();
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    failSetup(new ClassifiedProviderError('Claude executable not found', {
      kind: 'setup_required', cause: new Error('Claude executable not found'),
    }));
    await running;
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));

    expect(getDependencyStatus('claude_cli')?.kind).toBe('setup_required');
    expect(harness.session.generatorPromise).toBeNull();
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(harness.stats().starts).toBe(1);
  });

  it('does not restart a session removed before its delayed resume', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();

    expect(scheduled).toHaveLength(1);
    harness.sessionManager.removeSessionImmediate(harness.session.sessionDbId);
    await harness.fireResume(0);

    expect(harness.stats().starts).toBe(1);
    expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBeUndefined();
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
  });
  it('retries a withheld resume when admission starts no generator', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();

    let resumeCalls = 0;
    harness.sessionManager.setGeneratorStarter((id, source) => {
      resumeCalls += 1;
      if (resumeCalls === 1) return; // e.g. a quota cooldown declined admission
      return harness.routes.ensureGeneratorRunning(id, source);
    });

    await harness.fireResume(0);
    expect(resumeCalls).toBe(1);
    expect(harness.stats().starts).toBe(1);
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].delayMs).toBeGreaterThanOrEqual(
      Math.min(resolveLlmTimeoutMs() * 2, MAX_TRANSPORT_RESUME_BASE_DELAY_MS),
    );

    await harness.fireResume(1);
    expect(resumeCalls).toBe(2);
    expect(harness.stats().starts).toBe(2);
    expect(harness.stats().processedId).toBe(harness.messageId);
    expect(harness.stats().confirmedCount).toBe(1);
  });

  it('rearms when a hook generator skips exit handling with work still buffered', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();

    let finishHook!: () => void;
    // The setup-required path clears generatorPromise without calling
    // handleGeneratorExit. The original transport timer must not be lost.
    harness.session.generatorPromise = new Promise<void>(resolve => {
      finishHook = () => {
        harness.session.generatorPromise = null;
        resolve();
      };
    });
    scheduled[0].run();
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(harness.stats().starts).toBe(1);
    expect(scheduled).toHaveLength(1);

    finishHook();
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(scheduled).toHaveLength(2);
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(1);

    await harness.fireResume(1);
    expect(harness.stats().starts).toBe(2);
    expect(harness.stats().processedId).toBe(harness.messageId);
  });

  it('honors removal after a timer fires but before its starter microtask', async () => {
    const harness = makeHarness(1);
    await harness.startInitial();

    expect(scheduled).toHaveLength(1);
    scheduled[0].run(); // queues the starter in a microtask
    harness.sessionManager.removeSessionImmediate(harness.session.sessionDbId);
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));

    expect(harness.stats().starts).toBe(1);
    expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBeUndefined();
    expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
  });

  it('does not start an orphaned generator when teardown races tier routing', async () => {
    for (const teardown of ['removed', 'deleting'] as const) {
      const harness = makeHarness(1);
      await harness.startInitial();

      let enterRouting!: () => void;
      let finishRouting!: () => void;
      const routingEntered = new Promise<void>(resolve => { enterRouting = resolve; });
      (harness.routes as unknown as { applyTierRouting: () => Promise<void> }).applyTierRouting = () => {
        enterRouting();
        return new Promise<void>(resolve => { finishRouting = resolve; });
      };

      scheduled[scheduled.length - 1].run();
      await routingEntered;
      if (teardown === 'removed') {
        harness.sessionManager.removeSessionImmediate(harness.session.sessionDbId);
      } else {
        // deleteSession fences callbacks before its async teardown removes the map entry.
        (harness.sessionManager as unknown as { deletingSessions: Set<number> })
          .deletingSessions.add(harness.session.sessionDbId);
      }
      finishRouting();
      await new Promise<void>(resolve => realSetTimeout(resolve, 0));

      expect(harness.stats().starts).toBe(1);
      if (teardown === 'removed') {
        expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBeUndefined();
        expect(harness.buffer.getPendingCount(harness.session.sessionDbId)).toBe(0);
      } else {
        expect(harness.sessionManager.getSession(harness.session.sessionDbId)).toBe(harness.session);
        harness.sessionManager.removeSessionImmediate(harness.session.sessionDbId);
      }
    }
  });

  it('admits ready sessions in FIFO order and releases the shared slot', async () => {
    const ids = [4204, 4205, 4206, 4207];
    const transportClock = {
      setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
        scheduled.push({ delayMs, run: callback });
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimeout(_timer: ReturnType<typeof setTimeout>): void {},
    };
    const sessionManager = new SessionManager({} as any, transportClock);
    const sessions = (sessionManager as unknown as { sessions: Map<number, ActiveSession> }).sessions;
    const starts: number[] = [];
    const complete = new Map<number, () => void>();
    for (const id of ids) {
      const session = { ...makeSession(), sessionDbId: id };
      sessions.set(id, session);
      sessionManager.getMessageBuffer().enqueue(id, {
        type: 'observation',
        tool_name: 'Read',
        tool_input: '{}',
        tool_response: 'content',
        prompt_number: 1,
      });
    }
    sessionManager.setGeneratorStarter((id) => {
      starts.push(id);
      const session = sessionManager.getSession(id)!;
      session.generatorPromise = new Promise<void>(resolve => {
        complete.set(id, () => {
          session.generatorPromise = null;
          resolve();
        });
      });
    });
    for (const id of ids) sessionManager.scheduleTransportResume(id);

    // The second timer becomes ready first; subsequent timers retain arrival order.
    scheduled[1].run();
    scheduled[0].run();
    scheduled[2].run();
    scheduled[3].run();
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(starts).toEqual([4205]);

    complete.get(4205)!();
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(starts).toEqual([4205, 4204]);

    // A generator may stay alive in its idle window after draining work.
    const iterator = sessionManager.getMessageIterator(4204);
    await iterator.next();
    await sessionManager.confirmClaimedMessages(4204);
    await iterator.return();
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(starts).toEqual([4205, 4204, 4206]);

    // Removal releases the slot even if its generator has not settled yet.
    sessionManager.removeSessionImmediate(4206);
    await new Promise<void>(resolve => realSetTimeout(resolve, 0));
    expect(starts).toEqual([4205, 4204, 4206, 4207]);
    sessionManager.removeSessionImmediate(4207);
  });

  it('keeps jitter at the nominal backoff ceiling', () => {
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      const earliest = transportResumeDelayMs(100);
      Math.random = () => 0.999;
      const later = transportResumeDelayMs(100);

      expect(earliest).toBe(MAX_TRANSPORT_RESUME_BASE_DELAY_MS);
      expect(later).toBeGreaterThan(earliest);
      expect(later).toBeLessThan(MAX_TRANSPORT_RESUME_BASE_DELAY_MS * 1.25);
    } finally {
      Math.random = originalRandom;
    }
  });
});
