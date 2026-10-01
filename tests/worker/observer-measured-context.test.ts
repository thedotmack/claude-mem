import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import type { ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';

// #2957: the generation budget reads the context the provider actually
// measured, not only the character proxy. The proxy misses the system prompt
// and tool schemas a provider adds. The Claude half of these checks lives in
// claude-provider-response-pacing.test.ts, next to its fake SDK.

// bun's mock.module is process-global and sticky; snapshot and restore it.
const actualContextGenerator = { ...(await import('../../src/services/context-generator.js')) };
mock.module('../../src/services/context-generator.js', () => ({
  ...actualContextGenerator,
  generateContext: async () => '',
}));
afterAll(() => {
  mock.module('../../src/services/context-generator.js', () => actualContextGenerator);
});

const { ModeManager } = await import('../../src/services/domain/ModeManager.js');
const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
const { OpenAICompatibleProvider } = await import('../../src/services/worker/OpenAICompatibleProvider.js');
const { computeFullContextTokens } = await import('../../src/services/worker/ClaudeProvider.js');
const { openObserverGeneration } = await import('../../src/services/worker/session/recycle-conversation.js');
const {
  shouldRecycleConversation,
  generationUsageChars,
  OBSERVER_CONVERSATION_MAX_CHARS,
} = await import('../../src/shared/observer-recycle.js');
const { logger } = await import('../../src/utils/logger.js');

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

function makeSession(): ActiveSession {
  return {
    sessionDbId: 2957,
    contentSessionId: 'content-2957',
    memorySessionId: 'mem-2957',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 2,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: 'openrouter',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

function observation(i: number) {
  return { type: 'observation', tool_name: 'Read', tool_input: { file_path: `/repo/file-${i}.ts` }, tool_response: 'contents', prompt_number: 2 };
}

/** A buffer with claim semantics: a message stays pending until confirmed. */
function makeQueue(session: ActiveSession, messages: unknown[]) {
  const pending = [...messages];
  let claimed = false;
  return {
    pending,
    getMessageIterator: async function* () {
      while (pending.length > 0 && !session.abortController.signal.aborted) {
        claimed = true;
        yield pending[0];
      }
    },
    confirmClaimedMessages: async () => {
      if (claimed) pending.shift();
      claimed = false;
    },
    resetProcessingToPending: async () => {
      claimed = false;
      return 0;
    },
    getClaimedMessages: () => [],
    getMessageBuffer: () => ({ getPendingCount: () => pending.length }),
  };
}

/** Replies with the prompt-token readings it is given, one per request. */
class MeasuringProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  requests = 0;

  constructor(sessionManager: unknown, private readonly inputTokensPerRequest: number[]) {
    super({} as never, sessionManager as never);
  }

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(): Promise<ProviderQueryResult> {
    const inputTokens = this.inputTokensPerRequest[this.requests] ?? 100;
    this.requests += 1;
    return { content: this.requests === 1 ? 'ready' : 'ok', inputTokens, outputTokens: 5, tokensUsed: inputTokens + 5 };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  spies = [
    spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    }) as never),
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
      // A known 200k window keeps the budget at the 400k-char default.
      CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW: '200000',
    })),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  mock.restore();
});

describe('generation usage counts the measured context', () => {
  const small = [{ role: 'user' as const, content: 'x'.repeat(1_000) }];

  it('takes the larger of the character proxy and the measured tokens', () => {
    expect(generationUsageChars(small)).toBe(1_000);
    expect(generationUsageChars(small, 50)).toBe(1_000);
    expect(generationUsageChars(small, 150_000)).toBe(600_000);
  });

  it('recycles on a measured context past the budget even when the proxy is small', () => {
    expect(shouldRecycleConversation(small, OBSERVER_CONVERSATION_MAX_CHARS)).toBe(false);
    expect(shouldRecycleConversation(small, OBSERVER_CONVERSATION_MAX_CHARS, 100_000)).toBe(true);
    expect(shouldRecycleConversation(small, OBSERVER_CONVERSATION_MAX_CHARS, 99_999)).toBe(false);
  });

  it('sums fresh input, cache writes and cache reads as the context read', () => {
    expect(computeFullContextTokens({ input_tokens: 12, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 90_000 })).toBe(93_012);
    expect(computeFullContextTokens({ input_tokens: 40 })).toBe(40);
    expect(computeFullContextTokens(undefined)).toBe(0);
  });

  it('a new generation starts without the previous generation\'s reading', () => {
    const session = makeSession();
    session.lastContextTokens = 150_000;
    openObserverGeneration(session, 'init prompt');
    expect(session.lastContextTokens).toBeUndefined();
  });
});

describe('an HTTP provider feeds prompt_tokens into the budget', () => {
  it('recycles before the next send once a reply reports a context past the budget', async () => {
    const session = makeSession();
    const queue = makeQueue(session, [observation(0), observation(1), observation(2)]);
    // init, then a first observation whose request read 150k tokens.
    const provider = new MeasuringProvider(queue, [100, 150_000]);

    await provider.startSession(session);

    // The second observation was never sent: the generation retired first.
    expect(provider.requests).toBe(2);
    expect(session.abortReason).toBe('overflow:recycle');
    expect(queue.pending).toHaveLength(2);
  });

  it('ignores the init reading, so an oversized init cannot recycle every fresh generation', async () => {
    const session = makeSession();
    const queue = makeQueue(session, [observation(0), observation(1)]);
    const provider = new MeasuringProvider(queue, [150_000, 100, 100]);

    await provider.startSession(session);

    expect(provider.requests).toBe(3);
    expect(session.abortReason ?? null).toBeNull();
    expect(queue.pending).toHaveLength(0);
    expect(session.lastContextTokens).toBe(100);
  });
});
