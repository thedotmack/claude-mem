import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
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

const observationXml = `
  <observation>
    <type>discovery</type>
    <title>Invented from the user request</title>
    <narrative>No tool call had been observed when this was produced.</narrative>
    <facts></facts>
    <concepts></concepts>
    <files_read></files_read>
    <files_modified></files_modified>
  </observation>
`;

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

/** Answers every prompt — the init prompt included — with a valid observation. */
class TestProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  queries = 0;

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(_history: ConversationMessage[], _config: { apiKey: string; model: string }): Promise<ProviderQueryResult> {
    this.queries++;
    return { content: observationXml, tokensUsed: 100 };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

describe('OpenAICompatibleProvider init response', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let storeObservations: ReturnType<typeof mock>;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as unknown as ModeManager));

    storeObservations = mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }));

    dbManager = {
      getSessionStore: () => ({
        storeObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        updateMemorySessionId: mock(() => {}),
      }),
      getChromaSync: () => ({
        syncObservation: mock(() => Promise.resolve()),
        syncSummary: mock(() => Promise.resolve()),
      }),
      getCloudSync: () => null,
    } as unknown as DatabaseManager;

    sessionManager = {
      getMessageIterator: async function* () {
        yield { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/main.ts' }, tool_response: 'file contents', prompt_number: 1 };
      },
      getClaimedMessages: mock(() => []),
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  it('does not store observations parsed out of the init response', async () => {
    const provider = new TestProvider(dbManager, sessionManager);
    const session = makeSession();

    await provider.startSession(session);

    // Both queries were answered with an observation, but only the reply to a
    // real tool call is an observation of this session.
    expect(provider.queries).toBe(2);
    expect(storeObservations).toHaveBeenCalledTimes(1);
    // The init reply still occupies its assistant turn, so roles alternate.
    expect(session.conversationHistory.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
