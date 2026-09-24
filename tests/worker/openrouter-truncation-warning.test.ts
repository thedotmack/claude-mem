import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { logger } from '../../src/utils/logger.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

const CONFIG = {
  apiKey: 'test-key',
  model: 'test/model',
  fallbackModels: [],
  apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
};

// query() serves every turn type, so the message names none of them.
const TRUNCATION_WARNING = 'OpenRouter reply was cut off at the output-token limit';

const HISTORY: ConversationMessage[] = [{ role: 'user', content: 'observe this' }];
const CAPPED_USAGE = { prompt_tokens: 900, completion_tokens: 4096, total_tokens: 4996 };

/** Exposes the protected query() so the response-parsing path can be driven directly. */
class TestOpenRouterProvider extends OpenRouterProvider {
  runQuery(history: ConversationMessage[], overrides: Record<string, unknown> = {}) {
    return this.query(history, { ...CONFIG, ...overrides } as never);
  }
}

function makeProvider() {
  return new TestOpenRouterProvider({} as never, {} as never);
}

function mockFetchResponse(body: unknown) {
  const respond = async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  return spyOn(globalThis, 'fetch').mockImplementation(respond as unknown as typeof fetch);
}

describe('OpenRouter output-token limit', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    warnSpy?.mockRestore();
    errorSpy?.mockRestore();
    mock.restore();
  });

  it('warns and names the cap when the reply is cut off', async () => {
    fetchSpy = mockFetchResponse({
      model: 'test/model',
      choices: [{ message: { content: '<observation><type>bugfix</type><title>half a ti' }, finish_reason: 'length' }],
      usage: CAPPED_USAGE,
    });
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await makeProvider().runQuery(HISTORY);

    expect(result.content).toContain('<observation>');
    expect(warnSpy).toHaveBeenCalledWith('SDK', TRUNCATION_WARNING, expect.objectContaining({ maxTokens: 4096, outputTokens: 4096 }));
  });

  it('stays quiet when the model stopped on its own', async () => {
    fetchSpy = mockFetchResponse({
      model: 'test/model',
      choices: [{ message: { content: '<observation></observation>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    });
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    await makeProvider().runQuery(HISTORY);

    expect(warnSpy).not.toHaveBeenCalledWith('SDK', TRUNCATION_WARNING, expect.anything());
  });

  it('names the cap when a reasoning model spends all of it before answering', async () => {
    fetchSpy = mockFetchResponse({
      model: 'test/model',
      choices: [{ message: { content: '', reasoning_content: 'still thinking' }, finish_reason: 'length' }],
      usage: CAPPED_USAGE,
    });
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await makeProvider().runQuery(HISTORY);

    expect(result.content).toBe('');
    expect(warnSpy).toHaveBeenCalledWith('SDK', TRUNCATION_WARNING, expect.objectContaining({ maxTokens: 4096, contentChars: 0 }));
  });

  it('names the cap before rejecting a cut-off reply that carries no text', async () => {
    fetchSpy = mockFetchResponse({
      model: 'test/model',
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: CAPPED_USAGE,
    });
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

    const result = await makeProvider().runQuery(HISTORY);

    expect(result).toEqual({ content: '' });
    expect(errorSpy).toHaveBeenCalledWith('SDK', 'Empty response from OpenRouter');
    expect(warnSpy).toHaveBeenCalledWith('SDK', TRUNCATION_WARNING, expect.objectContaining({ maxTokens: 4096 }));
  });

  it('names the cap before the Telegram wrap-up gives up on an empty reply', async () => {
    fetchSpy = mockFetchResponse({
      model: 'test/model',
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: CAPPED_USAGE,
    });
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

    await expect(makeProvider().runQuery(HISTORY, { plainText: true })).rejects.toThrow('Telegram wrap-up');
    expect(warnSpy).toHaveBeenCalledWith('SDK', TRUNCATION_WARNING, expect.objectContaining({ maxTokens: 4096, contentChars: 0 }));
  });

  it('leaves output tokens undefined when the gateway reports no completion usage', async () => {
    fetchSpy = mockFetchResponse({
      model: 'test/model',
      choices: [{ message: { content: '<observation><type>bugfix</type><title>cut' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900 },
    });
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    await makeProvider().runQuery(HISTORY);

    // Unknown usage stays unknown: reporting 0 output tokens next to non-empty
    // content reads as a provider bug that isn't there.
    const warning = warnSpy.mock.calls.find((call: unknown[]) => call[1] === TRUNCATION_WARNING);
    expect(warning).toBeDefined();
    expect((warning?.[2] as Record<string, unknown>).outputTokens).toBeUndefined();
  });
});
