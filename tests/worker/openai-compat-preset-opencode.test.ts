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

    /** Run `labels.length` queries at once and return the requests each one went out as. */
    async function sentRequests(config: unknown, ...labels: unknown[]): Promise<Array<{ headers: Record<string, string>; body: Record<string, unknown> }>> {
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
      }), { status: 200 }));
      try {
        const provider = new OpenAICompatProvider({} as never, {} as never) as unknown as {
          query(h: unknown[], c: unknown, s?: unknown, t?: unknown, b?: unknown, l?: unknown): Promise<unknown>;
        };
        await Promise.all((labels.length ? labels : [undefined]).map((label) =>
          provider.query([{ role: 'user', content: 'observe' }], config, undefined, undefined, undefined, label)));
        return fetchSpy.mock.calls.map(([, init]) => {
          const request = init as RequestInit;
          return { headers: request.headers as Record<string, string>, body: JSON.parse(String(request.body ?? '{}')) };
        });
      } finally {
        fetchSpy.mockRestore();
      }
    }

    it('sends each observed session its own x-opencode-session on Go (#4581)', async () => {
      const requests = await sentRequests(
        opencodeConfig('opencode-go', 'kimi-k3'),
        { kind: 'observation', sessionId: anonymousSessionId('session-a') },
        { kind: 'observation', sessionId: anonymousSessionId('session-b') },
      );
      expect(requests[0].headers.Authorization).toBe('Bearer fixture-opencode-key');
      expect(requests.map((request) => request.headers['x-opencode-session']).sort()).toEqual(
        [anonymousSessionId('session-a'), anonymousSessionId('session-b')].sort(),
      );
    });

    it('asks OpenCode Go to skip thinking in the shape it understands', async () => {
      // Go ignores `reasoning: { enabled: false }`; only reasoning_effort turns thinking
      // off, and thinking otherwise spends the observer's output budget.
      const saved = process.env.CLAUDE_MEM_OPENAI_COMPAT_REASONING;
      process.env.CLAUDE_MEM_OPENAI_COMPAT_REASONING = '';
      try {
        const [request] = await sentRequests(
          opencodeConfig('opencode-go', 'deepseek-v4.1-flash'),
          { kind: 'observation', sessionId: anonymousSessionId('session-a') },
        );
        expect(request.body.reasoning).toBeUndefined();
        expect(request.body.reasoning_effort).toBe('none');
      } finally {
        if (saved === undefined) delete process.env.CLAUDE_MEM_OPENAI_COMPAT_REASONING;
        else process.env.CLAUDE_MEM_OPENAI_COMPAT_REASONING = saved;
      }
    });

    it('declares the reasoning-off shape the gateway honours', () => {
      expect(resolveOpenAICompatPreset('opencode-go').reasoningOff).toBe('effort-none');
    });

    it('sends no session header without a label, or on a preset that does not ask for one', async () => {
      const [unlabelled] = await sentRequests(opencodeConfig('opencode-go', 'kimi-k3'));
      expect(unlabelled.headers['x-opencode-session']).toBeUndefined();

      const [zen] = await sentRequests(
        opencodeConfig('opencode-zen', 'deepseek-v4-flash'),
        { kind: 'observation', sessionId: anonymousSessionId('session-a') },
      );
      expect(zen.headers['x-opencode-session']).toBeUndefined();
    });
  });
});
