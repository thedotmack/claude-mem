import { describe, it, expect, beforeEach, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';

// Mock modules that cause import chain issues
vi.mock('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

vi.mock('../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

vi.mock('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [],
        observation_concepts: [],
      }),
    }),
  },
}));

import { OpenAICompatAgent } from '../../src/services/worker/OpenAICompatAgent.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';

/** Type-safe accessor for private compactHistory method */
interface AgentWithCompactHistory {
  compactHistory(session: ActiveSession): void;
}

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof vi.spyOn>[] = [];

function makeHistory(count: number): ConversationMessage[] {
  const history: ConversationMessage[] = [];
  // First message is always user (init prompt)
  history.push({ role: 'user', content: 'INIT_PROMPT: You are the memory observer agent...' });
  // Alternate user/assistant for remaining messages
  for (let i = 1; i < count; i++) {
    const role = i % 2 === 1 ? 'assistant' : 'user';
    history.push({ role, content: `Message ${i} (${role})` });
  }
  return history;
}

function makeSession(historyCount: number): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'test-content-session',
    memorySessionId: 'test-memory-session-id',
    project: 'test-project',
    userPrompt: 'test prompt',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: makeHistory(historyCount),
    currentProvider: 'openai-compat',
  };
}

describe('OpenAICompatAgent.compactHistory', () => {
  let agent: OpenAICompatAgent;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let mockGetSummaryForSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
      vi.spyOn(logger, 'success').mockImplementation(() => {}),
    ];

    mockGetSummaryForSession = vi.fn(() => ({
      request: 'Fix the auth bug',
      investigated: 'auth service',
      learned: 'Token expiry issue',
      completed: 'Fixed refresh logic',
      next_steps: 'Add tests',
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 2,
      created_at: '2026-01-01',
      created_at_epoch: 1000,
    }));

    mockDbManager = {
      getSessionStore: () => ({
        getSummaryForSession: mockGetSummaryForSession,
      }),
    } as unknown as DatabaseManager;

    mockSessionManager = {} as unknown as SessionManager;

    agent = new OpenAICompatAgent(mockDbManager, mockSessionManager);
  });

  it('should not compact when history is at or below threshold', () => {
    const session = makeSession(14); // Exactly at threshold
    const originalHistory = [...session.conversationHistory];

    // Access private method
    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    expect(session.conversationHistory.length).toBe(14);
    expect(session.conversationHistory).toEqual(originalHistory);
    expect(mockGetSummaryForSession).not.toHaveBeenCalled();
  });

  it('should not compact when history is well below threshold', () => {
    const session = makeSession(4);
    const originalLength = session.conversationHistory.length;

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    expect(session.conversationHistory.length).toBe(originalLength);
  });

  it('should compact when history exceeds threshold', () => {
    const session = makeSession(20);

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    // Should be: init(1) + summary(1) + recent(6) = 8
    expect(session.conversationHistory.length).toBe(8);
  });

  it('should preserve the init prompt as first message', () => {
    const session = makeSession(20);
    const initPrompt = session.conversationHistory[0];

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    expect(session.conversationHistory[0]).toEqual(initPrompt);
    expect(session.conversationHistory[0].content).toContain('INIT_PROMPT');
  });

  it('should inject summary context as second message', () => {
    const session = makeSession(20);

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    const summaryMsg = session.conversationHistory[1];
    expect(summaryMsg.role).toBe('user');
    expect(summaryMsg.content).toContain('<session_context>');
    expect(summaryMsg.content).toContain('<summary>');
    expect(summaryMsg.content).toContain('Fix the auth bug');
  });

  it('should keep the last 6 messages as recent context', () => {
    const session = makeSession(20);
    const last6 = session.conversationHistory.slice(-6);

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    const recentAfterCompact = session.conversationHistory.slice(2); // Skip init + summary
    expect(recentAfterCompact).toEqual(last6);
  });

  it('should read summary from DB using memorySessionId', () => {
    const session = makeSession(20);
    session.memorySessionId = 'my-specific-session-id';

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    expect(mockGetSummaryForSession).toHaveBeenCalledWith('my-specific-session-id');
  });

  it('should handle null memorySessionId gracefully', () => {
    const session = makeSession(20);
    session.memorySessionId = null;

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    // Should still compact, just with empty summary context
    expect(session.conversationHistory.length).toBe(8);
    expect(mockGetSummaryForSession).not.toHaveBeenCalled();
    expect(session.conversationHistory[1].content).toContain('No summary exists yet');
  });

  it('should handle DB error gracefully with empty summary context', () => {
    mockGetSummaryForSession = vi.fn(() => {
      throw new Error('Database is locked');
    });
    mockDbManager = {
      getSessionStore: () => ({
        getSummaryForSession: mockGetSummaryForSession,
      }),
    } as unknown as DatabaseManager;
    agent = new OpenAICompatAgent(mockDbManager, mockSessionManager);

    const session = makeSession(20);

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    // Should still compact, using empty summary
    expect(session.conversationHistory.length).toBe(8);
    expect(session.conversationHistory[1].content).toContain('No summary exists yet');
  });

  it('should handle no existing summary in DB', () => {
    mockGetSummaryForSession = vi.fn(() => null);
    mockDbManager = {
      getSessionStore: () => ({
        getSummaryForSession: mockGetSummaryForSession,
      }),
    } as unknown as DatabaseManager;
    agent = new OpenAICompatAgent(mockDbManager, mockSessionManager);

    const session = makeSession(16);

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    expect(session.conversationHistory.length).toBe(8);
    expect(session.conversationHistory[1].content).toContain('No summary exists yet');
  });

  it('should discard the old summary context on repeated compaction', () => {
    const session = makeSession(20);

    // First compaction
    (agent as unknown as AgentWithCompactHistory).compactHistory(session);
    expect(session.conversationHistory.length).toBe(8);
    expect(session.conversationHistory[1].content).toContain('Fix the auth bug');

    // Simulate adding more messages to exceed threshold again
    for (let i = 0; i < 10; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      session.conversationHistory.push({ role, content: `New message ${i}` });
    }
    expect(session.conversationHistory.length).toBe(18);

    // Update the mock to return an updated summary
    mockGetSummaryForSession = vi.fn(() => ({
      request: 'Fix the auth bug',
      investigated: 'auth service and session store',
      learned: 'Token expiry and refresh both broken',
      completed: 'Fixed refresh and extended TTL',
      next_steps: 'Deploy and monitor',
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 5,
      created_at: '2026-01-01',
      created_at_epoch: 2000,
    }));
    (mockDbManager as unknown as { getSessionStore: () => { getSummaryForSession: typeof mockGetSummaryForSession } }).getSessionStore = () => ({
      getSummaryForSession: mockGetSummaryForSession,
    });

    // Second compaction
    (agent as unknown as AgentWithCompactHistory).compactHistory(session);
    expect(session.conversationHistory.length).toBe(8);

    // The old summary context should be gone, replaced by updated one
    expect(session.conversationHistory[1].content).toContain('Deploy and monitor');
    expect(session.conversationHistory[0].content).toContain('INIT_PROMPT');
  });

  it('should log compaction details', () => {
    const session = makeSession(20);

    (agent as unknown as AgentWithCompactHistory).compactHistory(session);

    const infoCall = loggerSpies[0]; // logger.info
    expect(infoCall).toHaveBeenCalled();
    // Find the compaction log call
    const calls = infoCall.mock.calls;
    const compactCall = calls.find((c: unknown[]) => c[1] === 'Compacted history');
    expect(compactCall).toBeTruthy();
    expect(compactCall![2]).toEqual({
      sessionId: 1,
      before: 20,
      after: 8,
      keptRecent: 6,
    });
  });
});
