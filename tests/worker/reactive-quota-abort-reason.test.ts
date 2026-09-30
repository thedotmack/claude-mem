import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { telemetryBuffer } from '../../src/services/telemetry/buffer.js';
import { OBSERVER_HEALTH_FILENAME, readObserverHealth } from '../../src/shared/observer-health.js';
import { paths } from '../../src/shared/paths.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { ClassifiedProviderError, DEADLINE_EXCEEDED_CODE } from '../../src/services/worker/provider-errors.js';
import { withRetry } from '../../src/services/worker/retry.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';

/**
 * #3700 — a reactive 429 must pause the session, not finalize it.
 *
 * abortReason was only ever set to `quota:…` by the two PROACTIVE sites: the
 * pre-request rate-limit guard, and the observer-text heuristic. An HTTP 429
 * coming back from the provider was classified correctly and then rethrown
 * with abortReason untouched, so SessionRoutes' .finally() saw `reason=null`
 * and handleGeneratorExit tore the session down — dropping buffered work for
 * a condition that clears by itself.
 */

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 382,
    contentSessionId: 'test-session',
    memorySessionId: 'mem-session-123',
    project: 'home-infra',
    platformSource: 'claude',
    userPrompt: 'test prompt',
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
    ...overrides,
  } as ActiveSession;
}

class ThrowingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'Gemini';
  protected readonly syntheticIdPrefix = 'gemini';
  protected readonly forwardEmptyMessageResponse = false;

  constructor(private readonly toThrow: unknown) {
    super({} as DatabaseManager, {
      getMessageIterator: async function* () { yield* []; },
    } as unknown as SessionManager);
  }

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'gemini-3.1-flash-lite' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(): Promise<ProviderQueryResult> {
    throw this.toThrow;
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

async function runAndCatch(error: unknown, session: ActiveSession): Promise<void> {
  const provider = new ThrowingProvider(error);
  await provider.startSession(session).catch(() => {
    // Rethrowing is the contract; this test is about what happened on the way out.
  });
}

/** The error withRetry itself throws when a request outlives its per-attempt deadline. */
function expiredDeadlineError(): Promise<unknown> {
  return withRetry(
    signal => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
    }),
    { label: 'Gemini gemini-3.1-flash-lite', perAttemptTimeoutMs: 20, maxRetries: 0 },
  ).catch((error: unknown) => error);
}

let modeSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  modeSpy = spyOn(ModeManager, 'getInstance').mockReturnValue({
    getActiveMode: () => mockMode,
  } as unknown as ModeManager);
});

afterEach(() => {
  modeSpy.mockRestore();
});

describe('reactive provider errors set a preserving abortReason (#3700)', () => {
  it('marks a real 429 as a quota pause', async () => {
    const session = makeSession();

    await runAndCatch(
      new ClassifiedProviderError('Gemini quota exhausted (status 429)', {
        kind: 'quota_exhausted',
        cause: null,
      }),
      session,
    );

    expect(session.abortReason).toBe('quota:quota_exhausted');
  });

  it('marks a rate_limit the same way', async () => {
    const session = makeSession();

    await runAndCatch(
      new ClassifiedProviderError('rate limited', { kind: 'rate_limit', cause: null }),
      session,
    );

    expect(session.abortReason).toBe('quota:rate_limit');
  });

  it('marks an invalid credential as an auth pause', async () => {
    const session = makeSession();

    await runAndCatch(
      new ClassifiedProviderError('invalid api key', { kind: 'auth_invalid', cause: null }),
      session,
    );

    expect(session.abortReason).toBe('auth:auth_invalid');
  });

  // A network fault that outlived the retry policy; finalizing on it dropped the
  // session's buffered work.
  it('marks a transient failure as a transport pause', async () => {
    const session = makeSession();

    await runAndCatch(
      new ClassifiedProviderError('OpenRouter network error: socket hang up', {
        kind: 'transient',
        cause: null,
      }),
      session,
    );

    expect(session.abortReason).toBe('transport:transient');
    expect(session.abortController.signal.aborted).toBe(true);
  });

  // Our own per-attempt deadline is a transport pause too, but a distinct one:
  // booked as a generic transient it was invisible in telemetry and health.
  it('marks an expired per-attempt deadline as its own transport pause', async () => {
    const session = makeSession();

    await runAndCatch(await expiredDeadlineError(), session);

    expect(session.abortReason).toBe(`transport:${DEADLINE_EXCEEDED_CODE}`);
    expect(session.abortController.signal.aborted).toBe(true);
  });

  // The categories that genuinely are fatal must keep finalizing, or a broken
  // session would linger forever instead of being cleaned up.
  it('leaves genuinely unrecoverable errors without a preserving reason', async () => {
    const session = makeSession();

    await runAndCatch(
      new ClassifiedProviderError('bad request', { kind: 'unrecoverable', cause: null }),
      session,
    );

    expect(session.abortReason ?? null).toBeNull();
  });

  it('leaves unclassified errors alone', async () => {
    const session = makeSession();

    await runAndCatch(new Error('something else entirely'), session);

    expect(session.abortReason ?? null).toBeNull();
  });

  // Review on #3760: labelling without aborting leaves the controller live
  // while the error unwinds, so the session route books an observer failure
  // and an error outcome before finalization books the aborted one — a pause
  // recorded as a failure, twice.
  it('aborts the controller so the pause is not also booked as a failure', async () => {
    const session = makeSession();

    await runAndCatch(
      new ClassifiedProviderError('Gemini quota exhausted (status 429)', {
        kind: 'quota_exhausted',
        cause: null,
      }),
      session,
    );

    expect(session.abortController.signal.aborted).toBe(true);
  });

  it('leaves the controller alone for a genuinely fatal error', async () => {
    const session = makeSession();

    await runAndCatch(
      new ClassifiedProviderError('bad request', { kind: 'unrecoverable', cause: null }),
      session,
    );

    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('still rethrows so the caller sees the failure', async () => {
    const provider = new ThrowingProvider(
      new ClassifiedProviderError('Gemini quota exhausted (status 429)', {
        kind: 'quota_exhausted',
        cause: null,
      }),
    );

    await expect(provider.startSession(makeSession())).rejects.toThrow(/quota exhausted/);
  });
});

/**
 * The reason only matters because of what handleGeneratorExit does with it —
 * assert the whole path rather than the string in isolation.
 */
describe('the reason actually reaches handleGeneratorExit (#3700)', () => {
  function buildDeps() {
    const finalizeSession = mock(() => Promise.resolve());
    const removeSessionImmediate = mock(() => {});
    return {
      deps: {
        sessionManager: {
          getMessageBuffer: () => ({ getPendingCount: () => 4 }),
          removeSessionImmediate,
        } as unknown as SessionManager,
        completionHandler: { finalizeSession } as unknown as SessionCompletionHandler,
      },
      finalizeSession,
      removeSessionImmediate,
    };
  }

  it('preserves buffered work for a reactive quota exit', async () => {
    const session = makeSession();
    await runAndCatch(
      new ClassifiedProviderError('Gemini quota exhausted (status 429)', {
        kind: 'quota_exhausted',
        cause: null,
      }),
      session,
    );

    const { deps, finalizeSession, removeSessionImmediate } = buildDeps();
    await handleGeneratorExit(session, session.abortReason, deps);

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSessionImmediate).not.toHaveBeenCalled();
  });

  it('preserves buffered work for a per-attempt deadline exit', async () => {
    const session = makeSession();
    await runAndCatch(await expiredDeadlineError(), session);

    const { deps, finalizeSession, removeSessionImmediate } = buildDeps();
    await handleGeneratorExit(session, session.abortReason, deps);

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(removeSessionImmediate).not.toHaveBeenCalled();
  });

  // The exact failure the reporter logged: `Generator exited — finalizing
  // session {reason=null}`, ten times over fifteen minutes.
  it('finalizes when the reason is null, which is what the bug produced', async () => {
    const { deps, finalizeSession } = buildDeps();
    await handleGeneratorExit(makeSession(), null, deps);

    expect(finalizeSession).toHaveBeenCalledWith(382);
  });
});

/**
 * Since #4125 a deadline expiry is a quiet pause. SessionRoutes booked it as an
 * aborted turn with abort_reason 'none' and never touched the health ledger, so
 * a backend slower than the deadline — every request abandoned, possibly after
 * being billed upstream — looked exactly like ordinary idle aborts.
 */
describe('a deadline pause stays visible in telemetry and observer health', () => {
  const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
  let ledgerBefore: string | null;

  // The ledger is shared by every test in the run; leave it as we found it.
  beforeEach(() => {
    ledgerBefore = existsSync(healthPath) ? readFileSync(healthPath, 'utf-8') : null;
  });

  afterEach(() => {
    if (ledgerBefore === null) rmSync(healthPath, { force: true });
    else writeFileSync(healthPath, ledgerBefore);
  });

  it('books a distinct abort reason and a classified health failure, exactly once', async () => {
    const session = makeSession();
    const finalizeSession = mock(() => Promise.resolve());
    const routes = new SessionRoutes(
      {
        getMessageBuffer: () => ({ getPendingCount: () => 1 }),
        removeSessionImmediate: mock(() => {}),
      } as unknown as SessionManager,
      {} as never,
      {} as never,
      new ThrowingProvider(await expiredDeadlineError()) as never,
      {} as never,
      {} as never,
      {} as never,
      { finalizeSession } as unknown as SessionCompletionHandler,
    );
    const priorFailures = readObserverHealth(healthPath)?.consecutiveFailures ?? 0;
    const telemetrySpy = spyOn(telemetryBuffer, 'record').mockImplementation(() => {});

    let turns: Record<string, unknown>[];
    try {
      // Straight to the generator run: provider selection reads real settings
      // and is not what this test is about.
      await (routes as unknown as {
        startGeneratorWithProvider(s: ActiveSession, p: string, src: string, q: null, g: null): Promise<void>;
      }).startGeneratorWithProvider(session, 'gemini', 'observation', null, null);
      await session.generatorPromise;
      turns = telemetrySpy.mock.calls
        .filter(([event, id]) => event === 'session_compressed' && id === session.sessionDbId)
        .map(([, , props]) => props as Record<string, unknown>);
    } finally {
      telemetrySpy.mockRestore();
    }

    // One aborted turn with its own reason — never also an error outcome.
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      outcome: 'aborted',
      abort_reason: DEADLINE_EXCEEDED_CODE,
      provider: 'gemini',
    });

    const health = readObserverHealth(healthPath)!;
    expect(health.consecutiveFailures).toBe(priorFailures + 1);
    expect(health.lastErrorProvider).toBe('gemini');
    expect(health.lastErrorKind).toBe('transient');
    expect(health.lastErrorCode).toBe(DEADLINE_EXCEEDED_CODE);
    expect(health.lastErrorMessage).toContain('per-attempt deadline');
    expect(health.lastErrorAction).toContain('CLAUDE_MEM_LLM_TIMEOUT_MS');

    // Still a pause: the buffered work survives for the next generator.
    expect(finalizeSession).not.toHaveBeenCalled();
  });
});
