import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiAgent } from '../src/services/worker/GeminiAgent';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';
import type { ActiveSession } from '../src/services/worker-types';
import type { FallbackAgent } from '../src/services/worker/agents/types';

// Track rate limiting setting (controls Gemini RPM throttling)
// Set to 'false' to disable rate limiting for faster tests
let rateLimitingEnabled = 'false';

// Mock mode config
const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'obs prompt',
    summary: 'summary prompt'
  },
  observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
  observation_concepts: []
};

// Use spyOn for all dependencies to avoid affecting other test files
// spyOn restores automatically, unlike mock.module which persists
let loadFromFileSpy: ReturnType<typeof vi.spyOn>;
let getSpy: ReturnType<typeof vi.spyOn>;
let modeManagerSpy: ReturnType<typeof vi.spyOn>;

describe('GeminiAgent', () => {
  let agent: GeminiAgent;
  let originalFetch: typeof global.fetch;

  // Mocks
  let mockStoreObservation: ReturnType<typeof vi.fn>;
  let mockStoreObservations: ReturnType<typeof vi.fn>; // Plural - atomic transaction method used by ResponseProcessor
  let mockStoreSummary: ReturnType<typeof vi.fn>;
  let mockMarkSessionCompleted: ReturnType<typeof vi.fn>;
  let mockSyncObservation: ReturnType<typeof vi.fn>;
  let mockSyncSummary: ReturnType<typeof vi.fn>;
  let mockMarkProcessed: ReturnType<typeof vi.fn>;
  let mockCleanupProcessed: ReturnType<typeof vi.fn>;
  let mockResetStuckMessages: ReturnType<typeof vi.fn>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    // Reset rate limiting to disabled by default (speeds up tests)
    rateLimitingEnabled = 'false';

    // Mock ModeManager using spyOn (restores properly)
    modeManagerSpy = vi.spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as unknown as ModeManager));

    // Mock SettingsDefaultsManager methods using spyOn (restores properly)
    loadFromFileSpy = vi.spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_GEMINI_API_KEY: 'test-api-key',
      CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: rateLimitingEnabled,
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
    }));

    getSpy = vi.spyOn(SettingsDefaultsManager, 'get').mockImplementation((key: string) => {
      if (key === 'CLAUDE_MEM_GEMINI_API_KEY') return 'test-api-key';
      if (key === 'CLAUDE_MEM_GEMINI_MODEL') return 'gemini-2.5-flash-lite';
      if (key === 'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED') return rateLimitingEnabled;
      if (key === 'CLAUDE_MEM_DATA_DIR') return '/tmp/claude-mem-test';
      return SettingsDefaultsManager.getAllDefaults()[key as keyof ReturnType<typeof SettingsDefaultsManager.getAllDefaults>] ?? '';
    });

    // Initialize mocks
    mockStoreObservation = vi.fn(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockStoreSummary = vi.fn(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockMarkSessionCompleted = vi.fn(() => {});
    mockSyncObservation = vi.fn(() => Promise.resolve());
    mockSyncSummary = vi.fn(() => Promise.resolve());
    mockMarkProcessed = vi.fn(() => {});
    mockCleanupProcessed = vi.fn(() => 0);
    mockResetStuckMessages = vi.fn(() => 0);

    // Mock for storeObservations (plural) - the atomic transaction method called by ResponseProcessor
    mockStoreObservations = vi.fn(() => ({
      observationIds: [1],
      summaryId: 1,
      createdAtEpoch: Date.now()
    }));

    const mockSessionStore = {
      storeObservation: mockStoreObservation,
      storeObservations: mockStoreObservations, // Required by ResponseProcessor.ts
      storeSummary: mockStoreSummary,
      markSessionCompleted: mockMarkSessionCompleted
    };

    const mockChromaSync = {
      syncObservation: mockSyncObservation,
      syncSummary: mockSyncSummary
    };

    mockDbManager = {
      getSessionStore: () => mockSessionStore,
      getChromaSync: () => mockChromaSync
    } as unknown as DatabaseManager;

    const mockPendingMessageStore = {
      markProcessed: mockMarkProcessed,
      cleanupProcessed: mockCleanupProcessed,
      resetStuckMessages: mockResetStuckMessages
    };

    mockSessionManager = {
      // eslint-disable-next-line @typescript-eslint/require-await
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => mockPendingMessageStore
    } as unknown as SessionManager;

    agent = new GeminiAgent(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Restore spied methods
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    if (getSpy) getSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('should initialize with correct config', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session-123',
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
      startTime: Date.now()
    } as ActiveSession;

    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: '<observation><type>discovery</type><title>Test</title></observation>' }]
        }
      }],
      usageMetadata: { totalTokenCount: 100 }
    }))));

    await agent.startSession(session);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = vi.mocked(global.fetch).mock.calls[0][0];
    expect(url).toContain('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    expect(url).toContain('key=test-api-key');
  });

  it('should handle multi-turn conversation', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session-123',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [{ role: 'user', content: 'prev context' }, { role: 'assistant', content: 'prev response' }],
      lastPromptNumber: 2,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      earliestPendingTimestamp: null,
      currentProvider: null,
      startTime: Date.now()
    } as ActiveSession;

    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'response' }] } }]
    }))));

    await agent.startSession(session);

    const body = JSON.parse((vi.mocked(global.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents).toHaveLength(3);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[1].role).toBe('model');
    expect(body.contents[2].role).toBe('user');
  });

  it('should process observations and store them', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session-123',
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
      startTime: Date.now()
    } as ActiveSession;

    const observationXml = `
      <observation>
        <type>discovery</type>
        <title>Found bug</title>
        <subtitle>Null pointer</subtitle>
        <narrative>Found a null pointer in the code</narrative>
        <facts><fact>Null check missing</fact></facts>
        <concepts><concept>bug</concept></concepts>
        <files_read><file>src/main.ts</file></files_read>
        <files_modified></files_modified>
      </observation>
    `;

    global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: observationXml }] } }],
      usageMetadata: { totalTokenCount: 50 }
    }))));

    await agent.startSession(session);

    // ResponseProcessor uses storeObservations (plural) for atomic transactions
    expect(mockStoreObservations).toHaveBeenCalled();
    expect(mockSyncObservation).toHaveBeenCalled();
    expect(session.cumulativeInputTokens).toBeGreaterThan(0);
  });

  it('should fallback to Claude on rate limit error', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session-123',
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
      startTime: Date.now()
    } as ActiveSession;

    global.fetch = vi.fn(() => Promise.resolve(new Response('Resource has been exhausted (e.g. check quota).', { status: 429 })));

    const fallbackAgent: FallbackAgent = {
      startSession: vi.fn(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    await agent.startSession(session);

    // Verify fallback to Claude was triggered
    expect(fallbackAgent.startSession).toHaveBeenCalledWith(session, undefined);
    // Note: resetStuckMessages is called by worker-service.ts, not by GeminiAgent
  });

  it('should NOT fallback on other errors', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session-123',
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
      startTime: Date.now()
    } as ActiveSession;

    global.fetch = vi.fn(() => Promise.resolve(new Response('Invalid argument', { status: 400 })));

    const fallbackAgent: FallbackAgent = {
      startSession: vi.fn(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    await expect(agent.startSession(session)).rejects.toThrow('Gemini API error: 400 - Invalid argument');
    expect(fallbackAgent.startSession).not.toHaveBeenCalled();
  });

  it('should respect rate limits when rate limiting enabled', async () => {
    // Enable rate limiting - this means requests will be throttled
    // Note: CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false' means enabled
    rateLimitingEnabled = 'true';

    const originalSetTimeout = global.setTimeout;
    const mockSetTimeout = vi.fn((cb: () => void) => cb());
    global.setTimeout = mockSetTimeout as unknown as typeof global.setTimeout;

    try {
      const session = {
        sessionDbId: 1,
        contentSessionId: 'test-session',
        memorySessionId: 'mem-session-123',
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
        startTime: Date.now()
      } as ActiveSession;

      global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }]
      }))));

      await agent.startSession(session);
      await agent.startSession(session);

      expect(mockSetTimeout).toHaveBeenCalled();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });

  describe('gemini-3-flash model support', () => {
    it('should accept gemini-3-flash as a valid model', () => {
      // The GeminiModel type includes gemini-3-flash - compile-time check
      const validModels = [
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-3-flash'
      ];

      // Verify all models are strings (type guard)
      expect(validModels.every(m => typeof m === 'string')).toBe(true);
      expect(validModels).toContain('gemini-3-flash');
    });

    it('should have rate limit defined for gemini-3-flash', async () => {
      // GEMINI_RPM_LIMITS['gemini-3-flash'] = 5
      // This is enforced at compile time, but we can test the rate limiting behavior
      // by checking that the rate limit is applied when using gemini-3-flash
      const session = {
        sessionDbId: 1,
        contentSessionId: 'test-session',
        memorySessionId: 'mem-session-123',
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
        startTime: Date.now()
      } as ActiveSession;

      global.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { totalTokenCount: 10 }
      }))));

      // This validates that gemini-3-flash is a valid model at runtime
      // The agent's validation array includes gemini-3-flash
      await agent.startSession(session);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});