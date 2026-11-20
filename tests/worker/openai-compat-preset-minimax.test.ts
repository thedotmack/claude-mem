// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

    const preset = 'minimax';
    for (const model of ['', 'account-custom-model']) {
      it(`sends ${preset} with ${model || 'the M3 default'} from saved settings`, async () => {
        for (const key of ENV_KEYS) delete process.env[key];
        const directory = mkdtempSync(join(tmpdir(), 'minimax-preset-'));
        const settingsPath = join(directory, 'settings.json');
        const saved = JSON.stringify({
          CLAUDE_MEM_OPENAI_COMPAT_PRESET: preset,
          CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'fixture-minimax-key',
          CLAUDE_MEM_OPENAI_COMPAT_MODEL: model,
        });
        writeFileSync(settingsPath, saved);
        const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
          'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}',
          'data: {"choices":[{"delta":{"content":"<observation>kept</observation>"},"finish_reason":"stop"}]}',
          'data: [DONE]',
          '',
        ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } }));
        try {
          const config = resolveOpenAICompatConfig(settingsPath);
          const history = [
            { role: 'user', content: 'Observe the tool result: image saved to chart.png' },
            { role: 'assistant', content: '<observation>previous</observation>' },
            { role: 'user', content: 'Summarize the next observation' },
          ];
          const result = await (new OpenAICompatProvider({} as never, {} as never) as unknown as {
            query(h: unknown[], c: unknown): Promise<{ content: string }>;
          }).query(history, config);
          const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
          expect(url).toBe(`${resolveOpenAICompatPreset(preset).baseUrl}/chat/completions`);
          expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fixture-minimax-key');
          const body = JSON.parse(String(init.body));
          expect(body.model).toBe(model || 'MiniMax-M3');
          expect(body.messages).toEqual(history);
          expect(body.stream).toBe(true);
          expect(body.stream_options).toEqual({ include_usage: true });
          expect(result.content).toBe('<observation>kept</observation>');
          expect(readFileSync(settingsPath, 'utf8')).toBe(saved);
        } finally {
          fetchSpy.mockRestore();
          rmSync(directory, { recursive: true, force: true });
        }
      });
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
