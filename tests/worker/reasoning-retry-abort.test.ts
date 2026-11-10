import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { createServer } from 'node:http';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';
import { resetReasoningFieldRejectionsForTesting } from '../../src/services/worker/reasoning-budget.js';
import { markEndpointRefusesStreamingForTests, resetStreamingEndpointMemoryForTests } from '../../src/services/worker/streamed-chat-completion.js';
import { logger } from '../../src/utils/logger.js';

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_OPENAI_COMPAT_REASONING: 'on',
  })));
  spies.push(spyOn(logger, 'error').mockImplementation(() => {}));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  resetReasoningFieldRejectionsForTesting();
  resetStreamingEndpointMemoryForTests();
});

type ProviderQuery = {
  query(history: unknown[], config: unknown, signal: AbortSignal, timeout: number, budget: PaidSendBudget): Promise<unknown>;
};

for (const mode of ['openrouter-stream', 'openrouter-json', 'compat-stream', 'compat-json', 'gemini'] as const) {
  it(`preserves caller cancellation during the reasoning-off retry (${mode})`, async () => {
    const bodies: any[] = [];
    let retryStarted!: () => void;
    const waiting = new Promise<void>(resolve => { retryStarted = resolve; });
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (bodies.length === 1) {
          res.end(JSON.stringify(mode === 'gemini'
            ? { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { thoughtsTokenCount: 4096 } }
            : { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 4096 } }));
        } else {
          // Headers and part of the body arrived, but the caller cancels while
          // the real HTTP response remains incomplete.
          res.write('{');
          retryStarted();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
    const controller = new AbortController();
    const reason = new Error('observer session was replaced');
    const budget = new PaidSendBudget(101);
    let provider: ProviderQuery;
    let config: unknown;
    if (mode.startsWith('openrouter')) {
      provider = new OpenRouterProvider({} as never, {} as never) as unknown as ProviderQuery;
      config = { apiKey: 'fixture', apiKeys: ['fixture'], model: 'fixture', fallbackModels: [], apiUrl: url, appName: 'claude-mem' };
    } else if (mode.startsWith('compat')) {
      provider = new OpenAICompatProvider({} as never, {} as never) as unknown as ProviderQuery;
      config = { apiKey: 'fixture', apiKeys: ['fixture'], model: 'fixture', apiUrl: url,
        preset: resolveOpenAICompatPreset('custom'), requiresApiKey: true };
    } else {
      provider = new GeminiProvider({} as never, {} as never) as unknown as ProviderQuery;
      config = { apiKey: 'fixture', apiKeys: ['fixture'], model: 'gemini-2.5-flash', rateLimitingEnabled: false };
      const realFetch = globalThis.fetch;
      // Gemini has a fixed origin. Preserve its real transport/body/signal and
      // redirect only that origin to our owned endpoint.
      spies.push(spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (!String(input).startsWith('https://generativelanguage.googleapis.com/')) throw new Error('unexpected fetch');
        return realFetch(url, init);
      }));
    }
    if (mode.endsWith('-json')) markEndpointRefusesStreamingForTests(url);
    const settled = provider.query([{ role: 'user', content: 'Observe this completed tool.' }], config,
      controller.signal, 2000, budget).then(value => ({ value, error: null }), error => ({ value: null, error }));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([waiting, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('reasoning retry did not start')), 3000);
      })]);
      clearTimeout(watchdog);
      controller.abort(reason);
      const result = await settled;
      expect(result.error).toBe(reason);
      expect(result.value).toBeNull();
      expect(bodies).toHaveLength(2);
      expect(budget.spentPaidSends).toBe(2);
      expect(mode === 'gemini' ? bodies[1].generationConfig.thinkingConfig : bodies[1].reasoning)
        .toEqual(mode === 'gemini' ? { thinkingBudget: 0 } : { enabled: false });
    } finally {
      clearTimeout(watchdog);
      controller.abort(reason);
      server.closeAllConnections();
      await settled;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
