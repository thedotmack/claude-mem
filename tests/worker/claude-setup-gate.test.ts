import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import {
  CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS,
  getDependencyStatus,
  resetDependencyStatusesForTesting,
} from '../../src/shared/dependency-health.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

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
    pendingMessages: [],
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
    findClaudeExecutableImpl = () => '/mock/claude';
    Date.now = realDateNow;
  });

  afterEach(() => {
    Date.now = realDateNow;
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
});
