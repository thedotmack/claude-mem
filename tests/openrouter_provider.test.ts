import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { OpenRouterProvider } from '../src/services/worker/OpenRouterProvider.js';
import type { DatabaseManager } from '../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../src/services/worker/SessionManager.js';

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'observation prompt',
    summary: 'summary prompt',
  },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

describe('OpenRouterProvider context cap', () => {
  let originalFetch: typeof global.fetch;
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let modeManagerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    }) as any);
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-api-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'test/model',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',
    }) as any);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    loadFromFileSpy.mockRestore();
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it('caps outbound history while preserving the first observer prompt and newest messages', async () => {
    const originalHistory = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: index === 0 ? 'original observer prompt' : `message-${index}`,
    }));
    let sentMessages: Array<{ role: string; content: string }> = [];

    global.fetch = mock(async (_url, init) => {
      sentMessages = JSON.parse(String(init?.body)).messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    });

    const dbManager = {} as DatabaseManager;
    const sessionManager = {
      getMessageIterator: async function* () { yield* []; },
    } as unknown as SessionManager;
    const provider = new OpenRouterProvider(dbManager, sessionManager);
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'memory-session',
      project: 'test-project',
      userPrompt: 'current prompt',
      conversationHistory: originalHistory.map(message => ({ ...message })),
      lastPromptNumber: 2,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    await provider.startSession(session);

    expect(sentMessages).toHaveLength(20);
    expect(sentMessages[0]?.content).toBe('original observer prompt');
    expect(sentMessages.at(-1)?.content).toContain('current prompt');
    expect(session.conversationHistory).toHaveLength(31);
  });
});
