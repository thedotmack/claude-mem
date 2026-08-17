import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { logger } from '../../src/utils/logger.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

const CONFIG = {
  apiKey: 'test-key',
  model: 'test/model',
  apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
};

/** Exposes the protected query() so the response-parsing path can be driven directly. */
class TestOpenRouterProvider extends OpenRouterProvider {
  runQuery(history: ConversationMessage[]) {
    return this.query(history, CONFIG as never);
  }
}

function respondWith(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeProvider() {
  return new TestOpenRouterProvider({} as never, {} as never);
}

const HISTORY: ConversationMessage[] = [{ role: 'user', content: 'observe this' }];

describe('OpenRouter max_tokens truncation', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    warnSpy?.mockRestore();
    errorSpy?.mockRestore();
    mock.restore();
  });

  it('warns and names the cap when the reply is cut off at max_tokens', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => respondWith({
      model: 'test/model',
      choices: [{ message: { content: '<observation><type>bugfix</type><title>half a ti' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 4096, total_tokens: 4996 },
    }));
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await makeProvider().runQuery(HISTORY);

    expect(result.content).toContain('<observation>');

    const truncationWarning = warnSpy.mock.calls.find(
      call => typeof call[1] === 'string' && call[1].includes('max_tokens')
    );
    expect(truncationWarning).toBeDefined();
    expect(truncationWarning?.[2]).toMatchObject({ maxTokens: 4096, outputTokens: 4096 });
  });

  it('stays quiet when the model stopped on its own', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => respondWith({
      model: 'test/model',
      choices: [{ message: { content: '<observation></observation>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
    }));
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    await makeProvider().runQuery(HISTORY);

    const truncationWarning = warnSpy.mock.calls.find(
      call => typeof call[1] === 'string' && call[1].includes('max_tokens')
    );
    expect(truncationWarning).toBeUndefined();
  });

  it('names the cap on an empty reply that was also cut off', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => respondWith({
      model: 'test/model',
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: 4096, total_tokens: 4996 },
    }));
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

    const result = await makeProvider().runQuery(HISTORY);

    expect(result.content).toBe('');
    expect(errorSpy.mock.calls[0]?.[2]).toMatchObject({ finishReason: 'length', maxTokens: 4096 });
  });
});
