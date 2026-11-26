import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import codeMode from '../../plugin/modes/code.json';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

const mockMode = {
  name: 'code',
  prompts: codeMode.prompts,
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

type TestConfig = { apiKey: string; model: string; summaryModel?: string };

class TestProvider extends OpenAICompatibleProvider<TestConfig> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  readonly queriedModels: string[] = [];
  config: TestConfig = { apiKey: 'test-api-key', model: 'session-model' };
  /** Simulated host resolution: only a message from this cwd gets the host models. */
  hostCwd?: string;
  hostConfig?: TestConfig;

  protected getConfig(): TestConfig {
    return this.config;
  }

  protected override configForSession(_session: ActiveSession, host?: { cwd?: string }): TestConfig {
    const config = this.getConfig();
    if (!this.hostCwd || host?.cwd !== this.hostCwd || !this.hostConfig) return config;
    return { ...config, ...this.hostConfig };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(_history: ConversationMessage[], config: TestConfig): Promise<ProviderQueryResult> {
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

    expect(provider.queriedModels).toEqual(['session-model', 'summary-model']);
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

    expect(provider.queriedModels).toEqual(['session-model']);
  });

  it('observer-model-summary-composition: observation and summary both use the session observer model', async () => {
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

    await provider.startSession(makeSession({ observerModel: 'session-model' }));

    expect(provider.queriedModels).toEqual(['session-model', 'summary-model']);
  });

  it('observer-model-isolation: modelOverride and observedModel never become the observer model', async () => {
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

    await provider.startSession(makeSession({
      observerModel: 'session-model',
      modelOverride: 'claude-tier-model',
      observedModel: 'ide-observed-model',
    }));

    expect(provider.queriedModels).toEqual(['session-model', 'summary-model']);
  });

  it('observer-model tier-disabled: routing off keeps the summary on the session observer model', async () => {
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

    await provider.startSession(makeSession({ observerModel: 'session-model' }));

    expect(provider.queriedModels).toEqual(['session-model']);
  });

  it('host-mode-summary-composition: host main model drives observations and host small model drives summaries', async () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
      CLAUDE_MEM_TIER_SUMMARY_MODEL: '',
    }));

    const provider = new TestProvider({} as any, {
      getMessageIterator: async function* () {
        yield { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2, cwd: '/tmp/host-project' };
        yield { type: 'summarize', last_assistant_message: 'done', cwd: '/tmp/host-project' };
      },
    } as any);
    provider.hostCwd = '/tmp/host-project';
    provider.hostConfig = { model: 'main-hote', summaryModel: 'small-hote' };
    const session = makeSession();

    await provider.startSession(session);

    expect(provider.queriedModels).toEqual(['main-hote', 'small-hote']);
    // The per-turn refresh carried by #6493 records the model that actually
    // served the turn; in host mode that is the translated host main model.
    expect(session.lastModelId).toBe('main-hote');
  });

  it('host-mode-summary-routing-disabled: routing off keeps the summary on the host main model', async () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
      CLAUDE_MEM_TIER_SUMMARY_MODEL: '',
    }));

    const provider = new TestProvider({} as any, {
      getMessageIterator: async function* () {
        yield { type: 'summarize', last_assistant_message: 'done', cwd: '/tmp/host-project' };
      },
    } as any);
    provider.hostCwd = '/tmp/host-project';
    provider.hostConfig = { model: 'main-hote', summaryModel: 'small-hote' };

    await provider.startSession(makeSession());

    expect(provider.queriedModels).toEqual(['main-hote']);
  });

  it('reuses the persisted synthetic id when an in-memory session restarts', async () => {
    const updateMemorySessionId = mock(() => {});
    const provider = new TestProvider({
      getSessionById: () => ({ memory_session_id: 'test-test-session-1234' }),
      getSessionStore: () => ({ updateMemorySessionId }),
    } as any, {
      getMessageIterator: async function* () {},
    } as any);
    const session = makeSession({ memorySessionId: null });

    await provider.startSession(session);

    expect(session.memorySessionId).toBe('test-test-session-1234');
    expect(updateMemorySessionId).not.toHaveBeenCalled();
  });

  for (const persistedId of ['other-test-session-1234', 'cfb67f1b-3c77-4bf9-b28b-64efe2d49864']) {
    it(`preserves stored memories when switching from ${persistedId}`, async () => {
      const store = new SessionStore(':memory:', { syncOpsEnabled: true });
      try {
        const sessionDbId = store.createSDKSession('test-session', 'test-project', 'test prompt');
        store.updateMemorySessionId(sessionDbId, persistedId);
        store.saveUserPrompt('test-session', 1, 'test prompt', sessionDbId);
        const observation = {
          type: 'discovery', title: 'A stable fact', subtitle: null, narrative: 'The same narrative',
          facts: [], concepts: [], files_read: ['src/file.ts'], files_modified: [],
        };
        const first = store.storeObservation(persistedId, 'test-project', observation);
        const before = store.db.query('SELECT * FROM observations WHERE id = ?').get(first.id);
        const promptBefore = store.db.query('SELECT * FROM user_prompts').get();
        const provider = new TestProvider({
          getSessionById: (id: number) => store.getSessionById(id),
          getSessionStore: () => store,
        } as any, { getMessageIterator: async function* () {} } as any);

        // SessionManager reloads the in-memory identity as null, including
        // after the user selects another provider. Its database identity is
        // still the owner of these observations, not a provider resume token.
        const session = makeSession({ sessionDbId, memorySessionId: null });
        await provider.startSession(session);

        const redelivery = store.storeObservation(session.memorySessionId!, 'test-project', observation);
        expect(redelivery.id).toBe(first.id);
        expect(session.memorySessionId).toBe(persistedId);
        expect(store.db.query('SELECT * FROM observations WHERE id = ?').get(first.id)).toEqual(before);
        expect(store.db.query('SELECT * FROM user_prompts').get()).toEqual(promptBefore);
        expect(store.db.query('SELECT COUNT(*) AS n FROM sync_outbox').get()).toEqual({ n: 0 });
        expect(store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
        expect(provider.queriedModels).toEqual([]);
      } finally {
        store.close();
      }
    });
  }

  it('creates and persists a synthetic identity for a session without one', async () => {
    const updateMemorySessionId = mock(() => {});
    const provider = new TestProvider({
      getSessionById: () => ({ memory_session_id: null }),
      getSessionStore: () => ({ updateMemorySessionId }),
    } as any, { getMessageIterator: async function* () {} } as any);
    const session = makeSession({ memorySessionId: null });

    await provider.startSession(session);

    expect(session.memorySessionId).toStartWith('test-test-session-');
    expect(updateMemorySessionId).toHaveBeenCalledTimes(1);
    expect(updateMemorySessionId).toHaveBeenCalledWith(1, session.memorySessionId);
  });
});
