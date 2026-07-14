import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import {
  CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS,
  getDependencyStatus,
  resetDependencyStatusesForTesting,
} from '../../src/shared/dependency-health.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import {
  CLAUDE_QUOTA_RETRY_MS,
  globalRateLimitStore,
} from '../../src/services/worker/RateLimitStore.js';

let findClaudeExecutableImpl: () => string = () => '/mock/claude';

mock.module('../../src/shared/find-claude-executable.js', () => ({
  findClaudeExecutable: () => findClaudeExecutableImpl(),
}));

const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');
const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

function makeSession(): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: 'content-42',
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

describe('Claude setup-required generator gate', () => {
  const realDateNow = Date.now;

  beforeEach(() => {
    resetDependencyStatusesForTesting();
    globalRateLimitStore.clearClaudeSpawnBlock();
    findClaudeExecutableImpl = () => '/mock/claude';
    Date.now = realDateNow;
  });

  afterEach(() => {
    Date.now = realDateNow;
    globalRateLimitStore.clearClaudeSpawnBlock();
  });

  it('skips immediate repeat starts, then rechecks and clears status after cooldown repair', async () => {
    const session = makeSession();
    let activeSession: ActiveSession | undefined = session;
    let starts = 0;
    let findAttempts = 0;
    let finalizerCalls = 0;
    let removeSessionImmediateCalls = 0;
    let repairedRunResolve: (() => void) | null = null;

    const sessionManager = {
      getSession: () => activeSession,
      getMessageBuffer: () => ({
        getPendingCount: () => 1,
        peekTypes: () => [],
      }),
      removeSessionImmediate: () => {
        removeSessionImmediateCalls += 1;
        activeSession = undefined;
      },
    };

    const claudeProvider = {
      startSession: async () => {
        starts += 1;
        if (starts === 1) {
          throw new ClassifiedProviderError('Claude executable not found', {
            kind: 'setup_required',
            cause: new Error('Claude executable not found'),
          });
        }
        await new Promise<void>(resolve => {
          repairedRunResolve = resolve;
        });
      },
    };

    const routes = new SessionRoutes(
      sessionManager as any,
      {} as any,
      claudeProvider as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      {} as any,
      {} as any,
      {
        finalizeSession: async () => {
          finalizerCalls += 1;
        },
      } as any,
    );

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    await session.generatorPromise;

    expect(starts).toBe(1);
    expect(getDependencyStatus('claude_cli')).toMatchObject({
      kind: 'setup_required',
      remediation: expect.stringContaining('Claude Code CLI'),
    });
    expect(activeSession).toBe(session);
    expect(session.generatorPromise).toBeNull();
    expect(finalizerCalls).toBe(0);
    expect(removeSessionImmediateCalls).toBe(0);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');

    expect(starts).toBe(1);
    expect(findAttempts).toBe(0);
    expect(finalizerCalls).toBe(0);
    expect(removeSessionImmediateCalls).toBe(0);

    findClaudeExecutableImpl = () => {
      findAttempts += 1;
      return '/repaired/claude';
    };
    Date.now = () => realDateNow() + CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS + 1;

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');

    expect(findAttempts).toBe(1);
    expect(starts).toBe(2);
    expect(getDependencyStatus('claude_cli')).toBeNull();
    expect(session.generatorPromise).not.toBeNull();

    repairedRunResolve?.();
    await session.generatorPromise;

    expect(finalizerCalls).toBe(1);
    expect(removeSessionImmediateCalls).toBe(1);
  });

  it('records Claude CLI remediation when provider startup cannot find the executable', async () => {
    findClaudeExecutableImpl = () => {
      throw new Error('Claude executable not found');
    };

    const provider = new ClaudeProvider({} as any, {} as any);

    await expect(provider.startSession(makeSession())).rejects.toThrow('Claude executable not found');
    expect(getDependencyStatus('claude_cli')).toMatchObject({
      kind: 'setup_required',
      remediation: expect.stringContaining('Claude Code CLI'),
    });
  });

  it('converts a direct Claude rate-limit error into a quota pause', async () => {
    const session = makeSession();
    const resetProcessingToPending = mock(() => Promise.resolve(1));
    const removeSessionImmediate = mock(() => {});
    const finalizeSession = mock(() => Promise.resolve());
    const sessionManager = {
      getSession: () => session,
      getMessageBuffer: () => ({
        getPendingCount: () => 1,
        peekTypes: () => [],
      }),
      resetProcessingToPending,
      removeSessionImmediate,
    };
    const claudeProvider = {
      startSession: async () => {
        throw new ClassifiedProviderError('rate limited', {
          kind: 'rate_limit',
          cause: new Error('rate limited'),
          retryAfterMs: 30 * 60 * 1000,
        });
      },
    };
    const routes = new SessionRoutes(
      sessionManager as any,
      {} as any,
      claudeProvider as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      {} as any,
      {} as any,
      { finalizeSession } as any,
    );

    await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
    const run = session.generatorPromise;
    expect(run).not.toBeNull();
    await run;

    expect(resetProcessingToPending).toHaveBeenCalledWith(session.sessionDbId);
    expect(globalRateLimitStore.getClaudeSpawnBlock()).toMatchObject({
      blocked: true,
      reason: 'provider_error:rate_limit',
    });
    expect(session.abortController.signal.aborted).toBe(true);
    expect(session.generatorPromise).toBeNull();
    expect(removeSessionImmediate).not.toHaveBeenCalled();
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it('keeps queued sessions stopped during quota cooldown and admits one probe afterward', async () => {
    const first = makeSession();
    const second = { ...makeSession(), sessionDbId: 43, contentSessionId: 'content-43' };
    const sessions = new Map<number, ActiveSession>([
      [first.sessionDbId, first],
      [second.sessionDbId, second],
    ]);
    let starts = 0;

    const sessionManager = {
      getSession: (sessionDbId: number) => sessions.get(sessionDbId),
      getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    };
    const claudeProvider = {
      startSession: () => {
        starts += 1;
        return new Promise<void>(() => {});
      },
    };
    const routes = new SessionRoutes(
      sessionManager as any,
      {} as any,
      claudeProvider as any,
      { startSession: async () => {} } as any,
      { startSession: async () => {} } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const blockedAt = 1_700_000_000_000;
    const retryAt = blockedAt + CLAUDE_QUOTA_RETRY_MS;
    Date.now = () => blockedAt;
    globalRateLimitStore.blockClaudeSpawns('observer_text', retryAt);

    await routes.ensureGeneratorRunning(first.sessionDbId, 'observation');
    expect(starts).toBe(0);
    expect(first.generatorPromise).toBeNull();

    Date.now = () => retryAt;
    await routes.ensureGeneratorRunning(first.sessionDbId, 'observation');
    await routes.ensureGeneratorRunning(second.sessionDbId, 'observation');

    expect(starts).toBe(1);
    expect(first.generatorPromise).not.toBeNull();
    expect(typeof first.quotaProbeToken).toBe('number');
    expect(second.generatorPromise).toBeNull();
  });
});
