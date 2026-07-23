import { describe, it, expect, beforeEach } from 'bun:test';
import {
  guardEmptyMessageResponse,
  MAX_CONSECUTIVE_EMPTY_RESPONSES,
} from '../../src/services/worker/OpenAICompatibleProvider';
import type { ActiveSession } from '../../src/services/worker-types';
import type { SessionManager } from '../../src/services/worker/SessionManager';

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'content-1',
    memorySessionId: 'mem-1',
    project: 'test-project',
    platformSource: 'claude-code',
    userPrompt: 'prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: 12345,
    claimedMessageIds: [10, 11],
    conversationHistory: [],
    currentProvider: 'gemini',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveEmptyResponses: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  } as ActiveSession;
}

function makeSessionManager() {
  const calls: number[] = [];
  const sessionManager = {
    confirmClaimedMessages: async (sessionDbId: number) => {
      calls.push(sessionDbId);
      return 0;
    },
  } as unknown as SessionManager;
  return { sessionManager, calls };
}

describe('guardEmptyMessageResponse', () => {
  let session: ActiveSession;

  beforeEach(() => {
    session = makeSession();
  });

  it('leaves the queue intact below the threshold', async () => {
    const { sessionManager, calls } = makeSessionManager();

    for (let i = 1; i < MAX_CONSECUTIVE_EMPTY_RESPONSES; i++) {
      await guardEmptyMessageResponse(session, sessionManager, 'Gemini', 'observation');
      expect(session.consecutiveEmptyResponses).toBe(i);
      expect(calls.length).toBe(0);
      expect(session.earliestPendingTimestamp).toBe(12345);
    }
  });

  it('drops the claimed batch once the threshold is reached', async () => {
    const { sessionManager, calls } = makeSessionManager();
    session.consecutiveEmptyResponses = MAX_CONSECUTIVE_EMPTY_RESPONSES - 1;

    await guardEmptyMessageResponse(session, sessionManager, 'Gemini', 'summary');

    expect(calls).toEqual([1]);
    expect(session.earliestPendingTimestamp).toBeNull();
    // Counter resets so the next batch gets a fresh allowance.
    expect(session.consecutiveEmptyResponses).toBe(0);
  });

  it('tolerates sessions created before the counter existed', async () => {
    const { sessionManager, calls } = makeSessionManager();
    delete (session as { consecutiveEmptyResponses?: number }).consecutiveEmptyResponses;

    await guardEmptyMessageResponse(session, sessionManager, 'Gemini', 'observation');

    expect(session.consecutiveEmptyResponses).toBe(1);
    expect(calls.length).toBe(0);
  });
});
