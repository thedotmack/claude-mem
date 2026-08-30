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
  } as ActiveSession;
}

/**
 * Replies are deliberately non-XML: the parser rejects them, which routes
 * processAgentResponse down its confirm-and-return path. That keeps the test on
 * the history bookkeeping under test instead of the storage path.
 */
class TestProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;

  constructor(replies: string[], sessionManager: unknown) {
    super({} as never, sessionManager as never);
    this.replies = [...replies];
  }

  private replies: string[];

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(_history: ConversationMessage[]): Promise<ProviderQueryResult> {
    return { content: this.replies.shift() ?? '' };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

function makeSessionManager(messages: unknown[]) {
  return {
    getMessageIterator: async function* () {
      for (const message of messages) {
        yield message;
      }
    },
    confirmClaimedMessages: async () => {},
    resetProcessingToPending: async () => {},
    getClaimedMessages: () => [],
  };
}

describe('OpenAICompatibleProvider conversation history', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let loadFromFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
    }));
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    loadFromFileSpy?.mockRestore();
    mock.restore();
  });

  it('records each assistant reply exactly once across init, observation, and summary turns', async () => {
    const session = makeSession();
    const provider = new TestProvider(
      ['INIT_REPLY', 'OBSERVATION_REPLY', 'SUMMARY_REPLY'],
      makeSessionManager([
        { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2 },
        { type: 'summarize', last_assistant_message: 'done' },
      ])
    );

    await provider.startSession(session);

    const assistantContents = session.conversationHistory
      .filter(message => message.role === 'assistant')
      .map(message => message.content);

    expect(assistantContents).toEqual(['INIT_REPLY', 'OBSERVATION_REPLY', 'SUMMARY_REPLY']);
  });

  it('never leaves two consecutive assistant turns in the history it sends back', async () => {
    const session = makeSession();
    const provider = new TestProvider(
      ['INIT_REPLY', 'OBSERVATION_REPLY'],
      makeSessionManager([
        { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2 },
      ])
    );

    await provider.startSession(session);

    const roles = session.conversationHistory.map(message => message.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('leaves history untouched for an empty reply so an errored turn adds no phantom assistant message', async () => {
    const session = makeSession();
    const provider = new TestProvider(
      ['INIT_REPLY', ''],
      makeSessionManager([
        { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2 },
      ])
    );

    await provider.startSession(session);

    expect(session.conversationHistory.filter(message => message.role === 'assistant')).toHaveLength(1);
  });
});
