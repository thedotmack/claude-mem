// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from 'bun:test';
import {
  OpenAICompatProvider,
} from '../../src/services/worker/OpenAICompatProvider.js';
import { anonymousSessionId } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';

// OpenCode Go and Zen as presets of the openai-compatible provider (#3623).

describe('OpenCode presets', () => {
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
