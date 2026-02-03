import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OpenRouterAgent } from '../src/services/worker/OpenRouterAgent';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

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
let loadFromFileSpy: ReturnType<typeof spyOn>;
let getSpy: ReturnType<typeof spyOn>;
let modeManagerSpy: ReturnType<typeof spyOn>;

describe('OpenRouterAgent', () => {
  let agent: OpenRouterAgent;
  let originalFetch: typeof global.fetch;

  // Mocks
  let mockStoreObservations: any;
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
    // Mock ModeManager using spyOn
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));

    // Mock SettingsDefaultsManager methods using spyOn
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-api-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
    }));

    getSpy = spyOn(SettingsDefaultsManager, 'get').mockImplementation((key: string) => {
      if (key === 'CLAUDE_MEM_OPENROUTER_API_KEY') return 'test-api-key';
      if (key === 'CLAUDE_MEM_OPENROUTER_MODEL') return 'xiaomi/mimo-v2-flash:free';
      if (key === 'CLAUDE_MEM_DATA_DIR') return '/tmp/claude-mem-test';
      return SettingsDefaultsManager.getAllDefaults()[key as keyof ReturnType<typeof SettingsDefaultsManager.getAllDefaults>] ?? '';
    });

    // Initialize mocks
    mockStoreSummary = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockMarkSessionCompleted = mock(() => {});
    mockSyncObservation = mock(() => Promise.resolve());
    mockSyncSummary = mock(() => Promise.resolve());
    mockMarkProcessed = mock(() => {});
    mockCleanupProcessed = mock(() => 0);
    mockResetStuckMessages = mock(() => 0);

    mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: 1,
      createdAtEpoch: Date.now()
    }));

    const mockSessionStore = {
      storeObservations: mockStoreObservations,
      getRecentObservationsForSession: mock(() => []),
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

    agent = new OpenRouterAgent(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Restore spied methods
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    if (getSpy) getSpy.mockRestore();
    mock.restore();
  });

  it('should generate synthetic memorySessionId on first session start', async () => {
    const mockUpdateMemorySessionId = mock(() => {});
    const mockGetSessionById = mock(() => ({
      id: 42,
      memory_session_id: null
    }));

    const mockSessionStore = {
      updateMemorySessionId: mockUpdateMemorySessionId,
      storeObservations: mockStoreObservations,
      getRecentObservationsForSession: mock(() => []),
      storeSummary: mockStoreSummary,
      markSessionCompleted: mockMarkSessionCompleted
    };

    const testDbManager = {
      getSessionStore: () => mockSessionStore,
      getSessionById: mockGetSessionById,
      getChromaSync: () => mockDbManager.getChromaSync()
    } as unknown as DatabaseManager;

    const testAgent = new OpenRouterAgent(testDbManager, mockSessionManager);

    const session = {
      sessionDbId: 42,
      contentSessionId: '75919a84-1ce3-478f-b36c-91b637310fce',
      memorySessionId: null, // No existing memorySessionId
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
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 10 }
    }))));

    await testAgent.startSession(session);

    // Verify synthetic ID was generated and persisted
    expect(mockUpdateMemorySessionId).toHaveBeenCalledTimes(1);
    expect(session.memorySessionId).toMatch(/^openrouter-75919a84-1ce3-478f-b36c-91b637310fce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Verify contentSessionId is correctly embedded in the synthetic ID
    expect(session.memorySessionId).toContain('75919a84-1ce3-478f-b36c-91b637310fce');
    expect(session.memorySessionId).toStartWith('openrouter-75919a84-1ce3-478f-b36c-91b637310fce-');

    // Verify it was persisted with correct sessionDbId
    const [sessionDbId, syntheticId] = mockUpdateMemorySessionId.mock.calls[0];
    expect(sessionDbId).toBe(42);
    expect(syntheticId).toMatch(/^openrouter-75919a84-1ce3-478f-b36c-91b637310fce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(syntheticId).toContain(session.contentSessionId);
  });

  it('should NOT regenerate synthetic memorySessionId if already exists', async () => {
    const mockUpdateMemorySessionId = mock(() => {});
    const mockSessionStore = {
      updateMemorySessionId: mockUpdateMemorySessionId,
      storeObservations: mockStoreObservations,
      getRecentObservationsForSession: mock(() => []),
      storeSummary: mockStoreSummary,
      markSessionCompleted: mockMarkSessionCompleted
    };

    const testDbManager = {
      getSessionStore: () => mockSessionStore,
      getChromaSync: () => mockDbManager.getChromaSync()
    } as unknown as DatabaseManager;

    const testAgent = new OpenRouterAgent(testDbManager, mockSessionManager);

    const existingSyntheticId = 'openrouter-75919a84-1ce3-478f-b36c-91b637310fce-78bc64d2-8eeb-4c16-94c1-1e2a78e56327';
    const session = {
      sessionDbId: 42,
      contentSessionId: '75919a84-1ce3-478f-b36c-91b637310fce',
      memorySessionId: existingSyntheticId, // Already has synthetic ID
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
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { total_tokens: 10 }
    }))));

    await testAgent.startSession(session);

    // Verify synthetic ID generation was skipped
    expect(mockUpdateMemorySessionId).not.toHaveBeenCalled();
    expect(session.memorySessionId).toBe(existingSyntheticId);
  });
});
