import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
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

// The init prompt is a request of its own only with CLAUDE_MEM_OBSERVE_BARE_PROMPTS=true.
describe('OpenAICompatibleProvider init response', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let storeObservations: ReturnType<typeof mock>;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let previousObserveBarePrompts: string | undefined;

  beforeEach(() => {
    previousObserveBarePrompts = process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
    process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = 'true';
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
      claimNextObservation: mock(() => null),
      getClaimedMessages: mock(() => []),
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;
  });

  afterEach(() => {
    if (previousObserveBarePrompts === undefined) delete process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
    else process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = previousObserveBarePrompts;
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

  it('continues a Codex session after an empty initialization reply', async () => {
    const provider = new CodexProvider(dbManager, sessionManager) as any;
    provider.getConfig = () => ({ apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex' });
    let call = 0;
    const turns = mock(async () => ({ content: call++ === 0 ? '' : observationXml }));
    provider.appServer.runTurn = turns;
    const session = makeSession({ currentProvider: 'codex' });

    await provider.startSession(session);

    expect(turns).toHaveBeenCalledTimes(2);
    expect(storeObservations).toHaveBeenCalledTimes(1);
    expect(session.conversationHistory.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(session.conversationHistory[1].content).toBe('');
  });

  it('hands a blank Codex observation reply to the skip contract instead of pausing it as a fault', async () => {
    const session = makeSession({ currentProvider: 'codex' });
    const resetProcessingToPending = mock(() => Promise.resolve(1));
    const manager = {
      ...sessionManager,
      resetProcessingToPending,
      getMessageIterator: async function* () {
        session.claimedMessageIds.push(7);
        yield { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/main.ts' }, tool_response: 'file contents', prompt_number: 1 };
      },
    } as unknown as SessionManager;
    const provider = new CodexProvider(dbManager, manager) as any;
    provider.getConfig = () => ({ apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex' });
    let call = 0;
    const turns = mock(async () => ({ content: call++ === 0 ? 'ready' : '' }));
    provider.appServer.runTurn = turns;

    await provider.startSession(session);

    // One reply per request: no in-provider retry and no transport pause. The
    // queued batch goes back to pending for one more try in a fresh generation.
    expect(turns).toHaveBeenCalledTimes(2);
    expect(session.abortReason).toBe('output_retry:idle');
    expect(resetProcessingToPending).toHaveBeenCalled();
    expect(storeObservations).not.toHaveBeenCalled();
  });
});
