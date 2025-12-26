import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { GeminiAgent } from '../src/services/worker/GeminiAgent';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/worker/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

let billingEnabled = 'true';

// Mock SettingsDefaultsManager
mock.module('../src/shared/SettingsDefaultsManager', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({
      CLAUDE_MEM_GEMINI_API_KEY: 'test-api-key',
      CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
      CLAUDE_MEM_GEMINI_BILLING_ENABLED: billingEnabled
    }),
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_LOG_LEVEL') return 'INFO';
      return '';
    }
  }
}));

// Mock ModeManager
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

mock.module('../src/services/domain/ModeManager', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => mockMode
    })
  }
}));

describe('GeminiAgent', () => {
  let agent: GeminiAgent;
  let originalFetch: typeof global.fetch;

  // Mocks
  let mockStoreObservation: any;
  let mockStoreSummary: any;
  let mockMarkSessionCompleted: any;
  let mockSyncObservation: any;
  let mockSyncSummary: any;
  let mockMarkProcessed: any;
  let mockCleanupProcessed: any;
  let mockResetStuckMessages: any;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    // Reset billing for each test default
    billingEnabled = 'true';

    // Initialize mocks
    mockStoreObservation = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockStoreSummary = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockMarkSessionCompleted = mock(() => {});
    mockSyncObservation = mock(() => Promise.resolve());
    mockSyncSummary = mock(() => Promise.resolve());
    mockMarkProcessed = mock(() => {});
    mockCleanupProcessed = mock(() => 0);
    mockResetStuckMessages = mock(() => 0);

    const mockSessionStore = {
      storeObservation: mockStoreObservation,
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
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => mockPendingMessageStore
    } as unknown as SessionManager;

    agent = new GeminiAgent(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  it('should initialize with correct config', async () => {
    const session = {
      sessionDbId: 1,
      claudeSessionId: 'test-session',
      sdkSessionId: 'test-sdk',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      startTime: Date.now()
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: '<observation><type>discovery</type><title>Test</title></observation>' }]
        }
      }],
      usageMetadata: { totalTokenCount: 100 }
    }))));

    await agent.startSession(session);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as any).mock.calls[0][0];
    expect(url).toContain('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    expect(url).toContain('key=test-api-key');
  });

  it('should handle multi-turn conversation', async () => {
    const session = {
      sessionDbId: 1,
      claudeSessionId: 'test-session',
      sdkSessionId: 'test-sdk',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [{ role: 'user', content: 'prev context' }, { role: 'assistant', content: 'prev response' }],
      lastPromptNumber: 2,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      startTime: Date.now()
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'response' }] } }]
    }))));

    await agent.startSession(session);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.contents).toHaveLength(3);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[1].role).toBe('model');
    expect(body.contents[2].role).toBe('user');
  });

  it('should process observations and store them', async () => {
    const session = {
      sessionDbId: 1,
      claudeSessionId: 'test-session',
      sdkSessionId: 'test-sdk',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      startTime: Date.now()
    } as any;

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

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: observationXml }] } }],
      usageMetadata: { totalTokenCount: 50 }
    }))));

    await agent.startSession(session);

    expect(mockStoreObservation).toHaveBeenCalled();
    expect(mockSyncObservation).toHaveBeenCalled();
    expect(session.cumulativeInputTokens).toBeGreaterThan(0);
  });

  it('should fallback to Claude on rate limit error', async () => {
    const session = {
      sessionDbId: 1,
      claudeSessionId: 'test-session',
      sdkSessionId: 'test-sdk',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      startTime: Date.now()
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response('Resource has been exhausted (e.g. check quota).', { status: 429 })));

    const fallbackAgent = {
      startSession: mock(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    await agent.startSession(session);

    expect(fallbackAgent.startSession).toHaveBeenCalledWith(session, undefined);
    expect(mockResetStuckMessages).toHaveBeenCalled();
  });

  it('should NOT fallback on other errors', async () => {
    const session = {
      sessionDbId: 1,
      claudeSessionId: 'test-session',
      sdkSessionId: 'test-sdk',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      startTime: Date.now()
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response('Invalid argument', { status: 400 })));

    const fallbackAgent = {
      startSession: mock(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    expect(agent.startSession(session)).rejects.toThrow('Gemini API error: 400 - Invalid argument');
    expect(fallbackAgent.startSession).not.toHaveBeenCalled();
  });

  it('should respect rate limits when billing disabled', async () => {
    billingEnabled = 'false';
    const originalSetTimeout = global.setTimeout;
    const mockSetTimeout = mock((cb: any) => cb());
    global.setTimeout = mockSetTimeout as any;

    try {
      const session = {
        sessionDbId: 1,
        claudeSessionId: 'test-session',
        sdkSessionId: 'test-sdk',
        project: 'test-project',
        userPrompt: 'test prompt',
        conversationHistory: [],
        lastPromptNumber: 1,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        pendingProcessingIds: new Set(),
        startTime: Date.now()
      } as any;

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }]
      }))));

      await agent.startSession(session);
      await agent.startSession(session);

      expect(mockSetTimeout).toHaveBeenCalled();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});