import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

const mode = {
  name: 'code',
  prompts: { init: 'init', observation: 'observation', summary: 'summary' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

const confirmed: ConversationMessage[] = [
  { role: 'user', content: 'previous request' },
  { role: 'assistant', content: 'previous answer' },
];

const observationXml = `
<observation>
  <type>discovery</type>
  <title>Confirmed observation</title>
  <narrative>A real queued tool call was observed.</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
`;

function makeSession(): ActiveSession {
  return {
    sessionDbId: 4204,
    contentSessionId: 'session-4204',
    memorySessionId: 'memory-4204',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'remember this',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [...confirmed],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

class FailingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  queryCount = 0;

  constructor(
    dbManager: DatabaseManager,
    sessionManager: SessionManager,
    private readonly failingQuery: number,
    private readonly appendAssistantBeforeFailure = false,
    private readonly secondResponse = 'init answer',
    private readonly firstResponse = 'init answer',
  ) {
    super(dbManager, sessionManager);
  }

  protected getConfig() {
    return { apiKey: 'test-key', model: 'test-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    this.queryCount++;
    if (this.queryCount === this.failingQuery) {
      if (this.appendAssistantBeforeFailure) {
        history.push({ role: 'assistant', content: 'later confirmed answer' });
      }
      throw new ClassifiedProviderError('request timed out', { kind: 'transient', cause: new Error('deadline') });
    }
    return { content: this.queryCount === 2 ? this.secondResponse : this.firstResponse };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

function managerFor(kind: 'init' | 'observation' | 'summarize'): SessionManager {
  return {
    getMessageIterator: async function* () {
      if (kind === 'observation') {
        yield { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: 'ok', prompt_number: 1 };
      } else if (kind === 'summarize') {
        yield { type: 'summarize', last_assistant_message: 'done' };
      }
    },
  } as unknown as SessionManager;
}

describe('OpenAI-compatible failed turn rollback', () => {
  let modeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    modeSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mode,
    } as unknown as ModeManager));
  });

  afterEach(() => modeSpy.mockRestore());

  it('does not accumulate failed init turns across generator starts', async () => {
    const session = makeSession();
    const manager = managerFor('init');
    for (let attempt = 0; attempt < 2; attempt++) {
      const provider = new FailingProvider({} as DatabaseManager, manager, 1);
      await expect(provider.startSession(session)).rejects.toBeInstanceOf(ClassifiedProviderError);
      expect(provider.queryCount).toBe(1);
      expect(session.conversationHistory).toEqual(confirmed);
    }
  });

  for (const kind of ['observation', 'summarize'] as const) {
    it('does not accumulate failed ' + kind + ' generations', async () => {
      const session = makeSession();
      const manager = managerFor(kind);
      for (let attempt = 0; attempt < 2; attempt++) {
        const provider = new FailingProvider({} as DatabaseManager, manager, 2);

        await expect(provider.startSession(session)).rejects.toBeInstanceOf(ClassifiedProviderError);

        expect(provider.queryCount).toBe(2);
        expect(session.conversationHistory).toEqual(confirmed);
      }
    });
  }

  it('does not accumulate empty init turns before failed observations', async () => {
    const session = makeSession();
    const manager = managerFor('observation');
    for (let attempt = 0; attempt < 2; attempt++) {
      const provider = new FailingProvider({} as DatabaseManager, manager, 2, false, 'init answer', '');

      await expect(provider.startSession(session)).rejects.toBeInstanceOf(ClassifiedProviderError);

      expect(provider.queryCount).toBe(2);
      expect(session.conversationHistory).toEqual(confirmed);
    }
  });

  it('retains a stored observation and its init context when a later turn fails', async () => {
    const session = makeSession();
    const storeObservations = () => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() });
    const dbManager = {
      getSessionStore: () => ({
        storeObservations,
        ensureMemorySessionIdRegistered: () => {},
        updateMemorySessionId: () => {},
      }),
      getChromaSync: () => ({ syncObservation: () => Promise.resolve(), syncSummary: () => Promise.resolve() }),
      getCloudSync: () => null,
    } as unknown as DatabaseManager;
    const sessionManager = {
      getMessageIterator: async function* () {
        yield { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: 'first', prompt_number: 1 };
        yield { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: 'second', prompt_number: 1 };
      },
      getClaimedMessages: () => [],
      confirmClaimedMessages: async () => 1,
      resetProcessingToPending: async () => 0,
    } as unknown as SessionManager;
    const provider = new FailingProvider(dbManager, sessionManager, 3, false, observationXml);

    await expect(provider.startSession(session)).rejects.toBeInstanceOf(ClassifiedProviderError);

    expect(provider.queryCount).toBe(3);
    expect(session.conversationHistory.map(turn => turn.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);
    expect(session.conversationHistory.slice(0, 2)).toEqual(confirmed);
    expect(session.conversationHistory[5].content).toContain('Confirmed observation');
  });

  it('does not remove a turn once a later assistant turn occupies the tail', async () => {
    const session = makeSession();
    const provider = new FailingProvider({} as DatabaseManager, managerFor('init'), 1, true);

    await expect(provider.startSession(session)).rejects.toBeInstanceOf(ClassifiedProviderError);

    expect(session.conversationHistory.slice(0, 2)).toEqual(confirmed);
    expect(session.conversationHistory[2].role).toBe('user');
    expect(session.conversationHistory[3]).toEqual({ role: 'assistant', content: 'later confirmed answer' });
  });
});
