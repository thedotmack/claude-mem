import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'obs prompt',
    summary: 'summary prompt',
  },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'test-session',
    memorySessionId: 'mem-session-123',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  };
}

class TestProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  private readonly responses: ProviderQueryResult[];

  constructor(responses: ProviderQueryResult[], sessionManager: unknown) {
    super({} as any, sessionManager as any);
    this.responses = responses;
  }

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(_history: ConversationMessage[]): Promise<ProviderQueryResult> {
    return this.responses.shift() ?? { content: '' };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

function makeSessionManager(messages: Array<Record<string, unknown>>) {
  return {
    getMessageIterator: async function* () {
      yield* messages;
    },
    confirmClaimedMessages: mock(() => Promise.resolve()),
  };
}

describe('OpenAICompatibleProvider history and accounting', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it('records exactly one assistant entry per response (ResponseProcessor is the single push site)', async () => {
    const sessionManager = makeSessionManager([
      { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2 },
      { type: 'summarize', last_assistant_message: 'the last assistant message' },
    ]);
    const provider = new TestProvider([
      { content: 'init response text', tokensUsed: 100, inputTokens: 90, outputTokens: 10 },
      { content: 'observation response text', tokensUsed: 200, inputTokens: 170, outputTokens: 30 },
      { content: 'summary response text', tokensUsed: 400, inputTokens: 330, outputTokens: 70 },
    ], sessionManager);
    const session = makeSession();

    await provider.startSession(session);

    // user init, assistant init, user obs, assistant obs, user summary, assistant summary — no duplicates.
    expect(session.conversationHistory).toHaveLength(6);
    const assistants = session.conversationHistory.filter(m => m.role === 'assistant');
    expect(assistants.map(m => m.content)).toEqual([
      'init response text',
      'observation response text',
      'summary response text',
    ]);
    expect(
      session.conversationHistory.filter(m => m.content === 'observation response text')
    ).toHaveLength(1);
    expect(
      session.conversationHistory.filter(m => m.content === 'summary response text')
    ).toHaveLength(1);

    // Usage flowed through the provider's accumulateUsage call sites (init +
    // observation + summary), using the real asymmetric counts — this fails if
    // any of the this.accumulateUsage(...) calls are removed from the provider.
    expect(session.cumulativeInputTokens).toBe(90 + 170 + 330);
    expect(session.cumulativeOutputTokens).toBe(10 + 30 + 70);
  });

  it('accumulates real input/output tokens when the provider reports both', () => {
    const provider = new TestProvider([], makeSessionManager([]));
    const session = makeSession();

    (provider as any).accumulateUsage(session, {
      content: 'x', tokensUsed: 1000, inputTokens: 950, outputTokens: 50,
    });

    expect(session.cumulativeInputTokens).toBe(950);
    expect(session.cumulativeOutputTokens).toBe(50);
  });

  it('falls back to the 70/30 split when inputTokens is missing', () => {
    const provider = new TestProvider([], makeSessionManager([]));
    const session = makeSession();

    (provider as any).accumulateUsage(session, {
      content: 'x', tokensUsed: 1000, outputTokens: 50,
    });

    expect(session.cumulativeInputTokens).toBe(700);
    expect(session.cumulativeOutputTokens).toBe(300);
  });
});
