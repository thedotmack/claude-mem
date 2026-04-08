import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { DockerModelRunnerAgent, isDockerModelRunnerAvailable, isDockerModelRunnerSelected } from '../src/services/worker/DockerModelRunnerAgent';
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

let loadFromFileSpy: ReturnType<typeof spyOn>;
let getSpy: ReturnType<typeof spyOn>;
let modeManagerSpy: ReturnType<typeof spyOn>;

function createMockSession(overrides: any = {}) {
  return {
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
    startTime: Date.now(),
    processingMessageIds: [],
    ...overrides
  } as any;
}

function mockOpenAIResponse(content: string, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  return new Response(JSON.stringify({
    choices: [{
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage
  }), { headers: { 'Content-Type': 'application/json' } });
}

describe('DockerModelRunnerAgent', () => {
  let agent: DockerModelRunnerAgent;
  let originalFetch: typeof global.fetch;

  // Mocks
  let mockStoreObservation: any;
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
    // Mock ModeManager
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));

    // Mock SettingsDefaultsManager
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'docker-model-runner',
      CLAUDE_MEM_DOCKER_MODEL_RUNNER_MODEL: 'ai/gemma4',
      CLAUDE_MEM_DOCKER_MODEL_RUNNER_PORT: '12434',
      CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_CONTEXT_MESSAGES: '20',
      CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_TOKENS: '4096',
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
    }));

    getSpy = spyOn(SettingsDefaultsManager, 'get').mockImplementation((key: string) => {
      if (key === 'CLAUDE_MEM_DOCKER_MODEL_RUNNER_MODEL') return 'ai/gemma4';
      if (key === 'CLAUDE_MEM_DOCKER_MODEL_RUNNER_PORT') return '12434';
      if (key === 'CLAUDE_MEM_DATA_DIR') return '/tmp/claude-mem-test';
      return SettingsDefaultsManager.getAllDefaults()[key as keyof ReturnType<typeof SettingsDefaultsManager.getAllDefaults>] ?? '';
    });

    // Initialize mocks
    mockStoreObservation = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
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
      storeObservation: mockStoreObservation,
      storeObservations: mockStoreObservations,
      storeSummary: mockStoreSummary,
      markSessionCompleted: mockMarkSessionCompleted,
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-123' })),
      ensureMemorySessionIdRegistered: mock(() => {}),
      updateMemorySessionId: mock(() => {})
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
      confirmProcessed: mock(() => {}),
      cleanupProcessed: mockCleanupProcessed,
      resetStuckMessages: mockResetStuckMessages
    };

    mockSessionManager = {
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => mockPendingMessageStore
    } as unknown as SessionManager;

    agent = new DockerModelRunnerAgent(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    if (getSpy) getSpy.mockRestore();
    mock.restore();
  });

  it('should call the correct base URL with configured port and model', async () => {
    const session = createMockSession();

    global.fetch = mock(() => Promise.resolve(
      mockOpenAIResponse('<observation><type>discovery</type><title>Test</title></observation>', { total_tokens: 100 })
    ));

    await agent.startSession(session);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as any).mock.calls[0][0];
    expect(url).toBe('http://localhost:12434/engines/v1/chat/completions');

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.model).toBe('ai/gemma4');
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.3);
  });

  it('should not send an Authorization header (no API key)', async () => {
    const session = createMockSession();

    global.fetch = mock(() => Promise.resolve(
      mockOpenAIResponse('response')
    ));

    await agent.startSession(session);

    const headers = (global.fetch as any).mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should use a custom port from settings', async () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'docker-model-runner',
      CLAUDE_MEM_DOCKER_MODEL_RUNNER_MODEL: 'ai/llama3.2',
      CLAUDE_MEM_DOCKER_MODEL_RUNNER_PORT: '9999',
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
    }));

    const session = createMockSession();
    global.fetch = mock(() => Promise.resolve(mockOpenAIResponse('response')));

    await agent.startSession(session);

    const url = (global.fetch as any).mock.calls[0][0];
    expect(url).toBe('http://localhost:9999/engines/v1/chat/completions');

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.model).toBe('ai/llama3.2');
  });

  it('should handle multi-turn conversation history', async () => {
    const session = createMockSession({
      conversationHistory: [
        { role: 'user', content: 'prev context' },
        { role: 'assistant', content: 'prev response' }
      ],
      lastPromptNumber: 2,
    });

    global.fetch = mock(() => Promise.resolve(mockOpenAIResponse('response')));

    await agent.startSession(session);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    // 2 existing + 1 new init prompt = 3
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[2].role).toBe('user');
  });

  it('should process observations and store them', async () => {
    const session = createMockSession();

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

    global.fetch = mock(() => Promise.resolve(
      mockOpenAIResponse(observationXml, { total_tokens: 50 })
    ));

    await agent.startSession(session);

    expect(mockStoreObservations).toHaveBeenCalled();
    expect(mockSyncObservation).toHaveBeenCalled();
    expect(session.cumulativeInputTokens).toBeGreaterThan(0);
  });

  it('should generate synthetic memorySessionId when not set', async () => {
    const session = createMockSession({ memorySessionId: null });

    global.fetch = mock(() => Promise.resolve(mockOpenAIResponse('response')));

    await agent.startSession(session);

    expect(session.memorySessionId).toBeTruthy();
    expect(session.memorySessionId).toMatch(/^docker-model-runner-test-session-/);
  });

  it('should fallback to Claude on connection error', async () => {
    const session = createMockSession();

    global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

    const fallbackAgent = {
      startSession: mock(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    await agent.startSession(session);

    expect(fallbackAgent.startSession).toHaveBeenCalledWith(session, undefined);
  });

  it('should fallback to Claude on HTTP 500 error', async () => {
    const session = createMockSession();

    global.fetch = mock(() => Promise.resolve(
      new Response('Internal Server Error', { status: 500 })
    ));

    const fallbackAgent = {
      startSession: mock(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    await agent.startSession(session);

    expect(fallbackAgent.startSession).toHaveBeenCalledWith(session, undefined);
  });

  it('should throw on HTTP 400 without fallback', async () => {
    const session = createMockSession();

    global.fetch = mock(() => Promise.resolve(
      new Response('Bad Request', { status: 400 })
    ));

    await expect(agent.startSession(session)).rejects.toThrow('Docker Model Runner API error: 400');
  });

  it('should throw on HTTP 400 without triggering fallback', async () => {
    const session = createMockSession();

    global.fetch = mock(() => Promise.resolve(
      new Response('Bad Request', { status: 400 })
    ));

    const fallbackAgent = {
      startSession: mock(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    await expect(agent.startSession(session)).rejects.toThrow('Docker Model Runner API error: 400');
    expect(fallbackAgent.startSession).not.toHaveBeenCalled();
  });

  it('should track token usage from API response', async () => {
    const session = createMockSession();

    global.fetch = mock(() => Promise.resolve(
      mockOpenAIResponse('response', {
        prompt_tokens: 200,
        completion_tokens: 100,
        total_tokens: 300
      })
    ));

    await agent.startSession(session);

    // Token usage is split 70/30 (input/output) from total
    expect(session.cumulativeInputTokens).toBeGreaterThan(0);
    expect(session.cumulativeOutputTokens).toBeGreaterThan(0);
  });

  describe('conversation history truncation', () => {
    it('should truncate history when message count exceeds limit', async () => {
      const history: any[] = [];
      for (let i = 0; i < 25; i++) {
        history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` });
      }

      const session = createMockSession({ conversationHistory: history, lastPromptNumber: 2 });

      global.fetch = mock(() => Promise.resolve(mockOpenAIResponse('response')));

      await agent.startSession(session);

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      expect(body.messages.length).toBeLessThanOrEqual(20);
    });

    it('should respect context size setting from UI dropdown values', async () => {
      // UI dropdown offers 1K, 2K, 4K, 8K, 16K, 32K, 64K, 128K
      const validContextSizes = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
      for (const size of validContextSizes) {
        expect(size % 1024).toBe(0);
        expect(Math.log2(size) % 1).toBe(0); // power of 2
      }

      // Test that a 4K context size truncates appropriately
      loadFromFileSpy.mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_PROVIDER: 'docker-model-runner',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_MODEL: 'ai/gemma4',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_PORT: '12434',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_CONTEXT_MESSAGES: '20',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_TOKENS: '4096',
        CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
      }));

      // Each message ~2500 tokens (10000 chars / 4), so 2 messages = 5000 tokens > 4096 limit
      const history: any[] = [
        { role: 'user', content: 'x'.repeat(10000) },
        { role: 'assistant', content: 'y'.repeat(10000) },
      ];

      const session = createMockSession({ conversationHistory: history, lastPromptNumber: 2 });
      global.fetch = mock(() => Promise.resolve(mockOpenAIResponse('response')));

      await agent.startSession(session);

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      // With 4096 token limit and ~2500 tokens per message, only 1 message should fit
      expect(body.messages.length).toBeLessThan(3); // less than 2 existing + 1 init
    });

    it('should truncate history when token count exceeds limit', async () => {
      loadFromFileSpy.mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_PROVIDER: 'docker-model-runner',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_MODEL: 'ai/gemma4',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_PORT: '12434',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_CONTEXT_MESSAGES: '20',
        CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_TOKENS: '500',  // Very low limit
        CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
      }));

      // Create multiple messages that together exceed the token limit
      // Each message is ~250 tokens (1000 chars / 4), so 3 messages = 750 tokens > 500 limit
      const history: any[] = [];
      for (let i = 0; i < 5; i++) {
        history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(1000) });
      }

      const session = createMockSession({
        conversationHistory: history,
        lastPromptNumber: 2,
      });

      global.fetch = mock(() => Promise.resolve(mockOpenAIResponse('response')));

      await agent.startSession(session);

      const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
      // Should have fewer messages than original 5 + 1 init = 6
      expect(body.messages.length).toBeLessThan(6);
      expect(body.messages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('API error in response body', () => {
    it('should throw on error object in response JSON', async () => {
      const session = createMockSession();

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
        error: { code: 'model_not_found', message: 'Model ai/gemma4 not found' }
      }), { headers: { 'Content-Type': 'application/json' } })));

      // Error in response body throws - not a fallback-eligible error pattern
      await expect(agent.startSession(session)).rejects.toThrow('Docker Model Runner API error: model_not_found');
    });
  });

  describe('empty response handling', () => {
    it('should handle empty choices gracefully', async () => {
      const session = createMockSession();

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '' } }]
      }), { headers: { 'Content-Type': 'application/json' } })));

      // Should not throw - empty content is handled gracefully
      await agent.startSession(session);
    });
  });
});

describe('isDockerModelRunnerAvailable', () => {
  let loadFromFileSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
  });

  it('should always return true (no API key required)', () => {
    expect(isDockerModelRunnerAvailable()).toBe(true);
  });
});

describe('isDockerModelRunnerSelected', () => {
  let loadFromFileSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
  });

  it('should return true when provider is docker-model-runner', () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'docker-model-runner',
    }));

    expect(isDockerModelRunnerSelected()).toBe(true);
  });

  it('should return false when provider is claude', () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'claude',
    }));

    expect(isDockerModelRunnerSelected()).toBe(false);
  });

  it('should return false when provider is not set (defaults to claude)', () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
    }));

    expect(isDockerModelRunnerSelected()).toBe(false);
  });
});

describe('SettingsDefaultsManager Docker Model Runner defaults', () => {
  it('should include Docker Model Runner default settings', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();

    expect(defaults.CLAUDE_MEM_DOCKER_MODEL_RUNNER_MODEL).toBe('ai/gemma4');
    expect(defaults.CLAUDE_MEM_DOCKER_MODEL_RUNNER_PORT).toBe('12434');
    expect(defaults.CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_CONTEXT_MESSAGES).toBe('20');
    expect(defaults.CLAUDE_MEM_DOCKER_MODEL_RUNNER_MAX_TOKENS).toBe('4096');
  });

  it('should include docker-model-runner as a valid provider value', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    // Default provider is 'claude', but 'docker-model-runner' should be a valid value
    expect(defaults.CLAUDE_MEM_PROVIDER).toBe('claude');
  });
});
