// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  OpenAICompatProvider,
  isOpenAICompatAvailable,
  resolveOpenAICompatConfig,
} from '../../src/services/worker/OpenAICompatProvider.js';
import { anonymousSessionId } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// OpenCode Go and Zen as presets of the openai-compatible provider (#3623).

const ENV_KEYS = [
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('OpenCode presets', () => {
  it('points opencode-go at the Go endpoint with kimi-k3', () => {
    const preset = resolveOpenAICompatPreset('opencode-go');
    expect(preset.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(preset.defaultModel).toBe('kimi-k3');
    expect(preset.requiresApiKey).toBe(true);
  });

  it('points opencode-zen at the Zen endpoint with no default model', () => {
    const preset = resolveOpenAICompatPreset('opencode-zen');
    expect(preset.baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(preset.defaultModel).toBe('');
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

    it('resolves the Go endpoint and default model', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'opencode-go';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-opencode-key';

      const config = resolveOpenAICompatConfig();
      expect(config.apiUrl).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      expect(config.model).toBe('kimi-k3');
      expect(isOpenAICompatAvailable()).toBe(true);
    });

    it('keeps Zen unconfigured until a model is set, so dispatch falls through instead of failing', () => {
      process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'opencode-zen';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_API_KEY = 'fixture-opencode-key';
      expect(isOpenAICompatAvailable()).toBe(false);

      process.env.CLAUDE_MEM_OPENAI_COMPAT_MODEL = 'deepseek-v4-flash';
      expect(isOpenAICompatAvailable()).toBe(true);
      expect(resolveOpenAICompatConfig().apiUrl).toBe('https://opencode.ai/zen/v1/chat/completions');
    });
  });

  describe('request headers', () => {
    function opencodeConfig(presetId: string, model: string) {
      const preset = resolveOpenAICompatPreset(presetId);
      return {
        apiKey: 'fixture-opencode-key',
        apiKeys: ['fixture-opencode-key'],
        model,
        apiUrl: `${preset.baseUrl}/chat/completions`,
        preset,
        requiresApiKey: true,
      };
    }

    /** Run `labels.length` queries at once and return the headers each request went out with. */
    async function sentHeaders(config: unknown, ...labels: unknown[]): Promise<Record<string, string>[]> {
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200 }));
      try {
        const provider = new OpenAICompatProvider({} as never, {} as never) as unknown as {
          query(h: unknown[], c: unknown, s?: unknown, t?: unknown, b?: unknown, l?: unknown): Promise<unknown>;
        };
        await Promise.all((labels.length ? labels : [undefined]).map((label) =>
          provider.query([{ role: 'user', content: 'observe' }], config, undefined, undefined, undefined, label)));
        return fetchSpy.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
      } finally {
        fetchSpy.mockRestore();
      }
    }

    it('sends each observed session its own x-opencode-session on Go (#4581)', async () => {
      const headers = await sentHeaders(
        opencodeConfig('opencode-go', 'kimi-k3'),
        { kind: 'observation', sessionId: anonymousSessionId('session-a') },
        { kind: 'observation', sessionId: anonymousSessionId('session-b') },
      );
      expect(headers[0].Authorization).toBe('Bearer fixture-opencode-key');
      expect(headers.map((h) => h['x-opencode-session']).sort()).toEqual(
        [anonymousSessionId('session-a'), anonymousSessionId('session-b')].sort(),
      );
    });

    it('sends no session header without a label, or on a preset that does not ask for one', async () => {
      const [unlabelled] = await sentHeaders(opencodeConfig('opencode-go', 'kimi-k3'));
      expect(unlabelled['x-opencode-session']).toBeUndefined();

      const [zen] = await sentHeaders(
        opencodeConfig('opencode-zen', 'deepseek-v4-flash'),
        { kind: 'observation', sessionId: anonymousSessionId('session-a') },
      );
      expect(zen['x-opencode-session']).toBeUndefined();
    });
  });
});
