import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import type { ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';

// #3625: the observer's budgets now scale with the model's context window, and
// an HTTP context-length refusal recycles the generation the way Claude's
// text-form "Prompt is too long" does, instead of finalizing the session.

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
const { OpenRouterProvider, classifyOpenRouterError } = await import('../../src/services/worker/OpenRouterProvider.js');
const { classifyGeminiError } = await import('../../src/services/worker/GeminiProvider.js');
const { handleGeneratorExit } = await import('../../src/services/worker/session/GeneratorExitHandler.js');
const { __resetContextWindowCacheForTests } = await import('../../src/services/worker/context-window.js');
const { OBS_PROMPT_FIELD_MAX_CHARS } = await import('../../src/sdk/prompts.js');
const { logger } = await import('../../src/utils/logger.js');

// OpenAI's (and OpenRouter's, and vLLM's) answer to an over-window request.
const OPENAI_CONTEXT_BODY = JSON.stringify({
  error: {
    message: "This model's maximum context length is 16385 tokens. However, your messages resulted in 20012 tokens. Please reduce the length of the messages.",
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
  },
});

// llama.cpp's server, the 16k local model in the #3868 field report.
const LLAMA_CPP_CONTEXT_BODY = JSON.stringify({
  error: {
    code: 400,
    message: 'the request exceeds the available context size, try increasing it',
    type: 'exceed_context_size_error',
    n_prompt_tokens: 20012,
    n_ctx: 16384,
  },
});

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

function makeSession(): ActiveSession {
  return {
    sessionDbId: 3625,
    contentSessionId: 'content-3625',
    memorySessionId: 'mem-3625',
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

function observation(i: number, payloadChars: number) {
  return {
    type: 'observation',
    tool_name: 'Read',
    tool_input: { file_path: `/repo/file-${i}.ts` },
    tool_response: `${i}:`.padEnd(payloadChars, 'y'),
    prompt_number: 2,
  };
}

/**
 * A buffer with claim semantics: a message stays pending until the response
 * path confirms it, and a reset hands the same message to the next generation.
 */
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
    resetProcessingToPending: mock(async () => {
      claimed = false;
      return 0;
    }),
    getClaimedMessages: () => [],
    getMessageBuffer: () => ({ getPendingCount: () => pending.length }),
    removeSessionImmediate: mock(() => {}),
  };
}

let contextWindowSetting = '';
let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  __resetContextWindowCacheForTests();
  contextWindowSetting = '';
  spies = [
    spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    }) as never),
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
      CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW: contextWindowSetting,
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

describe('context-length refusals classify as context_overflow', () => {
  const cause = new Error('upstream refused');

  it('an OpenAI-style maximum-context 400', () => {
    expect(classifyOpenRouterError({ status: 400, bodyText: OPENAI_CONTEXT_BODY, cause }).kind).toBe('context_overflow');
  });

  it("llama.cpp's exceed_context_size_error 400", () => {
    expect(classifyOpenRouterError({ status: 400, bodyText: LLAMA_CPP_CONTEXT_BODY, cause }).kind).toBe('context_overflow');
  });

  it('a 413 from a server or proxy that refused the request size', () => {
    expect(classifyOpenRouterError({ status: 413, bodyText: 'Request Entity Too Large', cause }).kind).toBe('context_overflow');
  });

  it('"context limit exceeded" is not mistaken for a spend limit', () => {
    expect(classifyOpenRouterError({ status: 400, bodyText: 'context limit exceeded', cause }).kind).toBe('context_overflow');
  });

  it('an ordinary bad request stays unrecoverable', () => {
    const error = classifyOpenRouterError({
      status: 400,
      bodyText: JSON.stringify({ error: { message: 'temperature must be between 0 and 2' } }),
      cause,
    });
    expect(error.kind).toBe('unrecoverable');
  });

  it('a retired model stays unrecoverable with its own code', () => {
    const error = classifyOpenRouterError({ status: 404, bodyText: 'No endpoints found for test/model.', cause });
    expect(error.kind).toBe('unrecoverable');
    expect(error.code).toBe('model_unavailable');
  });

  it("Gemini's input-token-count 400", () => {
    const bodyText = JSON.stringify({ error: { code: 400, message: 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).' } });
    expect(classifyGeminiError({ status: 400, bodyText, cause }).kind).toBe('context_overflow');
  });

  it('other Gemini 400s stay unrecoverable', () => {
    const bodyText = JSON.stringify({ error: { message: 'Please ensure that multiturn requests alternate between user and model.' } });
    expect(classifyGeminiError({ status: 400, bodyText, cause }).kind).toBe('unrecoverable');
  });
});

/** Answers the init prompt, then refuses the observation as too long. */
class RefusingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;

  constructor(sessionManager: unknown, private readonly refuseAt: 'init' | 'observation') {
    super({} as never, sessionManager as never);
  }

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    if (history.length === 1 && this.refuseAt === 'observation') {
      return { content: 'ready' };
    }
    throw classifyOpenRouterError({ status: 400, bodyText: OPENAI_CONTEXT_BODY, cause: new Error('400') });
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

describe('an HTTP context-length refusal recycles the generation', () => {
  for (const refuseAt of ['init', 'observation'] as const) {
    it(`at the ${refuseAt} request: the batch is preserved and a fresh generation resumes`, async () => {
      const session = makeSession();
      const queue = makeQueue(session, [observation(0, 500)]);
      const provider = new RefusingProvider(queue, refuseAt);

      // Resolves: the refusal is handled here, not rethrown as a failure.
      await provider.startSession(session);

      expect(session.abortReason).toBe('overflow:recycle');
      expect(session.forceInit).toBe(true);
      expect(session.conversationHistory).toEqual([]);
      expect(queue.resetProcessingToPending).toHaveBeenCalled();
      expect(queue.pending).toHaveLength(1);

      const finalizeSession = mock(() => Promise.resolve());
      await handleGeneratorExit(session, session.abortReason, {
        sessionManager: queue as never,
        completionHandler: { finalizeSession } as never,
      });
      expect(finalizeSession).not.toHaveBeenCalled();
      expect(queue.removeSessionImmediate).not.toHaveBeenCalled();
    });
  }

  it('end to end through OpenRouterProvider: a 400 context body recycles, it does not finalize', async () => {
    class TestOpenRouterProvider extends OpenRouterProvider {
      protected getConfig() {
        return { apiKey: 'test-key', model: 'test/model', fallbackModels: [], apiUrl: 'http://localhost:8080/v1/chat/completions' };
      }
    }
    let chatRequests = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      chatRequests += 1;
      if (chatRequests === 1) {
        return new Response(JSON.stringify({ model: 'test/model', choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(LLAMA_CPP_CONTEXT_BODY, { status: 400, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch);

    try {
      const session = makeSession();
      const queue = makeQueue(session, [observation(0, 500)]);
      const provider = new TestOpenRouterProvider({} as never, queue as never);

      await provider.startSession(session);

      // One init request, one refused observation request, no retries of it.
      expect(chatRequests).toBe(2);
      expect(session.abortReason).toBe('overflow:recycle');
      expect(queue.pending).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/** Records every request; condenses an oversized field like a real model would. */
class RecordingProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'TestProvider';
  protected readonly syntheticIdPrefix = 'test';
  protected readonly forwardEmptyMessageResponse = false;
  readonly requestChars: number[] = [];
  readonly condenseBudgets: number[] = [];

  protected getConfig() {
    return { apiKey: 'test-api-key', model: 'session-model' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing key');
  }

  protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
    const condense = history.length === 1 && history[0].content.match(/^Condense the tool payload below to under (\d+) characters/);
    if (condense) {
      this.condenseBudgets.push(Number(condense[1]));
      return { content: 'condensed payload' };
    }
    this.requestChars.push(history.reduce((sum, message) => sum + message.content.length, 0));
    return { content: history.length === 1 ? 'ready' : 'ok' };
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

describe('a 16k-window model (the #3868 field report)', () => {
  const WINDOW_TOKENS = 16_384;
  const CHARS_PER_TOKEN = 4;

  it('keeps every request inside the window: generations retire at half of it', async () => {
    contextWindowSetting = String(WINDOW_TOKENS);
    const session = makeSession();
    // 6k-char payloads fit the 16k field cap (6,553 chars); 60 of them are
    // ~360k chars, which a fixed 400k-char budget would send in one generation.
    const queue = makeQueue(session, Array.from({ length: 60 }, (_, i) => observation(i, 6_000)));
    const provider = new RecordingProvider({} as never, queue as never);

    let generations = 0;
    while (queue.pending.length > 0 && generations < 100) {
      generations += 1;
      session.abortController = new AbortController();
      session.abortReason = null;
      await provider.startSession(session);
    }

    // Every observation was answered, over several generations...
    expect(queue.pending).toHaveLength(0);
    expect(generations).toBeGreaterThan(1);
    expect(session.observerContextWindowTokens).toBe(WINDOW_TOKENS);
    // ...and no request came close to the window: the largest is one budget
    // (half the window) plus the prompt that crossed it.
    const largestRequestTokens = Math.max(...provider.requestChars) / CHARS_PER_TOKEN;
    expect(largestRequestTokens).toBeLessThan(WINDOW_TOKENS * 0.75);
  });

  it('condenses a field past a tenth of the window, which the fixed 16k-char cap would have sent whole', async () => {
    contextWindowSetting = String(WINDOW_TOKENS);
    const session = makeSession();
    const queue = makeQueue(session, [observation(0, 10_000)]);
    const provider = new RecordingProvider({} as never, queue as never);

    await provider.startSession(session);

    expect(provider.condenseBudgets).toHaveLength(1);
    expect(provider.condenseBudgets[0]).toBeLessThan(Math.floor(WINDOW_TOKENS * 0.1 * CHARS_PER_TOKEN));
    expect(10_000).toBeLessThan(OBS_PROMPT_FIELD_MAX_CHARS);
  });
});
