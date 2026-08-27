import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
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

  // The exact failure the reporter logged: `Generator exited — finalizing
  // session {reason=null}`, ten times over fifteen minutes.
  it('finalizes when the reason is null, which is what the bug produced', async () => {
    const { deps, finalizeSession } = buildDeps();
    await handleGeneratorExit(makeSession(), null, deps);

    expect(finalizeSession).toHaveBeenCalledWith(382);
  });
});
