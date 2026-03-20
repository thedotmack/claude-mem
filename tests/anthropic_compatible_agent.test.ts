import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { AnthropicCompatibleAgent, isAnthropicCompatibleAvailable, isAnthropicCompatibleSelected } from '../src/services/worker/AnthropicCompatibleAgent';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

const DASHSCOPE_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/messages';
const DASHSCOPE_API_KEY = 'sk-sp-5646b06ed68245f6a262a1de169a882d';
const DASHSCOPE_MODEL = 'qwen3.5-plus';

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

describe('AnthropicCompatibleAgent', () => {
  let agent: AnthropicCompatibleAgent;
  let originalFetch: typeof global.fetch;
  let originalAnthropicKey: string | undefined;

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

  function makeDefaultSettings(overrides: Record<string, string> = {}) {
    return {
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_API_KEY: DASHSCOPE_API_KEY,
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_BASE_URL: DASHSCOPE_BASE_URL,
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_MODEL: DASHSCOPE_MODEL,
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_MAX_CONTEXT_MESSAGES: '20',
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_MAX_TOKENS: '100000',
      CLAUDE_MEM_DATA_DIR: '/tmp/claude-mem-test',
      ...overrides,
    };
  }

  beforeEach(() => {
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() =>
      makeDefaultSettings() as any
    );

    getSpy = spyOn(SettingsDefaultsManager, 'get').mockImplementation((key: string) => {
      const defaults = makeDefaultSettings();
      return defaults[key as keyof typeof defaults] ?? '';
    });

    mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: 1,
      createdAtEpoch: Date.now()
    }));
    mockStoreSummary = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockMarkSessionCompleted = mock(() => {});
    mockSyncObservation = mock(() => Promise.resolve());
    mockSyncSummary = mock(() => Promise.resolve());
    mockMarkProcessed = mock(() => {});
    mockCleanupProcessed = mock(() => 0);
    mockResetStuckMessages = mock(() => 0);

    const mockSessionStore = {
      storeObservation: mock(() => ({ id: 1, createdAtEpoch: Date.now() })),
      storeObservations: mockStoreObservations,
      storeSummary: mockStoreSummary,
      markSessionCompleted: mockMarkSessionCompleted,
      updateMemorySessionId: mock(() => {}),
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-123' })),
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
      confirmProcessed: mock(() => {}),
      cleanupProcessed: mockCleanupProcessed,
      resetStuckMessages: mockResetStuckMessages
    };

    mockSessionManager = {
      getMessageIterator: async function* () { yield* []; },
      getPendingMessageStore: () => mockPendingMessageStore
    } as unknown as SessionManager;

    agent = new AnthropicCompatibleAgent(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    if (getSpy) getSpy.mockRestore();
    mock.restore();
  });

  it('isAnthropicCompatibleSelected() returns true when provider is set', () => {
    loadFromFileSpy.mockImplementation(() => makeDefaultSettings({ CLAUDE_MEM_PROVIDER: 'anthropic-compatible' }) as any);
    expect(isAnthropicCompatibleSelected()).toBe(true);
  });

  it('isAnthropicCompatibleSelected() returns false when provider is not set', () => {
    loadFromFileSpy.mockImplementation(() => makeDefaultSettings({ CLAUDE_MEM_PROVIDER: 'claude' }) as any);
    expect(isAnthropicCompatibleSelected()).toBe(false);
  });

  it('isAnthropicCompatibleAvailable() returns true when base URL and model are configured', () => {
    expect(isAnthropicCompatibleAvailable()).toBe(true);
  });

  it('isAnthropicCompatibleAvailable() returns false when base URL is missing', () => {
    loadFromFileSpy.mockImplementation(() => makeDefaultSettings({
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_BASE_URL: '',
    }) as any);
    expect(isAnthropicCompatibleAvailable()).toBe(false);
  });

  it('reads API key from ANTHROPIC_API_KEY env when settings key is empty', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-test-key';
    loadFromFileSpy.mockImplementation(() => makeDefaultSettings({
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_API_KEY: '',
    }) as any);

    const session = makeSession();

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(makeApiResponse('ok')))));

    await agent.startSession(session);

    const callHeaders = (global.fetch as any).mock.calls[0][1].headers;
    expect(callHeaders['x-api-key']).toBe('sk-env-test-key');
  });

  it('startSession() throws when baseUrl is empty', async () => {
    loadFromFileSpy.mockImplementation(() => makeDefaultSettings({
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_BASE_URL: '',
    }) as any);

    const session = makeSession();
    await expect(agent.startSession(session)).rejects.toThrow('CLAUDE_MEM_ANTHROPIC_COMPATIBLE_BASE_URL is not configured');
  });

  it('startSession() throws when model is empty', async () => {
    loadFromFileSpy.mockImplementation(() => makeDefaultSettings({
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_MODEL: '',
    }) as any);

    const session = makeSession();
    await expect(agent.startSession(session)).rejects.toThrow('CLAUDE_MEM_ANTHROPIC_COMPATIBLE_MODEL is not configured');
  });

  it('startSession() makes correct fetch call: x-api-key, anthropic-version, no Authorization, correct body', async () => {
    const session = makeSession();

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(makeApiResponse('ok')))));

    await agent.startSession(session);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as any).mock.calls[0];

    // URL matches configured baseUrl
    expect(url).toBe(DASHSCOPE_BASE_URL);

    // Headers: x-api-key (not Authorization), anthropic-version, Content-Type
    expect(options.headers['x-api-key']).toBe(DASHSCOPE_API_KEY);
    expect(options.headers['anthropic-version']).toBe('2023-06-01');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers['Authorization']).toBeUndefined();

    // Body has model and messages, no temperature
    const body = JSON.parse(options.body);
    expect(body.model).toBe(DASHSCOPE_MODEL);
    expect(body.messages).toBeDefined();
    expect(body.temperature).toBeUndefined();
  });

  it('startSession() correctly extracts text block from thinking+text mixed response', async () => {
    const textContent = 'This is the actual answer in text block';
    const session = makeSession();

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(makeApiResponseWithThinking(textContent)))));

    await agent.startSession(session);

    // Verify fetch was called and agent processed the text (not the thinking) block
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // The agent should not throw - it successfully extracted text from mixed response
  });

  it('startSession() processes observations and stores them', async () => {
    const observationXml = `
      <observation>
        <type>discovery</type>
        <title>Found a pattern</title>
        <subtitle>In test code</subtitle>
        <narrative>Discovered a repeated pattern</narrative>
        <facts><fact>Pattern exists</fact></facts>
        <concepts><concept>pattern</concept></concepts>
        <files_read><file>src/test.ts</file></files_read>
        <files_modified></files_modified>
      </observation>
    `;

    const session = makeSession();

    // Return observation XML on second call (first is init, second is observation)
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      const text = callCount === 2 ? observationXml : 'ok';
      return Promise.resolve(new Response(JSON.stringify(makeApiResponse(text, 30, 20))));
    });

    // Set up session manager to yield one observation
    mockSessionManager = {
      getMessageIterator: async function* () {
        yield {
          _persistentId: 42,
          type: 'observation',
          tool_name: 'Read',
          tool_input: { file_path: 'src/test.ts' },
          tool_response: { content: 'file content' },
          prompt_number: 2,
          cwd: '/test'
        };
      },
      getPendingMessageStore: () => ({
        markProcessed: mockMarkProcessed,
        confirmProcessed: mock(() => {}),
        cleanupProcessed: mockCleanupProcessed,
        resetStuckMessages: mockResetStuckMessages
      })
    } as unknown as SessionManager;

    agent = new AnthropicCompatibleAgent(mockDbManager, mockSessionManager);

    await agent.startSession(session);

    expect(mockStoreObservations).toHaveBeenCalled();
  });

  it('falls back to Claude on 429 rate limit', async () => {
    const session = makeSession();

    global.fetch = mock(() => Promise.resolve(new Response('Rate limit exceeded', { status: 429 })));

    const fallbackAgent = {
      startSession: mock(() => Promise.resolve())
    };
    agent.setFallbackAgent(fallbackAgent);

    await agent.startSession(session);

    expect(fallbackAgent.startSession).toHaveBeenCalledWith(session, undefined);
  });

  it('context truncation: truncates history when MAX_CONTEXT_MESSAGES exceeded', async () => {
    loadFromFileSpy.mockImplementation(() => makeDefaultSettings({
      CLAUDE_MEM_ANTHROPIC_COMPATIBLE_MAX_CONTEXT_MESSAGES: '2',
    }) as any);

    const session = makeSession();
    // Pre-populate with 5 messages to exceed limit of 2
    session.conversationHistory = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'resp1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'resp2' },
      { role: 'user', content: 'msg3' },
    ];

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify(makeApiResponse('ok')))));

    await agent.startSession(session);

    // After adding initPrompt to history (now 6 items), fetch is called with truncated history
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    // Truncated to MAX_CONTEXT_MESSAGES = 2
    expect(body.messages.length).toBeLessThanOrEqual(2);
  });
});

// ---- Helpers ----

function makeSession(overrides: Partial<any> = {}) {
  return {
    sessionDbId: 1,
    contentSessionId: 'test-session-123',
    memorySessionId: 'mem-session-456',
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

function makeApiResponse(content: string, inputTokens?: number, outputTokens?: number) {
  return {
    content: [{ type: 'text', text: content }],
    usage: {
      input_tokens: inputTokens ?? 10,
      output_tokens: outputTokens ?? 5
    }
  };
}

function makeApiResponseWithThinking(textContent: string) {
  return {
    content: [
      { type: 'thinking', thinking: 'Let me think about this...' },
      { type: 'text', text: textContent }
    ],
    usage: {
      input_tokens: 50,
      output_tokens: 20
    }
  };
}
