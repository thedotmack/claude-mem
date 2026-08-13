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

  it('preserves bookkeeping for an empty initialization response', async () => {
    const confirmClaimedMessages = mock(() => Promise.resolve());
    const provider = new OpenRouterProvider(
      {} as any,
      { confirmClaimedMessages } as any,
    );
    const session = {
      sessionDbId: 42,
      contentSessionId: 'content-session',
      project: 'test-project',
      conversationHistory: [],
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      lastUsage: null,
      currentProvider: 'openrouter',
      platformSource: 'claude',
      lastGeneratorSource: 'init',
      lastPromptSentAt: Date.now(),
      lastPromptNumber: 1,
      consecutiveInvalidOutputs: 0,
      earliestPendingTimestamp: null,
      abortController: new AbortController(),
    } as any;
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});

    try {
      await (provider as any).handleInitResponse(
        {
          content: '',
          tokensUsed: 20,
          inputTokens: 12,
          outputTokens: 8,
          servedModel: 'reasoning-model',
        },
        session,
        undefined,
        'configured-model',
      );

      expect(session.conversationHistory).toEqual([{ role: 'assistant', content: '' }]);
      expect(session.cumulativeInputTokens).toBe(14);
      expect(session.cumulativeOutputTokens).toBe(6);
      expect(session.lastUsage).toEqual({ input: 12, output: 8 });
      expect(confirmClaimedMessages).toHaveBeenCalledWith(42);
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
