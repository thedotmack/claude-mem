/**
 * OpenCodeAgent Tests
 *
 * Tests for the OpenCode SDK-based agent that handles memory extraction
 * via an OpenCode server. Follows the same pattern as gemini_agent.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { logger } from '../src/utils/logger.js';

// Mock modules that cause import chain issues - MUST be before imports
mock.module('../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

// Mock the ModeManager
const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'obs prompt',
    summary: 'summary prompt',
  },
  observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
  observation_concepts: [],
};

mock.module('../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    }),
  },
}));

// Mock the OpenCode SDK client
let mockSessionCreate: ReturnType<typeof mock>;
let mockSessionPrompt: ReturnType<typeof mock>;

mock.module('@opencode-ai/sdk/client', () => ({
  createOpencodeClient: () => ({
    session: {
      get create() { return mockSessionCreate; },
      get prompt() { return mockSessionPrompt; },
    },
  }),
}));

// Import after mocks
import { OpenCodeAgent, isOpenCodeSelected, isOpenCodeAvailable } from '../src/services/worker/OpenCodeAgent';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';
import type { DatabaseManager } from '../src/services/worker/DatabaseManager';
import type { SessionManager } from '../src/services/worker/SessionManager';
import type { ActiveSession } from '../src/services/worker-types';

// Spy on logger to suppress output
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let loadFromFileSpy: ReturnType<typeof spyOn>;

describe('OpenCodeAgent', () => {
  let agent: OpenCodeAgent;
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockStoreSummary: ReturnType<typeof mock>;
  let mockUpdateMemorySessionId: ReturnType<typeof mock>;
  let mockEnsureMemorySessionIdRegistered: ReturnType<typeof mock>;
  let mockSyncObservation: ReturnType<typeof mock>;
  let mockSyncSummary: ReturnType<typeof mock>;
  let mockMarkProcessed: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    // Suppress logger output
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'success').mockImplementation(() => {}),
    ];

    // Mock SettingsDefaultsManager
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENCODE_BASE_URL: 'http://127.0.0.1:4096',
      CLAUDE_MEM_OPENCODE_MODE: 'sdk_agent',
      CLAUDE_MEM_PROVIDER: 'opencode',
    }));

    // Reset SDK mocks
    mockSessionCreate = mock(() => Promise.resolve({ data: { id: 'oc-session-abc' } }));
    mockSessionPrompt = mock(() => Promise.resolve({
      data: { parts: [{ type: 'text', text: '<observation><type>discovery</type><title>Test</title></observation>' }] },
    }));

    // DB mocks
    mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: 1,
      createdAtEpoch: Date.now(),
    }));
    mockStoreSummary = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockUpdateMemorySessionId = mock(() => {});
    mockEnsureMemorySessionIdRegistered = mock(() => {});
    mockSyncObservation = mock(() => Promise.resolve());
    mockSyncSummary = mock(() => Promise.resolve());
    mockMarkProcessed = mock(() => {});

    mockDbManager = {
      getSessionStore: () => ({
        storeObservation: mock(() => ({ id: 1, createdAtEpoch: Date.now() })),
        storeObservations: mockStoreObservations,
        storeSummary: mockStoreSummary,
        updateMemorySessionId: mockUpdateMemorySessionId,
        ensureMemorySessionIdRegistered: mockEnsureMemorySessionIdRegistered,
        getSessionById: mock(() => ({ memory_session_id: 'opencode-sdk:oc-session-abc' })),
        markSessionCompleted: mock(() => {}),
      }),
      getChromaSync: () => ({
        syncObservation: mockSyncObservation,
        syncSummary: mockSyncSummary,
      }),
    } as unknown as DatabaseManager;

    mockSessionManager = {
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => ({
        markProcessed: mockMarkProcessed,
        confirmProcessed: mock(() => {}),
        cleanupProcessed: mock(() => 0),
        resetStuckMessages: mock(() => 0),
      }),
    } as unknown as SessionManager;

    agent = new OpenCodeAgent(mockDbManager, mockSessionManager);
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    mock.restore();
  });

  function createSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
    return {
      sessionDbId: 1,
      contentSessionId: 'test-session-oc',
      memorySessionId: null,
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      earliestPendingTimestamp: null,
      currentProvider: null,
      startTime: Date.now(),
      processingMessageIds: [],
      consecutiveRestarts: 0,
      ...overrides,
    } as any;
  }

  describe('startSession', () => {
    it('creates an OpenCode session and sends init prompt', async () => {
      const session = createSession();
      await agent.startSession(session);

      expect(mockSessionCreate).toHaveBeenCalledTimes(1);
      expect(mockSessionPrompt).toHaveBeenCalledTimes(1);
      expect(session.memorySessionId).toBe('opencode-sdk:oc-session-abc');
    });

    it('reuses existing OpenCode session when memorySessionId is set', async () => {
      const session = createSession({ memorySessionId: 'opencode-sdk:existing-id' } as any);
      await agent.startSession(session);

      // Should NOT create a new session
      expect(mockSessionCreate).not.toHaveBeenCalled();
      // Should still send prompt
      expect(mockSessionPrompt).toHaveBeenCalledTimes(1);
    });

    it('updates memorySessionId in database after session creation', async () => {
      const session = createSession();
      await agent.startSession(session);

      expect(mockUpdateMemorySessionId).toHaveBeenCalledWith(1, 'opencode-sdk:oc-session-abc');
    });

    it('uses continuation prompt for promptNumber > 1', async () => {
      const session = createSession({ lastPromptNumber: 3 } as any);
      await agent.startSession(session);

      // Prompt should have been sent (we verify it ran without error)
      expect(mockSessionPrompt).toHaveBeenCalledTimes(1);
      expect(session.conversationHistory.length).toBeGreaterThanOrEqual(2);
    });

    it('adds user and assistant messages to conversation history', async () => {
      const session = createSession();
      await agent.startSession(session);
      // Init creates session + sends prompt, so at least 2 entries
      expect(session.conversationHistory.length).toBeGreaterThanOrEqual(2);
      expect(session.conversationHistory[0].role).toBe('user');
      expect(session.conversationHistory[1].role).toBe('assistant');
    });
  });

  describe('error handling', () => {
    it('throws when session creation returns no id', async () => {
      mockSessionCreate = mock(() => Promise.resolve({ data: {} }));
      const session = createSession();
      await expect(agent.startSession(session)).rejects.toThrow('did not return a session id');
    });

    it('skips processing on empty response text', async () => {
      mockSessionPrompt = mock(() => Promise.resolve({ data: { parts: [] } }));
      const session = createSession();
      await agent.startSession(session);
      // Only user message added, no assistant message for empty response
      expect(session.conversationHistory.length).toBe(1);
      expect(session.conversationHistory[0].role).toBe('user');
    });

    it('falls back to Claude SDK when fallback agent is set and error matches', async () => {
      const mockFallbackStartSession = mock(() => Promise.resolve());
      agent.setFallbackAgent({ startSession: mockFallbackStartSession } as any);
      mockSessionCreate = mock(() => Promise.reject(new Error('ECONNREFUSED: connection refused')));
      const session = createSession();
      await agent.startSession(session);
      expect(mockFallbackStartSession).toHaveBeenCalled();
    });

    it('throws when no fallback agent and error occurs', async () => {
      mockSessionCreate = mock(() => Promise.reject(new Error('network failure')));
      const session = createSession();
      await expect(agent.startSession(session)).rejects.toThrow('network failure');
    });
  });
  describe('response parsing', () => {
    it('extracts text from data.parts array', async () => {
      mockSessionPrompt = mock(() => Promise.resolve({
        data: { parts: [{ type: 'text', text: 'hello world' }] },
      }));
      const session = createSession();
      await agent.startSession(session);
      expect(session.conversationHistory[1].content).toBe('hello world');
    });

    it('joins multiple text parts with newline', async () => {
      mockSessionPrompt = mock(() => Promise.resolve({
        data: { parts: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] },
      }));
      const session = createSession();
      await agent.startSession(session);
      expect(session.conversationHistory[1].content).toBe('part1\npart2');
    });

    it('falls back to root.parts when data.parts is missing', async () => {
      mockSessionPrompt = mock(() => Promise.resolve({
        parts: [{ type: 'text', text: 'root level' }],
      }));
      const session = createSession();
      await agent.startSession(session);
      expect(session.conversationHistory[1].content).toBe('root level');
    });

    it('falls back to data.info.text when no parts', async () => {
      mockSessionPrompt = mock(() => Promise.resolve({
        data: { info: { text: 'info fallback' } },
      }));
      const session = createSession();
      await agent.startSession(session);
      expect(session.conversationHistory[1].content).toBe('info fallback');
    });

    it('extracts session id from data.id', async () => {
      mockSessionCreate = mock(() => Promise.resolve({ data: { id: 'from-data' } }));
      const session = createSession();
      await agent.startSession(session);
      expect(session.memorySessionId).toBe('opencode-sdk:from-data');
    });

    it('extracts session id from root.id as fallback', async () => {
      mockSessionCreate = mock(() => Promise.resolve({ id: 'from-root' }));
      const session = createSession();
      await agent.startSession(session);
      expect(session.memorySessionId).toBe('opencode-sdk:from-root');
    });
  });
  describe('message iterator processing', () => {
    it('processes observation messages from iterator', async () => {
      const observationMessage = {
        _persistentId: 'msg-1',
        type: 'observation' as const,
        tool_name: 'read_file',
        tool_input: { path: '/src/main.ts' },
        tool_response: { content: 'file contents' },
        prompt_number: 1,
        cwd: '/project',
      };
      mockSessionManager = {
        getMessageIterator: async function* () { yield observationMessage; },
        getPendingMessageStore: () => ({
          markProcessed: mockMarkProcessed,
          confirmProcessed: mock(() => {}),
          cleanupProcessed: mock(() => 0),
          resetStuckMessages: mock(() => 0),
        }),
      } as unknown as SessionManager;
      agent = new OpenCodeAgent(mockDbManager, mockSessionManager);
      const session = createSession();
      await agent.startSession(session);
      // Init prompt + observation prompt = 2 calls
      expect(mockSessionPrompt).toHaveBeenCalledTimes(2);
    });
    it('processes summarize messages from iterator', async () => {
      const summarizeMessage = {
        _persistentId: 'msg-2',
        type: 'summarize' as const,
        last_assistant_message: 'I helped fix a bug',
        prompt_number: 1,
      };
      mockSessionManager = {
        getMessageIterator: async function* () { yield summarizeMessage; },
        getPendingMessageStore: () => ({
          markProcessed: mockMarkProcessed,
          confirmProcessed: mock(() => {}),
          cleanupProcessed: mock(() => 0),
          resetStuckMessages: mock(() => 0),
        }),
      } as unknown as SessionManager;
      agent = new OpenCodeAgent(mockDbManager, mockSessionManager);
      const session = createSession({ memorySessionId: 'opencode-sdk:oc-session-abc' } as any);
      await agent.startSession(session);
      // Init prompt + summary prompt = 2 calls
      expect(mockSessionPrompt).toHaveBeenCalledTimes(2);
    });
  });
  describe('isOpenCodeSelected', () => {
    it('returns true when provider is opencode', () => {
      expect(isOpenCodeSelected()).toBe(true);
    });
    it('returns false when provider is claude', () => {
      loadFromFileSpy.mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_PROVIDER: 'claude',
      }));
      expect(isOpenCodeSelected()).toBe(false);
    });
  });

  describe('isOpenCodeAvailable', () => {
    it('always returns true', () => {
      expect(isOpenCodeAvailable()).toBe(true);
    });
  });
});
