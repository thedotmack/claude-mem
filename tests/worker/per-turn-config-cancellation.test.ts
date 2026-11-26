import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import codeMode from '../../plugin/modes/code.json';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import { sessionDbWithoutMedia } from '../fixtures/worker/session-db-without-media.js';

const mockMode = {
  name: 'code',
  prompts: codeMode.prompts,
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

const observationXml = `
  <observation>
    <type>discovery</type>
    <title>Per-turn config keeps cancellation</title>
    <narrative>The observer turn honours the session abort signal.</narrative>
    <facts><fact>Facts carry per-session fault accounting.</fact></facts>
    <concepts><concept>problem-solution</concept></concepts>
    <files_read></files_read>
    <files_modified></files_modified>
  </observation>
`;

/**
 * The config shape CodexProvider reads: `signal` feeds AbortSignal.any in
 * query(), and `sessionDbId` feeds per-session fault accounting. Both are set
 * by prepareSessionExtras, NOT by getConfig (which returns a fresh object).
 */
interface TurnConfig {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
  sessionDbId?: number;
}

function makeSession(): ActiveSession {
  return {
    sessionDbId: 1234,
    contentSessionId: 'per-turn-config-session',
    memorySessionId: 'mem-per-turn-1234',
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
  } as ActiveSession;
}

/**
 * A provider that behaves like CodexProvider for the fields under test:
 * getConfig() returns a brand-new object with no per-session fields, and
 * prepareSessionExtras is the only place those fields are installed. Each
 * query snapshots the config it actually received, so the test proves whether
 * the per-turn config in runMessageLoop was prepared before being sent.
 */
class CapturingProvider extends OpenAICompatibleProvider<TurnConfig> {
  protected readonly providerName = 'CapturingProvider';
  protected readonly syntheticIdPrefix = 'capture';
  protected readonly forwardEmptyMessageResponse = false;
  readonly configsAtQuery: TurnConfig[] = [];

  protected getConfig(): TurnConfig {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected prepareSessionExtras(session: ActiveSession, config: TurnConfig): void {
    config.signal = session.abortController.signal;
    config.sessionDbId = session.sessionDbId;
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(_history: ConversationMessage[], config: TurnConfig): Promise<ProviderQueryResult> {
    this.configsAtQuery.push({
      signal: config.signal,
      sessionDbId: config.sessionDbId,
      apiKey: config.apiKey,
      model: config.model,
    });
    return { content: observationXml, tokensUsed: 100 };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

/**
 * A provider whose model can change between two queued turns and whose window
 * lookup returns a distinct size per model. `query` snapshots the window the
 * session actually carried when the request was built: before the fix, the
 * second turn still sees the first model's larger window.
 */
class SwitchingWindowProvider extends CapturingProvider {
  private currentModel = 'large-model';
  readonly windowsAtQuery: Array<number | undefined> = [];
  private session?: ActiveSession;

  setModel(model: string): void {
    this.currentModel = model;
  }

  protected override getConfig(): TurnConfig {
    return { apiKey: 'test-api-key', model: this.currentModel };
  }

  protected async resolveContextWindow(_config: TurnConfig): Promise<number> {
    return this.currentModel === 'large-model' ? 200_000 : 32_000;
  }

  protected override prepareSessionExtras(session: ActiveSession, config: TurnConfig): void {
    this.session = session;
    super.prepareSessionExtras(session, config);
  }

  protected override async query(history: ConversationMessage[], config: TurnConfig): Promise<ProviderQueryResult> {
    this.windowsAtQuery.push(this.session?.observerContextWindowTokens);
    return super.query(history, config);
  }
}

type Message = Record<string, unknown>;

describe('per-turn config stays cancellable (Greptile P1, task 10)', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let previousObserveBarePrompts: string | undefined;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    // Keep the init prompt folded into the first real turn so the only query
    // is the one driven by runMessageLoop.
    previousObserveBarePrompts = process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
    process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = 'false';
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as unknown as ModeManager));

    const storeObservations = mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }));
    dbManager = {
      getSessionStore: () => ({
        storeObservations,
        db: sessionDbWithoutMedia(),
        ensureMemorySessionIdRegistered: mock(() => {}),
        updateMemorySessionId: mock(() => {}),
      }),
      getChromaSync: () => ({
        syncObservation: mock(() => Promise.resolve()),
        syncSummary: mock(() => Promise.resolve()),
      }),
      getCloudSync: () => null,
    } as unknown as DatabaseManager;
  });

  afterEach(() => {
    if (previousObserveBarePrompts === undefined) delete process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
    else process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = previousObserveBarePrompts;
    modeManagerSpy.mockRestore();
    mock.restore();
  });

  function harness(messages: Message[]) {
    sessionManager = {
      getMessageIterator: async function* () {
        for (const message of messages) yield message;
      },
      claimNextObservation: mock(() => null),
      getClaimedMessages: mock(() => []),
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;
    return sessionManager;
  }

  const observationMessage = {
    type: 'observation',
    tool_name: 'Read',
    tool_input: { file_path: 'src/main.ts' },
    tool_response: 'file contents',
    prompt_number: 1,
  };
  const summaryMessage = {
    type: 'summarize',
    last_assistant_message: 'Done',
    prompt_number: 2,
  };

  it('carries the session abort signal and db id on the observation request config', async () => {
    harness([observationMessage]);
    const provider = new CapturingProvider(dbManager, sessionManager);
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.configsAtQuery).toHaveLength(1);
    expect(provider.configsAtQuery[0].signal).toBe(session.abortController.signal);
    expect(provider.configsAtQuery[0].sessionDbId).toBe(session.sessionDbId);
  });

  it('carries the session abort signal and db id on the summary request config', async () => {
    harness([summaryMessage]);
    const provider = new CapturingProvider(dbManager, sessionManager);
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.configsAtQuery).toHaveLength(1);
    expect(provider.configsAtQuery[0].signal).toBe(session.abortController.signal);
    expect(provider.configsAtQuery[0].sessionDbId).toBe(session.sessionDbId);
  });

  it('does not send a summary that would exceed the refreshed window budget', async () => {
    let session!: ActiveSession;
    sessionManager = {
      getMessageIterator: async function* () {
        // The generator opens a fresh generation before iterating, so the
        // long history is injected from the iterator, not before startSession.
        // 70k chars fit a 200k-token model's budget but not the 32k-token one
        // (half-window = 64k chars).
        session.conversationHistory = [{ role: 'user', content: 'x'.repeat(70_000) }];
        yield summaryMessage;
      },
      claimNextObservation: mock(() => null),
      getClaimedMessages: mock(() => []),
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;
    const provider = new SwitchingWindowProvider(dbManager, sessionManager);
    provider.setModel('small-model');
    session = makeSession();

    await provider.startSession(session);

    expect(provider.configsAtQuery).toHaveLength(0);
    expect(sessionManager.resetProcessingToPending).toHaveBeenCalledWith(session.sessionDbId);
  });

  it('refreshes the model window before a later turn uses a smaller model', async () => {
    let provider!: SwitchingWindowProvider;
    const switchMessages: Message[] = [
      { ...observationMessage, _persistentId: 1, _originalTimestamp: Date.now(), prompt_number: 2 },
    ];
    sessionManager = {
      getMessageIterator: async function* () {
        yield switchMessages[0];
        provider.setModel('small-model');
        yield {
          ...observationMessage, _persistentId: 2, _originalTimestamp: Date.now(),
          tool_input: { file_path: 'src/other.ts' }, tool_response: 'other contents', prompt_number: 3,
        };
      },
      claimNextObservation: mock(() => null),
      getClaimedMessages: mock(() => []),
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
    } as unknown as SessionManager;
    provider = new SwitchingWindowProvider(dbManager, sessionManager);
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.configsAtQuery.map(config => config.model)).toEqual(['large-model', 'small-model']);
    expect(provider.windowsAtQuery).toEqual([200_000, 32_000]);
    expect(session.observerContextWindowTokens).toBe(32_000);
    // Wrap-ups and telemetry read lastModelId, not the per-turn config: a
    // switched session must not bill the wrap-up on the previous model.
    expect(session.lastModelId).toBe('small-model');
  });
});
