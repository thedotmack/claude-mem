import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import {
  accumulateClaudeUsage,
  accumulateObserverUsage,
  observerUsageLogFields,
} from '../../src/services/worker/observer-usage.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
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

/**
 * Every query reports the real prompt/completion split that Gemini
 * (promptTokenCount/candidatesTokenCount) and OpenRouter
 * (prompt_tokens/completion_tokens) both return.
 */
class RealUsageProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;

  constructor(dbManager: any, sessionManager: any, private readonly failOnQuery = false) {
    super(dbManager, sessionManager);
  }

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(_history: ConversationMessage[]): Promise<ProviderQueryResult> {
    if (this.failOnQuery) {
      throw new Error('gateway exploded');
    }
    return { content: 'ok', tokensUsed: 1000, inputTokens: 990, outputTokens: 10 };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

describe('accumulateObserverUsage', () => {
  it('accumulates the real input/output split instead of a 70/30 estimate', () => {
    const session = makeSession();

    accumulateObserverUsage(session, { tokensUsed: 1000, inputTokens: 990, outputTokens: 10 });

    expect(session.cumulativeInputTokens).toBe(990);
    expect(session.cumulativeOutputTokens).toBe(10);
  });

  it('accumulates zero-valued real counts as reported', () => {
    const session = makeSession();

    accumulateObserverUsage(session, { tokensUsed: 40, inputTokens: 40, outputTokens: 0 });

    expect(session.cumulativeInputTokens).toBe(40);
    expect(session.cumulativeOutputTokens).toBe(0);
  });

  it('falls back to the 70/30 split when a gateway reports only a bare total', () => {
    const session = makeSession();

    accumulateObserverUsage(session, { tokensUsed: 1000 });

    expect(session.cumulativeInputTokens).toBe(700);
    expect(session.cumulativeOutputTokens).toBe(300);
  });

  it('falls back when only one side of the split is reported (both sides or nothing)', () => {
    const session = makeSession();

    accumulateObserverUsage(session, { tokensUsed: 1000, outputTokens: 10 });

    expect(session.cumulativeInputTokens).toBe(700);
    expect(session.cumulativeOutputTokens).toBe(300);
  });

  it('leaves the counters untouched when the response carries no usage at all', () => {
    const session = makeSession({ cumulativeInputTokens: 5, cumulativeOutputTokens: 2 });

    accumulateObserverUsage(session, {});

    expect(session.cumulativeInputTokens).toBe(5);
    expect(session.cumulativeOutputTokens).toBe(2);
  });
});

describe('accumulateClaudeUsage', () => {
  it('keeps fresh input plus cache creation in cumulativeInputTokens', () => {
    const session = makeSession();

    accumulateClaudeUsage(session, {
      input_tokens: 12,
      output_tokens: 300,
      cache_creation_input_tokens: 88,
    });

    expect(session.cumulativeInputTokens).toBe(100);
    expect(session.cumulativeOutputTokens).toBe(300);
  });

  it('tracks cache reads separately so discovery_tokens keeps its meaning', () => {
    const session = makeSession();

    accumulateClaudeUsage(session, {
      input_tokens: 12,
      output_tokens: 300,
      cache_read_input_tokens: 84_000,
    });
    accumulateClaudeUsage(session, {
      input_tokens: 12,
      output_tokens: 300,
      cache_read_input_tokens: 86_000,
    });

    expect(session.cumulativeCacheReadTokens).toBe(170_000);
    expect(session.cumulativeInputTokens).toBe(24);
  });
});

describe('observerUsageLogFields', () => {
  it('reports both cumulative counters', () => {
    const session = makeSession({ cumulativeInputTokens: 64_400_000, cumulativeOutputTokens: 120_000 });

    expect(observerUsageLogFields(session)).toEqual({
      cumulativeInputTokens: 64_400_000,
      cumulativeOutputTokens: 120_000,
    });
  });

  it('adds cumulative cache reads when the provider reported any', () => {
    const session = makeSession({
      cumulativeInputTokens: 900,
      cumulativeOutputTokens: 120,
      cumulativeCacheReadTokens: 21_000_000,
    });

    expect(observerUsageLogFields(session)).toEqual({
      cumulativeInputTokens: 900,
      cumulativeOutputTokens: 120,
      cumulativeCacheReadTokens: 21_000_000,
    });
  });

  it('matches the fields SessionRoutes spreads into Generator failed logs', () => {
    const session = makeSession({
      cumulativeInputTokens: 12_000,
      cumulativeOutputTokens: 40,
      cumulativeCacheReadTokens: 84_000,
    });

    const failureContext = {
      sessionId: session.sessionDbId,
      provider: 'claude',
      error: 'stream died',
      ...observerUsageLogFields(session),
    };

    expect(failureContext).toMatchObject({
      cumulativeInputTokens: 12_000,
      cumulativeOutputTokens: 40,
      cumulativeCacheReadTokens: 84_000,
    });
  });
});

describe('OpenAICompatibleProvider observer cost visibility', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let successSpy: ReturnType<typeof spyOn>;
  let failureSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
    }));
    successSpy = spyOn(logger, 'success').mockImplementation(() => {});
    failureSpy = spyOn(logger, 'failure').mockImplementation(() => {});
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    loadFromFileSpy.mockRestore();
    successSpy.mockRestore();
    failureSpy.mockRestore();
    mock.restore();
  });

  it('reports cumulative observer tokens on the session completion line', async () => {
    const provider = new RealUsageProvider({} as any, {
      confirmClaimedMessages: async () => 0,
      resetProcessingToPending: async () => 0,
      getMessageIterator: async function* () {
        yield { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2 };
      },
    } as any);
    const session = makeSession();

    await provider.startSession(session);

    // init query + observation query, each 990 in / 10 out.
    expect(session.cumulativeInputTokens).toBe(1980);
    expect(session.cumulativeOutputTokens).toBe(20);

    const completion = successSpy.mock.calls.find(call => String(call[1]).includes('agent completed'));
    expect(completion).toBeDefined();
    expect(completion![2]).toMatchObject({
      cumulativeInputTokens: 1980,
      cumulativeOutputTokens: 20,
    });
  });

  it('reports cumulative observer tokens when the session dies mid-flight', async () => {
    const provider = new RealUsageProvider({} as any, {
      getMessageIterator: async function* () {},
    } as any, true);
    const session = makeSession({ cumulativeInputTokens: 4_100_000, cumulativeOutputTokens: 9_000 });

    await expect(provider.startSession(session)).rejects.toThrow('gateway exploded');

    expect(failureSpy).toHaveBeenCalled();
    const failure = failureSpy.mock.calls.find(call => String(call[1]).includes('agent error'));
    expect(failure).toBeDefined();
    expect(failure![2]).toMatchObject({
      cumulativeInputTokens: 4_100_000,
      cumulativeOutputTokens: 9_000,
    });
  });
});
