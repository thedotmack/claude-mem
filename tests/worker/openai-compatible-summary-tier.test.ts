import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
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
  readonly queriedModels: string[] = [];

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(_history: ConversationMessage[], config: { apiKey: string; model: string }): Promise<ProviderQueryResult> {
    this.queriedModels.push(config.model);
    return { content: '' };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

describe('OpenAICompatibleProvider summary tier routing', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let loadFromFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    loadFromFileSpy?.mockRestore();
    mock.restore();
  });

  it('routes summarize messages to the summary-tier model while observation stays on the session model', async () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
      CLAUDE_MEM_TIER_SUMMARY_MODEL: 'summary-model',
    }));

    const provider = new TestProvider({} as any, {
      getMessageIterator: async function* () {
        yield { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2 };
        yield { type: 'summarize', last_assistant_message: 'done' };
      },
    } as any);

    await provider.startSession(makeSession());

    expect(provider.queriedModels).toEqual(['session-model', 'session-model', 'summary-model']);
  });

  it('keeps summarize on the session model when routing is disabled', async () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
      CLAUDE_MEM_TIER_SUMMARY_MODEL: 'summary-model',
    }));

    const provider = new TestProvider({} as any, {
      getMessageIterator: async function* () {
        yield { type: 'summarize', last_assistant_message: 'done' };
      },
    } as any);

    await provider.startSession(makeSession());

    expect(provider.queriedModels).toEqual(['session-model', 'session-model']);
  });
});
