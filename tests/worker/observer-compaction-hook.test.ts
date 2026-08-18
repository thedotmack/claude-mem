import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

// The compaction hook builds a real continuation prompt and a real timeline;
// both resolve the active mode through ModeManager.getInstance(). Mocked via
// spyOn (idiom: openai-compatible-history-accounting.test.ts) rather than
// loadMode('code'): an earlier test file's top-level mock.module of
// ModeManager can leak into this file (see SearchManager.timeline-anchor's
// snapshot workaround), and spyOn works on either the real class or a leaked
// stub. observation_types/observation_concepts must match the seeded
// observation so queryObservationsMulti's filters keep it.
const mockMode = {
  name: 'code',
  prompts: {},
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [{ id: 'how-it-works' }],
};

const PROJECT = 'test-project';
const SEEDED_TITLE = 'SEEDED_HOOK_OBS_TITLE';

// Pinned via the CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW settings override. The
// override clamps at MIN_CONTEXT_WINDOW_TOKENS (8,192), so this is the
// smallest window the hook can see: 0.7 trigger = 5,734 tokens.
const SMALL_WINDOW = '8192';
const SMALL_WINDOW_TOKENS = 8192;
// Large enough that init prompt + responses never reach the trigger.
const LARGE_WINDOW = '100000';
// 40k chars ≈ 10k tokens — past the 0.7 × 8,192 trigger.
const FILLER = 'f'.repeat(40_000);

let windowSetting = '';
let compactionSetting = 'true';
let loadFromFileSpy: ReturnType<typeof spyOn>;
let modeManagerSpy: ReturnType<typeof spyOn>;

function seedStore(): SessionStore {
  const store = new SessionStore(':memory:');
  const sessionDbId = store.createSDKSession('hook-content-session', PROJECT, 'test prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'hook-memory');
  store.storeObservation(
    'hook-memory',
    PROJECT,
    {
      type: 'discovery',
      title: SEEDED_TITLE,
      subtitle: null,
      facts: [],
      narrative: `narrative for ${SEEDED_TITLE}`,
      concepts: ['how-it-works'],
      files_read: [],
      files_modified: [],
    },
    1,
    0,
    1_700_000_000_000,
  );
  return store;
}

function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'test-session',
    memorySessionId: 'mem-session-123',
    project: PROJECT,
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

class HookTestProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'HookTest';
  protected readonly syntheticIdPrefix = 'openrouter';
  protected readonly forwardEmptyMessageResponse = false;
  private readonly responses: ProviderQueryResult[];
  /** Deep-copied history snapshot per query() call, for assertions. */
  public readonly queryHistories: ConversationMessage[][] = [];

  constructor(responses: ProviderQueryResult[], dbManager: unknown, sessionManager: unknown) {
    super(dbManager as any, sessionManager as any);
    this.responses = responses;
  }

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    this.queryHistories.push(history.map(m => ({ ...m })));
    return this.responses.shift() ?? { content: '' };
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
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

async function runObservationSession(store: SessionStore, opts: { filler?: string } = {}) {
  const sessionManager = makeSessionManager([
    { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 2, cwd: '/tmp/hook-cwd' },
  ]);
  const provider = new HookTestProvider(
    [{ content: 'init response text' }, { content: 'obs response text' }],
    { getSessionStore: () => store },
    sessionManager,
  );
  const session = makeSession();
  if (opts.filler) {
    session.conversationHistory.push({ role: 'user', content: opts.filler });
  }
  await provider.startSession(session);
  return { provider, session };
}

/**
 * Direct call to the private hook for exact boundary control: the trigger and
 * budget math must be tested against precise token counts, and startSession's
 * real init prompt/response would blur them.
 */
function invokeHook(
  provider: HookTestProvider,
  session: ActiveSession,
  contextWindowTokens: number,
  pendingMessageTokens = 0,
): void {
  (provider as unknown as {
    maybeCompactHistory(session: ActiveSession, mode: unknown, contextWindowTokens: number, lastCwd: string | undefined, pendingMessageTokens?: number): void;
  }).maybeCompactHistory(session, mockMode, contextWindowTokens, '/tmp/hook-cwd', pendingMessageTokens);
}

describe('OpenAICompatibleProvider compaction hook', () => {
  beforeEach(() => {
    windowSetting = '';
    compactionSetting = 'true';
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
      // Used by the timeline renderer (AgentFormatter.renderAgentTableRow).
      getTypeIcon: () => '*',
    } as any));
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW: windowSetting,
      CLAUDE_MEM_OBSERVER_COMPACTION_ENABLED: compactionSetting,
    }));
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    loadFromFileSpy.mockRestore();
    mock.restore();
  });

  it('compacts history past the trigger: the observation query sees the continuation prompt + timeline', async () => {
    const store = seedStore();
    try {
      windowSetting = SMALL_WINDOW;

      const { provider } = await runObservationSession(store, { filler: FILLER });

      // Query 0 = init (filler + init prompt), query 1 = the observation.
      expect(provider.queryHistories).toHaveLength(2);
      const obsHistory = provider.queryHistories[1];

      // Compacted: exactly the re-seeded user turn + the new observation prompt.
      expect(obsHistory).toHaveLength(2);
      const compacted = obsHistory[0];
      expect(compacted.role).toBe('user');
      // Continuation prompt embeds the original user request verbatim.
      expect(compacted.content).toContain('<user_request>test prompt</user_request>');
      expect(compacted.content).toContain('<recent_project_timeline>');
      expect(compacted.content).toContain('</recent_project_timeline>');
      // The seeded observation flowed through buildCompactionTimeline.
      expect(compacted.content).toContain(SEEDED_TITLE);
      // Dramatically shorter: the 40k-char filler is gone.
      const totalChars = obsHistory.reduce((sum, m) => sum + m.content.length, 0);
      expect(totalChars).toBeLessThan(FILLER.length);
      expect(compacted.content).not.toContain(FILLER);
    } finally {
      store.close();
    }
  });

  it('leaves history untouched below the trigger', async () => {
    const store = seedStore();
    try {
      windowSetting = LARGE_WINDOW;
      const infoSpy = spyOn(logger, 'info');

      const { provider } = await runObservationSession(store);

      // init user + init assistant + obs prompt — nothing cleared.
      const obsHistory = provider.queryHistories[1];
      expect(obsHistory).toHaveLength(3);
      for (const message of obsHistory) {
        expect(message.content).not.toContain('<recent_project_timeline>');
      }
      const compactionLogs = infoSpy.mock.calls.filter(call => call[1] === 'Observer history compacted');
      expect(compactionLogs).toHaveLength(0);
      infoSpy.mockRestore();
    } finally {
      store.close();
    }
  });

  it('leaves history untouched when CLAUDE_MEM_OBSERVER_COMPACTION_ENABLED is false, even over the trigger', async () => {
    const store = seedStore();
    try {
      windowSetting = SMALL_WINDOW;
      compactionSetting = 'false';

      const { provider } = await runObservationSession(store, { filler: FILLER });

      // filler + init user + init assistant + obs prompt — nothing cleared.
      const obsHistory = provider.queryHistories[1];
      expect(obsHistory).toHaveLength(4);
      expect(obsHistory[0].content).toBe(FILLER);
      for (const message of obsHistory) {
        expect(message.content).not.toContain('<recent_project_timeline>');
      }
    } finally {
      store.close();
    }
  });

  it('trigger boundary: ~600 estimated tokens at a 1000-token window does not compact (0.7 trigger = 700)', () => {
    const store = seedStore();
    try {
      const provider = new HookTestProvider([], { getSessionStore: () => store }, makeSessionManager([]));
      const session = makeSession();
      // estimateTokens is chars/4 → exactly 600 tokens, below the 700 trigger.
      const content = 'x'.repeat(600 * 4);
      session.conversationHistory.push({ role: 'user', content });

      invokeHook(provider, session, 1000);

      expect(session.conversationHistory).toHaveLength(1);
      expect(session.conversationHistory[0].content).toBe(content);
    } finally {
      store.close();
    }
  });

  it('trigger boundary: ~800 estimated tokens at a 1000-token window compacts (0.7 trigger = 700)', () => {
    const store = seedStore();
    try {
      const provider = new HookTestProvider([], { getSessionStore: () => store }, makeSessionManager([]));
      const session = makeSession();
      // Exactly 800 tokens, above the 700 trigger.
      const content = 'x'.repeat(800 * 4);
      session.conversationHistory.push({ role: 'user', content });

      invokeHook(provider, session, 1000);

      expect(session.conversationHistory).toHaveLength(1);
      const compacted = session.conversationHistory[0];
      expect(compacted.content).not.toBe(content);
      expect(compacted.content).toContain('<user_request>test prompt</user_request>');
    } finally {
      store.close();
    }
  });

  it('preserves the original history when compaction context cannot be built', () => {
    const getSessionStore = () => {
      throw new Error('database unavailable');
    };
    const provider = new HookTestProvider([], { getSessionStore }, makeSessionManager([]));
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: 'u'.repeat(2000) },
        { role: 'assistant', content: 'a'.repeat(2000) },
      ],
    });
    const originalHistory = session.conversationHistory.map(message => ({ ...message }));
    const warnSpy = spyOn(logger, 'warn');

    invokeHook(provider, session, 1000);

    expect(session.conversationHistory).toEqual(originalHistory);
    expect(warnSpy.mock.calls.some(call =>
      call[1] === 'Observer history compaction failed; preserving existing history'
    )).toBe(true);
    warnSpy.mockRestore();
  });

  it('budget: the compacted turn stays near REINJECT_BUDGET_RATIO of the window despite far larger seeded history', () => {
    const store = seedStore();
    try {
      // Seed observations whose token sum (~1,250; long titles so the rendered
      // timeline scales with what the budget walk keeps) far exceeds
      // 0.3 × 1000 = 300.
      for (let i = 0; i < 12; i++) {
        store.storeObservation(
          'hook-memory',
          PROJECT,
          {
            type: 'discovery',
            title: `BUDGET_OBS_${i}_${'x'.repeat(400)}`,
            subtitle: null,
            facts: [],
            narrative: `narrative ${i}`,
            concepts: ['how-it-works'],
            files_read: [],
            files_modified: [],
          },
          1,
          0,
          1_700_000_000_000 + i * 1000,
        );
      }
      const provider = new HookTestProvider([], { getSessionStore: () => store }, makeSessionManager([]));
      const session = makeSession();
      session.conversationHistory.push({ role: 'user', content: FILLER });

      invokeHook(provider, session, 1000);

      expect(session.conversationHistory).toHaveLength(1);
      const afterTokens = Math.ceil(session.conversationHistory[0].content.length / 4);
      // 0.3 × 1000 budget plus a small allowance for the continuation prompt
      // (~220 tokens with the mock mode) and timeline wrapper overhead. A 3×
      // budget typo would re-inject ~600+ tokens of observation titles and
      // blow well past this bound.
      expect(afterTokens).toBeLessThanOrEqual(300 + 250);
    } finally {
      store.close();
    }
  });

  it('bounds an oversized tool payload embedded in the observation prompt', async () => {
    const store = seedStore();
    try {
      windowSetting = SMALL_WINDOW;
      // 12,000-char tool output (PR #3516 review repro): the cap is
      // floor(8,192 × 0.25) × 4 = 8,192 chars per payload, so
      // JSON.stringify's 12,002 chars must drop 3,810.
      const bigPayload = 'p'.repeat(12_000);
      const sessionManager = makeSessionManager([
        { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: bigPayload, prompt_number: 2, cwd: '/tmp/hook-cwd' },
      ]);
      const provider = new HookTestProvider(
        [{ content: 'init response text' }, { content: 'obs response text' }],
        { getSessionStore: () => store },
        sessionManager,
      );
      await provider.startSession(makeSession());

      const obsHistory = provider.queryHistories[1];
      const obsPrompt = obsHistory[obsHistory.length - 1].content;
      expect(obsPrompt).not.toContain(bigPayload);
      expect(obsPrompt).toContain('…[truncated 3810 chars]');
    } finally {
      store.close();
    }
  });

  it('escaped payloads: the post-compaction observation request stays within the window', async () => {
    const store = seedStore();
    try {
      windowSetting = SMALL_WINDOW;
      // Backslash-heavy payload: buildObservationPrompt re-encodes payloads
      // with JSON escaping, doubling escaped content, so bounding the raw
      // JSON alone under-counts (PR #3516 review, escaped-payload repro).
      // The prompt-cap halving loop must keep the dispatched request within
      // the window even right after a compact.
      const escapedPayload = '\\'.repeat(12_000);
      const sessionManager = makeSessionManager([
        { type: 'observation', tool_name: 'Read', tool_input: {}, tool_response: escapedPayload, prompt_number: 2, cwd: '/tmp/hook-cwd' },
      ]);
      const provider = new HookTestProvider(
        [{ content: 'init response text' }, { content: 'obs response text' }],
        { getSessionStore: () => store },
        sessionManager,
      );
      const session = makeSession();
      session.conversationHistory.push({ role: 'user', content: FILLER });
      await provider.startSession(session);

      const obsHistory = provider.queryHistories[1];
      const totalTokens = Math.ceil(obsHistory.reduce((sum, m) => sum + m.content.length, 0) / 4);
      expect(totalTokens).toBeLessThanOrEqual(SMALL_WINDOW_TOKENS);
    } finally {
      store.close();
    }
  });

  it('summary reservation: the post-compaction summary request stays within the window and bounds the assistant message', async () => {
    const store = seedStore();
    try {
      windowSetting = SMALL_WINDOW;
      // The dispatched summary prompt is the full buildSummaryPrompt output —
      // scaffold plus last_assistant_message — so the reservation must cover
      // that exact string, and an oversized assistant message must be bounded
      // (PR #3516 review, summary-overflow repro).
      const bigAssistantMessage = 'a'.repeat(40_000);
      const sessionManager = makeSessionManager([
        { type: 'summarize', last_assistant_message: bigAssistantMessage },
      ]);
      const provider = new HookTestProvider(
        [{ content: 'init response text' }, { content: '' }],
        { getSessionStore: () => store },
        sessionManager,
      );
      const session = makeSession();
      session.conversationHistory.push({ role: 'user', content: FILLER });
      await provider.startSession(session);

      const summaryHistory = provider.queryHistories[1];
      const summaryPrompt = summaryHistory[summaryHistory.length - 1].content;
      expect(summaryPrompt).not.toContain(bigAssistantMessage);
      expect(summaryPrompt).toContain('…[truncated');
      const totalTokens = Math.ceil(summaryHistory.reduce((sum, m) => sum + m.content.length, 0) / 4);
      expect(totalTokens).toBeLessThanOrEqual(SMALL_WINDOW_TOKENS);
    } finally {
      store.close();
    }
  });

  it('trigger reservation: a 600-token history compacts when the pending message adds 200 tokens', () => {
    const store = seedStore();
    try {
      const provider = new HookTestProvider([], { getSessionStore: () => store }, makeSessionManager([]));
      const session = makeSession();
      // 600 tokens alone is below the 700 trigger (pinned by the boundary
      // test above), but the pending message's 200 tokens push it past.
      const content = 'x'.repeat(600 * 4);
      session.conversationHistory.push({ role: 'user', content });

      invokeHook(provider, session, 1000, 200);

      expect(session.conversationHistory).toHaveLength(1);
      const compacted = session.conversationHistory[0];
      expect(compacted.content).not.toBe(content);
      expect(compacted.content).toContain('<user_request>test prompt</user_request>');
    } finally {
      store.close();
    }
  });

  it('budget reservation: pending message tokens are subtracted from the reinject budget', () => {
    const store = seedStore();
    try {
      const provider = new HookTestProvider([], { getSessionStore: () => store }, makeSessionManager([]));
      const session = makeSession();
      session.conversationHistory.push({ role: 'user', content: FILLER });

      // 300 pending tokens consume the entire 0.3 × 1000 reinject budget, so
      // no timeline fits — the re-seeded turn is the continuation prompt only.
      invokeHook(provider, session, 1000, 300);

      expect(session.conversationHistory).toHaveLength(1);
      const compacted = session.conversationHistory[0];
      expect(compacted.content).toContain('<user_request>test prompt</user_request>');
      expect(compacted.content).not.toContain('<recent_project_timeline>');
    } finally {
      store.close();
    }
  });

  it('logs "Observer history compacted" with beforeTokens > afterTokens', async () => {
    const store = seedStore();
    try {
      windowSetting = SMALL_WINDOW;
      const infoSpy = spyOn(logger, 'info');

      await runObservationSession(store, { filler: FILLER });

      const compactionLogs = infoSpy.mock.calls.filter(call => call[1] === 'Observer history compacted');
      expect(compactionLogs).toHaveLength(1);
      const data = compactionLogs[0][2] as {
        beforeMessages: number;
        beforeTokens: number;
        afterTokens: number;
        contextWindowTokens: number;
      };
      // filler + init prompt + init assistant response were in history.
      expect(data.beforeMessages).toBe(3);
      expect(data.beforeTokens).toBeGreaterThan(data.afterTokens);
      expect(data.contextWindowTokens).toBe(SMALL_WINDOW_TOKENS);
      infoSpy.mockRestore();
    } finally {
      store.close();
    }
  });
});
