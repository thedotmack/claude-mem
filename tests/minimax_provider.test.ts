import { describe, expect, it, afterEach, mock } from 'bun:test';
import {
  MiniMaxProvider,
  classifyMiniMaxError,
  resolveMiniMaxChatCompletionsUrl,
} from '../src/services/worker/MiniMaxProvider.js';

describe('MiniMaxProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  it('resolves global and China OpenAI-compatible endpoints', () => {
    expect(resolveMiniMaxChatCompletionsUrl()).toBe('https://api.minimax.io/v1/chat/completions');
    expect(resolveMiniMaxChatCompletionsUrl('https://api.minimaxi.com/v1')).toBe(
      'https://api.minimaxi.com/v1/chat/completions',
    );
    expect(resolveMiniMaxChatCompletionsUrl('https://example.test/v1/chat/completions/')).toBe(
      'https://example.test/v1/chat/completions',
    );
  });

  it('sends an OpenAI-compatible multi-turn request and normalizes usage', async () => {
    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      model: 'MiniMax-M3',
      choices: [{ message: { content: '<skip_summary reason="no_observation" />' } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }))));

    const provider = new MiniMaxProvider({} as never, {} as never);
    const result = await (provider as any).query(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
      {
        apiKey: 'test-key',
        model: 'MiniMax-M3',
        apiUrl: 'https://api.minimax.io/v1/chat/completions',
      },
    );

    expect(result).toEqual({
      content: '<skip_summary reason="no_observation" />',
      tokensUsed: 19,
      inputTokens: 12,
      outputTokens: 7,
      servedModel: 'MiniMax-M3',
    });

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.minimax.io/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'MiniMax-M3',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });
  });

  it('classifies quota and auth failures without exposing response bodies', () => {
    const quota = classifyMiniMaxError({
      status: 500,
      bodyText: 'insufficient balance; token=secret',
      cause: new Error('upstream'),
    });
    expect(quota.kind).toBe('quota_exhausted');
    expect(quota.message).not.toContain('secret');

    expect(classifyMiniMaxError({ status: 401, cause: new Error('auth') }).kind).toBe('auth_invalid');
    expect(classifyMiniMaxError({ status: 503, cause: new Error('temporary') }).kind).toBe('transient');
  });
});
