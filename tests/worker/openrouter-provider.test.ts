import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';

// #3606 — the bounded-context-window fix on the OpenRouter path.
// `query()`/`getConfig()` are `protected`, which TypeScript enforces only at
// compile time; casting to `any` (the same trick used to unit-test other
// protected provider internals) reaches them directly so these tests can
// assert on the actual request body without standing up the full
// startSession()/message-loop machinery.

function makeHistory(turns: number): ConversationMessage[] {
  const history: ConversationMessage[] = [
    { role: 'user', content: 'INIT PROMPT carrying the <observation> schema' },
  ];
  for (let i = 0; i < turns; i++) {
    history.push({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `turn-${i}-${'x'.repeat(200)}`,
    });
  }
  return history;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenRouterProvider — bounded context window (#3606)', () => {
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof global.fetch;
  let provider: OpenRouterProvider;
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'mock-model',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '4',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS: '3000',
      CLAUDE_MEM_OPENROUTER_MAX_TOKENS: '777',
      CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS: '1234',
    }));

    loggerSpies = [
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    originalFetch = global.fetch;
    provider = new OpenRouterProvider({} as DatabaseManager, {} as SessionManager);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    loadFromFileSpy.mockRestore();
    loggerSpies.forEach(s => s.mockRestore());
    mock.restore();
  });

  it('parses the four context-window settings into getConfig()', () => {
    const config = (provider as any).getConfig();
    expect(config.maxContextMessages).toBe(4);
    expect(config.maxContextChars).toBe(3000);
    expect(config.maxTokens).toBe(777);
    expect(config.attemptTimeoutMs).toBe(1234);
  });

  it("falls back to the numeric default (4096 / 30000) when MAX_TOKENS or ATTEMPT_TIMEOUT_MS is '0' or '-5' — both must stay >= 1", () => {
    for (const bad of ['0', '-5']) {
      loadFromFileSpy.mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_OPENROUTER_API_KEY: 'test-key',
        CLAUDE_MEM_OPENROUTER_MODEL: 'mock-model',
        CLAUDE_MEM_OPENROUTER_MAX_TOKENS: bad,
        CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS: bad,
      }));
      const config = (provider as any).getConfig();
      expect(config.maxTokens).toBe(4096);
      expect(config.attemptTimeoutMs).toBe(30000);
    }
  });

  it("keeps '0' as unbounded for MAX_CONTEXT_MESSAGES and MAX_CONTEXT_CHARS (they don't share the >= 1 floor)", () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'mock-model',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '0',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS: '0',
    }));
    const config = (provider as any).getConfig();
    expect(config.maxContextMessages).toBe(0);
    expect(config.maxContextChars).toBe(0);
  });

  it('falls back to the numeric default (40 / 200000) when MAX_CONTEXT_MESSAGES or MAX_CONTEXT_CHARS is negative — only 0 means unbounded', () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'mock-model',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '-5',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS: '-5',
    }));
    const config = (provider as any).getConfig();
    expect(config.maxContextMessages).toBe(40);
    expect(config.maxContextChars).toBe(200000);
  });

  it('sends a bounded, system-anchored request: max_tokens, timeout:false, and finishReason propagation', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{
          message: { role: 'assistant', content: '<observation><type>discovery</type><title>t</title></observation>' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = makeHistory(30);
    const config = (provider as any).getConfig();
    const result = await (provider as any).query(history, config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, unknown>];
    const body = JSON.parse(init.body as string);

    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(history[0].content);
    // maxContextMessages=4 -> system + at most 4 trailing turns.
    expect(body.messages.length).toBeLessThanOrEqual(5);
    const sentChars = body.messages
      .slice(1)
      .reduce((sum: number, m: { content: string }) => sum + m.content.length, 0);
    expect(sentChars).toBeLessThanOrEqual(3000);
    expect(body.max_tokens).toBe(777);
    expect(init.timeout).toBe(false);

    expect(result.finishReason).toBe('stop');
    expect(result.content).toContain('<observation>');
  });

  it('keeps the final message even when char-bounding would otherwise drop it', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'ack' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history: ConversationMessage[] = [
      { role: 'user', content: 'INIT' },
      { role: 'user', content: 'a'.repeat(50) },
      { role: 'user', content: 'z'.repeat(5000) }, // alone exceeds the 3000-char budget
    ];
    const config = (provider as any).getConfig();
    await (provider as any).query(history, config);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & Record<string, unknown>];
    const body = JSON.parse(init.body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toBe('z'.repeat(5000));
  });

  it("empty content with finish_reason='length' logs an error and returns { content: '', finishReason: 'length' }", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
      }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = makeHistory(5);
    const config = (provider as any).getConfig();
    const result = await (provider as any).query(history, config);

    expect(result).toEqual({ content: '', finishReason: 'length' });
    expect(logger.error).toHaveBeenCalledWith(
      'SDK',
      'Empty response from OpenRouter — context or output budget exhausted',
      expect.objectContaining({ finishReason: 'length' })
    );
    expect(logger.info).not.toHaveBeenCalledWith('SDK', expect.stringContaining('observer skipped the batch'), expect.anything());
  });

  it("malformed response (data.choices missing) logs the malformed-body error and returns { content: '', finishReason: 'malformed' } — not the designed-empty logging", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({ usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = makeHistory(5);
    const config = (provider as any).getConfig();
    const result = await (provider as any).query(history, config);

    expect(result).toEqual({ content: '', finishReason: 'malformed' });
    expect(logger.error).toHaveBeenCalledWith(
      'SDK',
      'Malformed response from OpenRouter — no choices/message in body',
      expect.objectContaining({ keys: ['usage'] })
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      'SDK',
      'Empty response from OpenRouter — context or output budget exhausted',
      expect.anything()
    );
    expect(logger.info).not.toHaveBeenCalledWith('SDK', expect.stringContaining('observer skipped the batch'), expect.anything());
  });

  it("malformed response (choices[0].message missing) also logs the malformed-body error, distinct from a designed empty completion, and returns finishReason: 'malformed' so downstream never treats it as a designed skip", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = makeHistory(5);
    const config = (provider as any).getConfig();
    const result = await (provider as any).query(history, config);

    expect(result).toEqual({ content: '', finishReason: 'malformed' });
    expect(logger.error).toHaveBeenCalledWith(
      'SDK',
      'Malformed response from OpenRouter — no choices/message in body',
      expect.objectContaining({ finishReason: 'stop' })
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("empty content with no finish_reason at all ({message:{}}) is NOT a designed skip: logs warn and returns finishReason: 'missing'", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: {} }],
        usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
      }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = makeHistory(5);
    const config = (provider as any).getConfig();
    const result = await (provider as any).query(history, config);

    expect(result).toEqual({ content: '', finishReason: 'missing' });
    expect(logger.warn).toHaveBeenCalledWith(
      'SDK',
      'Empty response from OpenRouter with finish_reason=missing — not a designed skip',
      expect.objectContaining({
        finishReason: undefined,
        messagesSent: expect.any(Number),
        promptChars: expect.any(Number),
        promptTokens: 12,
        completionTokens: 0,
      })
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith('SDK', expect.stringContaining('observer skipped the batch'), expect.anything());
  });

  it("empty content with finish_reason='content_filter' is NOT a designed skip: logs warn, not info, and returns the real finishReason", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 },
      }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = makeHistory(5);
    const config = (provider as any).getConfig();
    const result = await (provider as any).query(history, config);

    expect(result).toEqual({ content: '', finishReason: 'content_filter' });
    expect(logger.warn).toHaveBeenCalledWith(
      'SDK',
      'Empty response from OpenRouter with finish_reason=content_filter — not a designed skip',
      expect.objectContaining({ finishReason: 'content_filter' })
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith('SDK', expect.stringContaining('observer skipped the batch'), expect.anything());
  });

  it("empty content with finish_reason='stop' is a designed no-op: logs info, not error", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(jsonResponse({
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
      }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const history = makeHistory(5);
    const config = (provider as any).getConfig();
    const result = await (provider as any).query(history, config);

    expect(result).toEqual({ content: '', finishReason: 'stop' });
    expect(logger.info).toHaveBeenCalledWith(
      'SDK',
      'Empty response from OpenRouter (finish_reason=stop) — observer skipped the batch',
      expect.objectContaining({ finishReason: 'stop' })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
