// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  OpenAICompatProvider,
  resolveOpenAICompatConfig,
  stripLeadingThinkBlock,
} from '../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// MiniMax as presets of the openai-compatible provider (#3376), and the
// generic leading <think> strip that came with it.

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('MiniMax presets', () => {
  it('points the global preset at api.minimax.io with MiniMax-M3', () => {
    const preset = resolveOpenAICompatPreset('minimax');
    expect(preset.baseUrl).toBe('https://api.minimax.io/v1');
    expect(preset.defaultModel).toBe('MiniMax-M3');
    expect(preset.requiresApiKey).toBe(true);
  });

  it('points the China preset at api.minimaxi.com', () => {
    const preset = resolveOpenAICompatPreset('minimax-cn');
    expect(preset.baseUrl).toBe('https://api.minimaxi.com/v1');
    expect(preset.defaultModel).toBe('MiniMax-M3');
    expect(preset.requiresApiKey).toBe(true);
  });

  describe('resolved through settings', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        process.env[key] = '';
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it('builds the chat-completions URL and passes any model id verbatim', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'minimax-cn';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-minimax-key';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'MiniMax-M2.7';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://api.minimaxi.com/v1/chat/completions');
      expect(config.model).toBe('MiniMax-M2.7');
      expect(config.apiKey).toBe('fixture-minimax-key');
    });
  });

  it('sends a plain OpenAI body with the bearer key', async () => {
    const config = {
      apiKey: 'fixture-minimax-key',
      apiKeys: ['fixture-minimax-key'],
      model: 'MiniMax-M3',
      apiUrl: 'https://api.minimax.io/v1/chat/completions',
      preset: resolveOpenAICompatPreset('minimax'),
      requiresApiKey: true,
    };
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200 }));
    try {
      await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<unknown>;
      }).query([{ role: 'user', content: 'observe' }], config);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.minimax.io/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-minimax-key');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('MiniMax-M3');
      expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('stripLeadingThinkBlock', () => {
  it('removes a leading reasoning block and the whitespace after it', () => {
    expect(stripLeadingThinkBlock('<think>\nweighing options\n</think>\n\n<observation>x</observation>'))
      .toBe('<observation>x</observation>');
    expect(stripLeadingThinkBlock('  <THINK>a</THINK><summary>y</summary>')).toBe('<summary>y</summary>');
  });

  it('leaves everything else alone', () => {
    expect(stripLeadingThinkBlock('<observation>x</observation>')).toBe('<observation>x</observation>');
    expect(stripLeadingThinkBlock('<observation>uses <think> tags</think></observation>'))
      .toBe('<observation>uses <think> tags</think></observation>');
    // An unclosed block (a reply cut off mid-thought) is not guessed at.
    expect(stripLeadingThinkBlock('<think>still thinking')).toBe('<think>still thinking');
  });

  it('is applied to every openai-compatible reply', async () => {
    const config = {
      apiKey: '', apiKeys: [], model: 'qwen3:8b', requiresApiKey: false,
      apiUrl: 'http://localhost:11434/v1/chat/completions', preset: resolveOpenAICompatPreset('ollama'),
    };
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '<think>private</think>\n<observation>kept</observation>' } }],
    }), { status: 200 }));
    try {
      const result = await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<{ content: string }>;
      }).query([{ role: 'user', content: 'observe' }], config);
      expect(result.content).toBe('<observation>kept</observation>');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
