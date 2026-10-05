// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ModeConfig } from '../../src/services/domain/types.js';
import type { ObserverRequestLabel } from '../../src/services/worker/OpenAICompatibleProvider.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

// Requests that reach OpenRouter carry `session_id` (one per observed session:
// OpenRouter's sticky-routing key and PostHog's $ai_session_id) and a `trace`
// whose `trace_id` is one per observer generation (PostHog's $ai_trace_id),
// with the request kind as `generation_name` and the client version. Both go
// to openrouter.ai and to the cmem gateway, which forwards the body there. No
// other endpoint gets either: strict OpenAI-compatible servers reject unknown
// body fields. `user` is never sent; the gateway sets it server-side.

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
const { OpenRouterProvider, buildOpenRouterRequestBody } = await import('../../src/services/worker/OpenRouterProvider.js');
const { anonymousSessionId } = await import('../../src/services/worker/OpenAICompatibleProvider.js');
const { OpenAICompatProvider } = await import('../../src/services/worker/OpenAICompatProvider.js');
const { resolveOpenAICompatPreset } = await import('../../src/shared/openai-compat-presets.js');
const { logger } = await import('../../src/utils/logger.js');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GATEWAY_URL = 'https://cmem.ai/api/inference/v1/chat/completions';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const OBSERVATION: ObserverRequestLabel = { kind: 'observation', sessionId: 'session-1', generationId: 'generation-1' };
const CODE_MODE = JSON.parse(readFileSync(join(import.meta.dir, '../../plugin/modes/code.json'), 'utf8')) as ModeConfig;

const base = {
  model: 'vendor/model',
  fallbackModels: [],
  messages: [{ role: 'user' as const, content: 'observe' }],
  maxOutputTokens: 4096,
};

/** The whole trace: ids, fixed names and the client version, nothing from the session. */
function expectedTrace(kind: ObserverRequestLabel['kind'], traceId?: string) {
  return {
    ...(traceId === undefined ? {} : { trace_id: traceId }),
    trace_name: 'claude-mem observer',
    generation_name: kind,
    // Stamped by the build; '0.0.0-dev' when run from source.
    claude_mem_version: expect.stringMatching(/^\d+\.\d+\.\d+/),
  };
}

function chatResponse(promptTokens = 100): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sentBodies(fetchSpy: ReturnType<typeof spyOn>): Array<Record<string, any>> {
  return fetchSpy.mock.calls.map((call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)));
}

let spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  spies = [
    spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => CODE_MODE,
      loadMode: () => {},
    }) as never),
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
      // A known window: no catalog fetch, and a 400k-char generation budget.
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

describe('session_id and trace in the OpenRouter request body', () => {
  for (const apiUrl of [OPENROUTER_URL, GATEWAY_URL]) {
    it(`are sent to ${new URL(apiUrl).hostname}, and user is not`, () => {
      const body = buildOpenRouterRequestBody({ ...base, apiUrl, label: OBSERVATION });
      expect(body.session_id).toBe('session-1');
      expect(body.trace).toEqual(expectedTrace('observation', 'generation-1'));
      expect(body).not.toHaveProperty('user');
    });
  }

  it('are never sent to another endpoint behind the OpenRouter provider', () => {
    for (const apiUrl of [
      'https://api.deepseek.com/chat/completions',
      'http://localhost:1234/v1/chat/completions',
      'https://gateway.example/v1/chat/completions',
      'https://openrouter.ai.example.com/api/v1/chat/completions',
    ]) {
      const body = buildOpenRouterRequestBody({ ...base, apiUrl, label: OBSERVATION });
      expect(body).not.toHaveProperty('session_id');
      expect(body).not.toHaveProperty('trace');
    }
  });

  it('carry no trace_id for the wrap-up, which belongs to no generation', () => {
    const body = buildOpenRouterRequestBody({
      ...base, apiUrl: GATEWAY_URL, plainText: true, label: { kind: 'telegram_wrapup', sessionId: 'session-1' },
    });
    expect(body.session_id).toBe('session-1');
    expect(body.trace).toEqual(expectedTrace('telegram_wrapup'));
  });
});

describe('anonymousSessionId', () => {
  it('is a stable one-way hash that never carries the session id', () => {
    const id = anonymousSessionId('content-4401');
    expect(id).toMatch(SHA256_HEX);
    expect(id).not.toContain('content-4401');
    expect(anonymousSessionId('content-4401')).toBe(id);
    expect(anonymousSessionId('content-4402')).not.toBe(id);
  });
});

describe('the openai-compatible provider', () => {
  it('never sends them to a preset endpoint, even when handed a label', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => chatResponse()) as unknown as typeof fetch);
    try {
      for (const presetId of ['opper', 'api-route']) {
        const preset = resolveOpenAICompatPreset(presetId);
        const provider = new OpenAICompatProvider({} as never, {} as never) as unknown as {
          query(...args: unknown[]): Promise<unknown>;
        };
        await provider.query(base.messages, {
          apiKey: 'preset-fixture',
          apiKeys: ['preset-fixture'],
          model: preset.defaultModel || 'vendor/model',
          apiUrl: `${preset.baseUrl}/chat/completions`,
          preset,
          requiresApiKey: true,
        }, undefined, undefined, undefined, OBSERVATION);
      }

      const bodies = sentBodies(fetchSpy);
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(body).not.toHaveProperty('session_id');
        expect(body).not.toHaveProperty('trace');
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

function makeSession(): ActiveSession {
  return {
    sessionDbId: 4401,
    contentSessionId: 'content-4401',
    memorySessionId: 'mem-4401',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'fix the login redirect',
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

function observation(i: number, toolResponse = 'contents') {
  return { type: 'observation', tool_name: 'Read', tool_input: { file_path: `/repo/file-${i}.ts` }, tool_response: toolResponse, prompt_number: 2 };
}

/** A buffer with claim semantics: a message stays pending until confirmed. */
function makeQueue(session: ActiveSession, messages: unknown[]) {
  const pending = [...messages];
  let claimed = false;
  return {
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

/** The real OpenRouter provider, pinned to one endpoint instead of reading settings for it. */
class EndpointProvider extends OpenRouterProvider {
  constructor(sessionManager: unknown, private readonly endpoint: { apiUrl: string; apiKey: string }) {
    super({} as never, sessionManager as never);
  }

  protected getConfig() {
    return {
      apiKey: this.endpoint.apiKey,
      apiKeys: [this.endpoint.apiKey],
      model: 'vendor/model',
      fallbackModels: [],
      apiUrl: this.endpoint.apiUrl,
    };
  }
}

describe('across a history reset', () => {
  const endpoints = [
    { apiUrl: GATEWAY_URL, apiKey: 'cm_pro_0123456789abcdef01234567' },
    { apiUrl: OPENROUTER_URL, apiKey: 'sk-or-v1-fixture' },
  ];

  for (const endpoint of endpoints) {
    it(`session_id holds and trace_id changes (${new URL(endpoint.apiUrl).hostname})`, async () => {
      const session = makeSession();
      const queue = makeQueue(session, [
        observation(0),
        // Over the per-field cap, so it is condensed by a request of its own first.
        observation(1, 'tool output line\n'.repeat(2_500)),
        observation(2),
        { type: 'summarize', last_assistant_message: 'done' },
      ]);
      // The third request (observation 1) reads a context past the generation
      // budget, so the conversation is retired before observation 2 (#3800).
      const promptTokens = [100, 100, 150_000];
      const fetchSpy = spyOn(globalThis, 'fetch')
        .mockImplementation((async () => chatResponse(promptTokens.shift())) as unknown as typeof fetch);
      try {
        const provider = new EndpointProvider(queue, endpoint);
        await provider.startSession(session);
        expect(session.abortReason).toBe('overflow:recycle');
        const firstGeneration = session.observerGenerationId;

        // What the next captured tool call does: start a fresh generation.
        session.abortController = new AbortController();
        session.abortReason = null;
        await provider.startSession(session);
        const secondGeneration = session.observerGenerationId;

        const bodies = sentBodies(fetchSpy);
        expect(bodies.map(body => body.trace)).toEqual([
          expectedTrace('observation', firstGeneration),
          expectedTrace('field_compression', firstGeneration),
          expectedTrace('observation', firstGeneration),
          expectedTrace('observation', secondGeneration),
          expectedTrace('summary', secondGeneration),
        ]);
        expect(firstGeneration).toMatch(UUID);
        expect(secondGeneration).toMatch(UUID);
        expect(secondGeneration).not.toBe(firstGeneration);

        const sessionId = anonymousSessionId(session.contentSessionId);
        expect(bodies.map(body => body.session_id)).toEqual(Array(5).fill(sessionId));
        for (const body of bodies) expect(body).not.toHaveProperty('user');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  }
});
