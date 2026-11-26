// #6503: on the Claude provider, oversized-field condense calls ran with no
// output cap. CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS sized the condense ask on
// every HTTP provider (OpenAICompatibleProvider passes
// fieldCompressionMaxOutputTokens() into optimizeObservationFields), but the
// Claude call site never passed it, so the prompt asked for the full
// field-cap budget (12,800 chars at the 16k cap) and replies averaged ~3x
// their target — billed, then clipped by elision anyway.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { ClaudeProvider } from '../../src/services/worker/ClaudeProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

type QueuedMessage = Record<string, unknown>;

function makeSession(): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'condense-session',
    memorySessionId: 'mem-session-1',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'read the file',
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

function sessionManagerHolding(events: QueuedMessage[]): SessionManager {
  const queue = events.map((event, i) => ({ ...event, _persistentId: i + 1, _originalTimestamp: 1_000 + i }));
  return {
    getMessageIterator: async function* () {
      while (queue.length > 0) yield queue.shift();
    },
    claimNextObservation: mock((_sessionDbId: number, accepts: (m: QueuedMessage) => boolean) => {
      const head = queue[0];
      if (!head || head.type !== 'observation' || !accepts(head)) return null;
      return queue.shift();
    }),
    getClaimedMessages: mock(() => []),
    confirmClaimedMessages: mock(() => Promise.resolve(0)),
    resetProcessingToPending: mock(() => Promise.resolve(0)),
  } as unknown as SessionManager;
}

describe('Claude provider condense calls carry the observer output cap (#6503)', () => {
  let modeManagerSpy: ReturnType<typeof spyOn>;
  let settingsSpy: ReturnType<typeof spyOn>;
  let dbManager: DatabaseManager;
  let settingsOverrides: Record<string, string> = {};
  const answeringPacer = { mark: () => 0, waitForAnswer: async () => 'answered' };

  /** Drive one oversized observation through the generator with a recording compressor. */
  async function condenseBudgets(): Promise<{ budgets: number[]; prompts: string[] }> {
    const budgets: number[] = [];
    const compressField = mock(async (_text: string, budgetChars: number) => {
      budgets.push(budgetChars);
      return { text: 'condensed payload', truncated: false };
    });
    const provider = new ClaudeProvider(dbManager, sessionManagerHolding([{
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file_path: 'big.txt' },
      tool_response: 'x'.repeat(20_000),
      prompt_number: 1,
    }])) as any;
    const prompts: string[] = [];
    const generator = provider.createMessageGenerator(
      makeSession(), { lastCwd: undefined }, { current: null }, undefined, compressField, answeringPacer,
    );
    for await (const message of generator) prompts.push(String(message.message.content));
    return { budgets, prompts };
  }

  beforeEach(() => {
    settingsOverrides = {};
    const realMode = ModeManager.getInstance().loadMode('code');
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => realMode,
      loadMode: () => {},
    } as unknown as ModeManager));
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      ...settingsOverrides,
    }));
    dbManager = {
      getSessionStore: () => ({
        ensureMemorySessionIdRegistered: mock(() => {}),
        updateMemorySessionId: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
      }),
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-1' })),
    } as unknown as DatabaseManager;
  });

  afterEach(() => {
    modeManagerSpy.mockRestore();
    settingsSpy.mockRestore();
    mock.restore();
  });

  it('bounds the condense ask by CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS', async () => {
    settingsOverrides.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '3200';
    const { budgets, prompts } = await condenseBudgets();
    // Field cap 16,000 chars: the uncapped ask is 12,800. A 3,200-token cap
    // planned at 2 chars/token (FIELD_OPTIMIZE_OUTPUT_SAFETY) asks for 6,400.
    expect(budgets).toEqual([6400]);
    expect(prompts[0]).toContain('condensed payload');
  });

  it('bounds the condense ask by the default cap when the setting is unset', async () => {
    const { budgets } = await condenseBudgets();
    // Default cap 4,096 tokens -> 8,192 chars, still under the 12,800 ask.
    expect(budgets).toEqual([8192]);
  });

  it('skips the condense call when CLAUDE_MEM_FIELD_CONDENSE_ENABLED is false', async () => {
    const prior = process.env.CLAUDE_MEM_FIELD_CONDENSE_ENABLED;
    delete process.env.CLAUDE_MEM_FIELD_CONDENSE_ENABLED;
    try {
      settingsOverrides.CLAUDE_MEM_FIELD_CONDENSE_ENABLED = 'false';
      const { budgets, prompts } = await condenseBudgets();
      expect(budgets).toEqual([]);
      // The observation is still sent, with the field cut by head/tail elision.
      expect(prompts[0]).toContain('<elided');
      expect(prompts[0]).not.toContain('condensed payload');
    } finally {
      if (prior !== undefined) process.env.CLAUDE_MEM_FIELD_CONDENSE_ENABLED = prior;
    }
  });

  it('fieldCompressionMaxOutputTokens returns the configured cap', () => {
    const provider = new ClaudeProvider(dbManager, sessionManagerHolding([])) as unknown as {
      fieldCompressionMaxOutputTokens(): number;
    };
    expect(provider.fieldCompressionMaxOutputTokens()).toBe(4096);
    settingsOverrides.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = '3200';
    expect(provider.fieldCompressionMaxOutputTokens()).toBe(3200);
  });
});
