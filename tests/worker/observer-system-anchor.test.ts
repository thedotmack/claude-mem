import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { buildContinuationPrompt, buildInitPrompt, splitFramingPrompt } from '../../src/sdk/prompts.js';
import {
  resolveObserverMaxOutputTokens,
  DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS,
} from '../../src/services/worker/context-window.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import type { OpenAIChatMessage } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { openObserverGeneration } from '../../src/services/worker/session/recycle-conversation.js';
import { logger } from '../../src/utils/logger.js';
import type { ModeConfig } from '../../src/services/domain/types.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';

// #3868: an observer generation's framing prompt (instructions + output schema)
// goes out as the system message, with the user's request as the first user
// turn; every HTTP request carries the configured output-token cap; and the
// provider's finish reason reaches the drop log so a truncation is named.

const CODE_MODE = JSON.parse(readFileSync(join(import.meta.dir, '../../plugin/modes/code.json'), 'utf8')) as ModeConfig;
const INIT_PROMPT = buildInitPrompt('test-project', 'content-3868', 'fix the login redirect', CODE_MODE, '');
const FRAMING: ConversationMessage = { role: 'user', content: INIT_PROMPT, framing: true };
const { instructions: INSTRUCTIONS, userRequest: USER_REQUEST } = splitFramingPrompt(INIT_PROMPT);

const OPENROUTER_CONFIG = {
  apiKey: 'test-key',
  model: 'test/model',
  fallbackModels: [],
  apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
};

const GEMINI_CONFIG = { apiKey: 'test-key', model: 'gemini-flash-latest', rateLimitingEnabled: false };

let outputTokensSetting = '';
let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  outputTokensSetting = '';
  spies = [
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      ...(outputTokensSetting ? { CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS: outputTokensSetting } : {}),
    })),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  mock.restore();
});

function chatResponse(content: string, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({
    model: 'test/model',
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sentBodies(fetchSpy: ReturnType<typeof spyOn>): Array<Record<string, any>> {
  return fetchSpy.mock.calls.map((call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)));
}

describe('splitFramingPrompt', () => {
  it('separates the instructions from the user-request block of an init prompt', () => {
    expect(USER_REQUEST).toContain('<user_request>fix the login redirect</user_request>');
    expect(USER_REQUEST).toStartWith('<observed_from_primary_session>');
    expect(INSTRUCTIONS).not.toContain('<user_request>');
    // The output schema stays with the instructions.
    expect(INSTRUCTIONS).toContain('<observation>');
  });

  it('splits a continuation prompt the same way', () => {
    const continuation = splitFramingPrompt(buildContinuationPrompt('keep going', 3, 'content-3868', CODE_MODE, 'Earlier: fixed the parser.'));
    expect(continuation.userRequest).toContain('<user_request>keep going</user_request>');
    expect(continuation.instructions).toContain('Earlier: fixed the parser.');
    expect(continuation.instructions).not.toContain('<user_request>');
  });

  it('leaves a prompt without a request block whole', () => {
    expect(splitFramingPrompt('Condense the tool payload below.')).toEqual({
      instructions: 'Condense the tool payload below.',
      userRequest: null,
    });
  });
});

class TestOpenRouterProvider extends OpenRouterProvider {
  buildMessages(history: ConversationMessage[]) {
    return (this as unknown as { conversationToOpenAIMessages(history: ConversationMessage[]): unknown })
      .conversationToOpenAIMessages(history);
  }

  runQuery(history: ConversationMessage[]) {
    return this.query(history, OPENROUTER_CONFIG as never);
  }
}

describe('OpenRouter requests anchor the framing prompt as the system message', () => {
  const provider = new TestOpenRouterProvider({} as never, {} as never);

  it('a generator start marks its init prompt as the framing prompt', () => {
    const session = { sessionDbId: 3868, conversationHistory: [] } as unknown as ActiveSession;
    openObserverGeneration(session, INIT_PROMPT);
    expect(session.conversationHistory).toEqual([FRAMING]);
  });

  it('sends the init request as system instructions plus the user request, never system-only', () => {
    expect(provider.buildMessages([FRAMING])).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: USER_REQUEST },
    ]);
  });

  it('keeps the anchor and role alternation on every later request', () => {
    expect(provider.buildMessages([
      FRAMING,
      { role: 'assistant', content: 'ready' },
      { role: 'user', content: 'observation 1' },
    ])).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: USER_REQUEST },
      { role: 'assistant', content: 'ready' },
      { role: 'user', content: 'observation 1' },
    ]);
  });

  it('merges the user request with the first observation when the init reply was empty', () => {
    expect(provider.buildMessages([FRAMING, { role: 'user', content: 'observation 1' }])).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: `${USER_REQUEST}\n\nobservation 1` },
    ]);
  });

  it('sends a standalone request (no framing prompt) exactly as before', () => {
    expect(provider.buildMessages([{ role: 'user', content: 'Condense the tool payload below.' }])).toEqual([
      { role: 'user', content: 'Condense the tool payload below.' },
    ]);
  });
});

// A provider prompt cache (OpenRouter, the cmem.ai gateway) hits only on a
// byte-identical prefix. Whatever differs between sessions (project, date,
// prior context, the continuation greeting) must follow the fixed observer
// instructions, or no two sessions share a cached start.
describe('every observer system message opens with the same fixed instructions', () => {
  const provider = new TestOpenRouterProvider({} as never, {} as never);

  /** The fixed pieces in prompt order; the observation schema's footer closes the block. */
  const FIXED_PIECES = [
    'system_identity', 'observer_role', 'spatial_awareness', 'recording_focus', 'skip_guidance',
    'output_format_header', 'type_guidance', 'field_guidance', 'concept_guidance', 'footer',
  ] as const;

  const BRIEFING_A = '# [acme-api] recent context, 2026-10-04 2:18pm PDT\nMode: Code Development (code)\n\n111 2:18p Fixed the auth redirect loop';
  const BRIEFING_B = '# [billing-web] recent context, 2026-10-05 9:02am PDT\nMode: Code Development (code)\n\n7 9:02a Traced the invoice rounding to toFixed(2)';

  /** The messages a provider sends for a generation opened on `day`. */
  function requestOn(day: string, framingPrompt: () => string): OpenAIChatMessage[] {
    setSystemTime(new Date(`${day}T12:00:00Z`));
    try {
      return provider.buildMessages([{ role: 'user', content: framingPrompt(), framing: true }]) as OpenAIChatMessage[];
    } finally {
      setSystemTime();
    }
  }

  const initA = () => requestOn('2026-10-04', () =>
    buildInitPrompt('acme-api', 'content-a', 'fix the login redirect', CODE_MODE, BRIEFING_A));
  const initB = () => requestOn('2026-10-05', () =>
    buildInitPrompt('billing-web', 'content-b', 'why are invoices off by a cent?', CODE_MODE, BRIEFING_B));
  const continuationB = () => requestOn('2026-10-05', () =>
    buildContinuationPrompt('now add a regression test', 4, 'content-b', CODE_MODE, BRIEFING_B));

  function systemOf(request: OpenAIChatMessage[]): string {
    expect(request[0].role).toBe('system');
    return request[0].content;
  }

  function sharedStart(a: string, b: string): string {
    let length = 0;
    while (length < a.length && length < b.length && a[length] === b[length]) length++;
    return a.slice(0, length);
  }

  function fixedBlockEnd(system: string): number {
    const footer = CODE_MODE.prompts.footer;
    return system.indexOf(footer) + footer.length;
  }

  function expectWholeFixedBlockShared(a: string, b: string): void {
    const shared = sharedStart(a, b);
    expect(FIXED_PIECES.filter(key => !shared.includes(CODE_MODE.prompts[key]))).toEqual([]);
    expect(shared.length).toBeGreaterThanOrEqual(fixedBlockEnd(a));
  }

  it('two sessions share the whole fixed block across their init generations', () => {
    expectWholeFixedBlockShared(systemOf(initA()), systemOf(initB()));
  });

  it('an init and a continuation generation share it too', () => {
    expectWholeFixedBlockShared(systemOf(initA()), systemOf(continuationB()));
  });

  it('sends the per-session text after the block and the dated request as the first user turn', () => {
    const init = initA();
    const continuation = continuationB();
    const initSystem = systemOf(init);
    const continuationSystem = systemOf(continuation);

    expect(initSystem.indexOf(BRIEFING_A)).toBeGreaterThan(fixedBlockEnd(initSystem));
    expect(continuationSystem.indexOf(CODE_MODE.prompts.continuation_greeting)).toBeGreaterThan(fixedBlockEnd(continuationSystem));
    expect(continuationSystem.indexOf(BRIEFING_B)).toBeGreaterThan(fixedBlockEnd(continuationSystem));
    expect(init[1].content).toContain('<requested_at>2026-10-04</requested_at>');
    expect(continuation[1].content).toContain('<requested_at>2026-10-05</requested_at>');
  });
});

describe('CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS', () => {
  it('defaults to 4096 and accepts only complete integers inside the bounds', () => {
    expect(resolveObserverMaxOutputTokens()).toBe(DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS);
    outputTokensSetting = '8192';
    expect(resolveObserverMaxOutputTokens()).toBe(8192);
    for (const invalid of ['2k', '100', '9999999', '-1', '4096.5']) {
      outputTokensSetting = invalid;
      expect(resolveObserverMaxOutputTokens()).toBe(DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS);
    }
  });

  it('reaches OpenRouter as max_tokens, and as max_completion_tokens on the compatibility retry', async () => {
    outputTokensSetting = '2048';
    let call = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            type: 'invalid_request_error',
            param: 'max_tokens',
            code: 'unsupported_parameter',
          },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      return chatResponse('<observation><type>bugfix</type></observation>');
    }) as unknown as typeof fetch);

    try {
      await new TestOpenRouterProvider({} as never, {} as never).runQuery([FRAMING]);

      const [first, retry] = sentBodies(fetchSpy);
      expect(first.max_tokens).toBe(2048);
      expect(first.messages[0]).toEqual({ role: 'system', content: INSTRUCTIONS });
      expect(retry.max_completion_tokens).toBe(2048);
      expect(retry).not.toHaveProperty('max_tokens');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('is the cap the cut-off warning names, and the finish reason travels with the result', async () => {
    outputTokensSetting = '2048';
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => chatResponse('<observation><type>bugfix</type><title>cut', 'length')) as unknown as typeof fetch);
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const result = await new TestOpenRouterProvider({} as never, {} as never).runQuery([FRAMING]);

      expect(result.finishReason).toBe('length');
      expect(warnSpy).toHaveBeenCalledWith('SDK', 'OpenRouter reply was cut off at the output-token limit', expect.objectContaining({ maxTokens: 2048 }));
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

class TestGeminiProvider extends GeminiProvider {
  runQuery(history: ConversationMessage[]) {
    return this.query(history, GEMINI_CONFIG as never);
  }
}

describe('Gemini parity', () => {
  function geminiResponse(text: string, finishReason: string): Response {
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 1024, totalTokenCount: 1924 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('sends the instructions as systemInstruction and the configured maxOutputTokens', async () => {
    outputTokensSetting = '1024';
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => geminiResponse('ok', 'STOP')) as unknown as typeof fetch);

    try {
      await new TestGeminiProvider({} as never, {} as never).runQuery([
        FRAMING,
        { role: 'assistant', content: 'ready' },
        { role: 'user', content: 'observation 1' },
      ]);

      const [body] = sentBodies(fetchSpy);
      expect(body.systemInstruction).toEqual({ parts: [{ text: INSTRUCTIONS }] });
      expect(body.contents).toEqual([
        { role: 'user', parts: [{ text: USER_REQUEST }] },
        { role: 'model', parts: [{ text: 'ready' }] },
        { role: 'user', parts: [{ text: 'observation 1' }] },
      ]);
      expect(body.generationConfig.maxOutputTokens).toBe(1024);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('names a MAX_TOKENS cut-off at WARN and returns the finish reason', async () => {
    outputTokensSetting = '1024';
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => geminiResponse('<observation><type>bugfix</type><title>cut', 'MAX_TOKENS')) as unknown as typeof fetch);
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      const result = await new TestGeminiProvider({} as never, {} as never).runQuery([FRAMING]);

      expect(result.finishReason).toBe('MAX_TOKENS');
      expect(warnSpy).toHaveBeenCalledWith('SDK', 'Gemini reply was cut off at the output-token limit', expect.objectContaining({
        maxTokens: 1024,
        outputTokens: 1024,
      }));
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('the drop log names a truncated reply', () => {
  function makeSession(): ActiveSession {
    return {
      sessionDbId: 3868,
      contentSessionId: 'content-3868',
      memorySessionId: 'mem-3868',
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
      claimedMessageIds: [1],
      conversationHistory: [],
      currentProvider: 'openrouter',
      consecutiveRestarts: 0,
      consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0,
      lastGeneratorActivity: Date.now(),
      lastGeneratorSource: 'ingest',
    } as ActiveSession;
  }

  const sessionManager = { confirmClaimedMessages: async () => 0, resetProcessingToPending: async () => 0 };
  const RETRY = 'OpenRouter returned non-XML xml response — asking for the queued batch again in a fresh generation';

  it('carries finishReason and truncated for a reply cut off at the cap, then forgets it', async () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const session = makeSession();
      session.lastFinishReason = 'length';

      await processAgentResponse('<observation><type>bugfix</type><title>cut', session, {} as never, sessionManager as never, undefined, 0, null, 'OpenRouter');

      expect(warnSpy).toHaveBeenCalledWith('PARSER', RETRY, expect.objectContaining({ finishReason: 'length', truncated: true }));
      expect(session.lastFinishReason).toBeNull();

      // The next reply, from any provider, does not inherit it.
      warnSpy.mockClear();
      session.abortController = new AbortController();
      session.claimedMessageIds = [2];
      await processAgentResponse('<observation><type>bugfix</type><title>cut', session, {} as never, sessionManager as never, undefined, 0, null, 'OpenRouter');
      const retry = warnSpy.mock.calls.find((call: unknown[]) => call[1] === RETRY);
      expect(retry?.[2]).not.toHaveProperty('finishReason');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
