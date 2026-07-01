import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GeminiProvider } from '../src/services/worker/GeminiProvider';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

let rateLimitingEnabled = 'false';

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

function makeSession(overrides: Record<string, unknown> = {}) {
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
    currentProvider: null,
    startTime: Date.now(),
    ...overrides,
  } as any;
}

function mockGeminiConfig() {
  loadFromFileSpy.mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_GEMINI_API_KEY: 'test-api-key',
    CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
    CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
    CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
  }));
}

function mockSuccessfulGeminiFetch() {
  global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'response' }] } }]
  }))));
}

function sentGeminiContents() {
  return JSON.parse((global.fetch as any).mock.calls[0][1].body).contents;
}

function expectAlternatingGeminiRoles(contents: Array<{ role: string }>) {
  expect(contents.length).toBeGreaterThan(0);
  expect(contents[0].role).toBe('user');

  for (let i = 1; i < contents.length; i++) {
    expect(contents[i].role).not.toBe(contents[i - 1].role);
  }
}

let loadFromFileSpy: ReturnType<typeof spyOn>;
let getSpy: ReturnType<typeof spyOn>;
let modeManagerSpy: ReturnType<typeof spyOn>;

describe('GeminiProvider', () => {
  let agent: GeminiProvider;
  let originalFetch: typeof global.fetch;

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
    rateLimitingEnabled = 'false';

    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_GEMINI_API_KEY: 'test-api-key',
      CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: rateLimitingEnabled,
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
    }));

    getSpy = spyOn(SettingsDefaultsManager, 'get').mockImplementation((key: string) => {
      if (key === 'CLAUDE_MEM_GEMINI_API_KEY') return 'test-api-key';
      if (key === 'CLAUDE_MEM_GEMINI_MODEL') return 'gemini-2.5-flash-lite';
      if (key === 'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED') return rateLimitingEnabled;
      if (key === 'CLAUDE_MEM_DATA_DIR') return '/tmp/claude-mem-test';
      return SettingsDefaultsManager.getAllDefaults()[key as keyof ReturnType<typeof SettingsDefaultsManager.getAllDefaults>] ?? '';
    });

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
      storeObservations: mockStoreObservations, // Required by ResponseProcessor.ts
      storeSummary: mockStoreSummary,
      markSessionCompleted: mockMarkSessionCompleted,
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-123' })), // Required by ResponseProcessor.ts for FK fix
      ensureMemorySessionIdRegistered: mock(() => {}) 
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
      confirmProcessed: mock(() => {}),  // CLAIM-CONFIRM pattern: confirm after successful storage
      cleanupProcessed: mockCleanupProcessed,
      resetStuckMessages: mockResetStuckMessages
    };

    mockSessionManager = {
      getMessageIterator: async function* () { yield* []; },
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
      getMessageBuffer: () => mockPendingMessageStore,
    } as unknown as SessionManager;

    agent = new GeminiProvider(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    if (getSpy) getSpy.mockRestore();
    mock.restore();
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
      currentProvider: null,
      startTime: Date.now(),
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
    expect(url).toContain('https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent');
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
      currentProvider: null,
      startTime: Date.now(),
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

  it('keeps Gemini roles alternating for full conversation history', async () => {
    const history = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'm3' },
      { role: 'user', content: 'u4' },
      { role: 'assistant', content: 'm5' },
    ];

    for (const label of ['a', 'b']) {
      mockGeminiConfig();
      mockSuccessfulGeminiFetch();

      await agent.startSession(makeSession({
        userPrompt: `current prompt ${label}`,
        lastPromptNumber: 2,
        conversationHistory: history.map(message => ({ ...message })),
      }));

      const contents = sentGeminiContents();
      expectAlternatingGeminiRoles(contents);
      expect(contents[contents.length - 1].role).toBe('user');
      expect(contents[contents.length - 1].parts[0].text).toContain(`current prompt ${label}`);
    }
  });

  it('merges adjacent same-role messages instead of sending repeated Gemini roles', async () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: 'first user turn' },
        { role: 'user', content: 'second user turn' },
        { role: 'assistant', content: 'model turn' },
      ],
    });

    mockSuccessfulGeminiFetch();

    await agent.startSession(session);

    const contents = sentGeminiContents();
    expectAlternatingGeminiRoles(contents);
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts[0].text).toBe('first user turn\n\nsecond user turn');
    expect(contents[1].role).toBe('model');
    expect(contents[2].role).toBe('user');
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
      currentProvider: null,
      startTime: Date.now(),
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

    expect(mockStoreObservations).toHaveBeenCalled();
    expect(mockSyncObservation).toHaveBeenCalled();
    expect(session.cumulativeInputTokens).toBeGreaterThan(0);
  });

  it('should throw on rate limit (429) error — no Claude fallback (#2087)', async () => {
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
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response('Resource has been exhausted (e.g. check quota).', { status: 429 })));

    await expect(agent.startSession(session)).rejects.toThrow(/429/);
  });

  it('should throw on other errors', async () => {
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
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response('Invalid argument RAW_PROVIDER_BODY', { status: 400 })));

    // F4 classifyGeminiError surfaces 400 as a classified `unrecoverable` error
    // with a stable category rather than forwarding the raw upstream body.
    try {
      await agent.startSession(session);
      throw new Error('expected Gemini bad request to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Gemini bad request: unknown_bad_request');
      expect((error as Error).message).not.toContain('RAW_PROVIDER_BODY');
    }
  });

  it('redacts non-400 Gemini response body from thrown message and cause', async () => {
    const rawBody = 'RAW_PROVIDER_BODY with credential sk-secret';
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
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(rawBody, {
      status: 418,
      headers: { 'x-goog-request-id': 'gemini-request-1' },
    })));

    try {
      await agent.startSession(session);
      throw new Error('expected Gemini fallback error to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Gemini API error (status 418)');
      expect((error as Error).message).not.toContain(rawBody);
      const cause = (error as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toContain('status 418');
      expect((cause as Error).message).toContain('gemini-request-1');
      expect((cause as Error).message).not.toContain(rawBody);
    }
  });

  it('should respect rate limits when rate limiting enabled', async () => {
    rateLimitingEnabled = 'true';

    const originalSetTimeout = global.setTimeout;
    const mockSetTimeout = mock((cb: any) => cb());
    global.setTimeout = mockSetTimeout as any;

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
        currentProvider: null,
        startTime: Date.now(),
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

  describe('gemini-3-flash-preview model support', () => {
    it('should accept gemini-3-flash-preview as a valid model', async () => {
      const validModels = [
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-3-flash-preview'
      ];

      expect(validModels.every(m => typeof m === 'string')).toBe(true);
      expect(validModels).toContain('gemini-3-flash-preview');
    });

    it('should have rate limit defined for gemini-3-flash-preview', async () => {
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
        currentProvider: null,
        startTime: Date.now(),
      } as any;

      global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { totalTokenCount: 10 }
      }))));

      await agent.startSession(session);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});
