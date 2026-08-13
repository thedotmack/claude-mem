import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { logger } from '../../src/utils/logger.js';

describe('OpenRouterProvider empty content', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('accepts an empty message from a reasoning model and preserves usage', async () => {
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      model: 'reasoning-model',
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'internal reasoning',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
      },
    }), { status: 200 })));
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

    try {
      const provider = new OpenRouterProvider({} as any, {} as any);
      const result = await (provider as any).query(
        [{ role: 'user', content: 'remember this' }],
        {
          apiKey: 'test-key',
          model: 'reasoning-model',
          apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        },
      );

      expect(result).toEqual({
        content: '',
        tokensUsed: 20,
        inputTokens: 12,
        outputTokens: 8,
        costUsd: undefined,
        servedModel: 'reasoning-model',
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still rejects a response without a message object', async () => {
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop' }],
    }), { status: 200 })));
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

    try {
      const provider = new OpenRouterProvider({} as any, {} as any);
      const result = await (provider as any).query(
        [{ role: 'user', content: 'remember this' }],
        {
          apiKey: 'test-key',
          model: 'reasoning-model',
          apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        },
      );

      expect(result).toEqual({ content: '' });
      expect(errorSpy).toHaveBeenCalledWith('SDK', 'Empty response from OpenRouter');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
