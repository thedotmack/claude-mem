import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import type { TelegramWrapupFormatterInput } from '../../src/services/integrations/TelegramWrapupNotifier.js';

// No SDK process, OAuth refresh, or paid request may run in this harness.
const actualSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnv = { ...(await import('../../src/shared/EnvManager.js')) };
const sdkQuery = mock((_input: unknown) => (async function* () {
  yield { type: 'assistant', message: { content: [{ type: 'text', text: '• Finished the session' }] } };
})());

mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...actualSdk, query: sdkQuery }));
mock.module('../../src/shared/find-claude-executable.js', () => ({
  ...actualFindClaude, findClaudeExecutable: () => '/mock/claude',
}));
mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnv, buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: '/mock/bin' }),
}));

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
const { GeminiProvider } = await import('../../src/services/worker/GeminiProvider.js');
const { OpenRouterProvider } = await import('../../src/services/worker/OpenRouterProvider.js');

const input: TelegramWrapupFormatterInput = {
  sessionDbId: 42,
  contentSessionId: 'content-42',
  project: 'test-project',
  platformSource: 'claude',
  summaryText: 'request\ninvestigated\nlearned\ncompleted\nnext_steps\nfiles_read\nfiles_edited\nnotes\n'.repeat(1_000),
};
const prompt = 'format as a very short bulleted list that narratively explains this summary in < 255 char';
let settings = SettingsDefaultsManager.getAllDefaults();

beforeEach(() => {
  sdkQuery.mockClear();
  settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_MODEL: '$TIER:fast',
    CLAUDE_MEM_TIER_FAST_MODEL: 'configured-default-model',
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
    CLAUDE_MEM_TIER_SUMMARY_MODEL: 'configured-summary-model',
  };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings);
});

afterEach(() => mock.restore());
afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnv);
});

describe('Telegram wrap-up provider reuse', () => {
  it('uses the active Claude summary model and the hardened, tool-free SDK path', async () => {
    const provider = new ClaudeProvider({} as never, {} as never);

    await expect(provider.formatTelegramWrapup(input, 'active-summary-model')).resolves.toBe('• Finished the session');

    expect(sdkQuery).toHaveBeenCalledTimes(1);
    expect(sdkQuery).toHaveBeenCalledWith({
      prompt: `${prompt}\n\n${input.summaryText}`,
      options: expect.objectContaining({
        model: 'active-summary-model', pathToClaudeCodeExecutable: '/mock/claude',
        maxTurns: 1, tools: [], allowedTools: [], permissionMode: 'dontAsk',
        mcpServers: {}, settingSources: [], strictMcpConfig: true,
      }),
    });
    const { options } = sdkQuery.mock.calls[0][0] as { options: Record<string, unknown> };
    expect(options.resume).toBeUndefined();
    expect(options.systemPrompt).toBeUndefined();
  });

  it.each([true, false])('uses existing Claude summary settings for replay with tier routing %s', async enabled => {
    settings.CLAUDE_MEM_TIER_ROUTING_ENABLED = String(enabled);
    const provider = new ClaudeProvider({} as never, {} as never);
    await provider.formatTelegramWrapup(input);
    expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ model: enabled ? 'configured-summary-model' : 'configured-default-model' }),
    }));
  });

  it.each(['field', 'session'])('retains %s cancellation for the existing field-compression call', async source => {
    const provider = new ClaudeProvider({} as never, {} as never);
    const field = new AbortController();
    const session = { ...input, abortController: new AbortController() };
    (source === 'field' ? field : session.abortController).abort();
    await expect((provider as any).compressField('large field', 100, session, 'model', '/mock/claude', field.signal))
      .resolves.toBeNull();
    expect(sdkQuery).not.toHaveBeenCalled();
  });

  for (const Provider of [GeminiProvider, OpenRouterProvider]) {
    it(`${Provider.name} uses its normal query/config and summary-tier model even for a live session`, async () => {
      const provider = new Provider({} as never, {} as never);
      const config = { apiKey: 'mock-key', model: 'default-model', maxTokens: 1234, temperature: 0.2 };
      spyOn(provider as any, 'getConfig').mockReturnValue(config);
      const query = spyOn(provider as any, 'query').mockResolvedValue({ content: '• Finished the session' });

      await expect(provider.formatTelegramWrapup(input, 'active-observation-model')).resolves.toBe('• Finished the session');

      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        [{ role: 'user', content: `${prompt}\n\n${input.summaryText}` }],
        { ...config, model: 'configured-summary-model', plainText: true },
      );
      expect(config.model).toBe('default-model');
    });

    it(`${Provider.name} respects disabled summary routing and the active model`, async () => {
      settings.CLAUDE_MEM_TIER_ROUTING_ENABLED = 'false';
      const provider = new Provider({} as never, {} as never);
      const config = { apiKey: 'mock-key', model: 'default-model' };
      spyOn(provider as any, 'getConfig').mockReturnValue(config);
      const query = spyOn(provider as any, 'query').mockResolvedValue({ content: '• Finished' });
      await provider.formatTelegramWrapup(input, 'active-model');
      expect(query).toHaveBeenCalledWith(expect.any(Array), { ...config, model: 'active-model', plainText: true });
    });

    it(`${Provider.name} does not query without its existing credentials`, async () => {
      const provider = new Provider({} as never, {} as never);
      spyOn(provider as any, 'getConfig').mockReturnValue({ apiKey: '', model: 'model' });
      const query = spyOn(provider as any, 'query').mockResolvedValue({ content: '• Finished' });
      await expect(provider.formatTelegramWrapup(input)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });

    it(`${Provider.name} logs and rejects an empty formatter completion`, async () => {
      const provider = new Provider({} as never, {} as never);
      spyOn(provider as any, 'getConfig').mockReturnValue({ apiKey: 'mock-key', model: 'model' });
      spyOn(provider as any, 'query').mockResolvedValue({ content: '' });
      const log = spyOn(logger, 'error').mockImplementation(() => {});
      await expect(provider.formatTelegramWrapup(input)).rejects.toThrow('returned no text');
      expect(log).toHaveBeenCalledWith('TELEGRAM', expect.any(String), {
        sessionId: 42, model: 'configured-summary-model',
      }, expect.any(Error));
    });
  }

  it('logs and rejects a Claude formatter completion without an assistant text frame', async () => {
    sdkQuery.mockImplementationOnce(() => (async function* () {})());
    const log = spyOn(logger, 'error').mockImplementation(() => {});
    const provider = new ClaudeProvider({} as never, {} as never);
    await expect(provider.formatTelegramWrapup(input)).rejects.toThrow('Claude returned no text');
    expect(log).toHaveBeenCalledWith('TELEGRAM', expect.any(String), {
      sessionId: 42, model: 'configured-summary-model',
    }, expect.any(Error));
  });

  it.each([
    undefined,
    { content: null, reasoning_content: 'private reasoning' },
    { content: null, tool_calls: [{ type: 'function', function: { name: 'summary', arguments: '{"text":"not an answer"}' } }] },
    { content: [] },
  ])('rejects missing, reasoning-only, or tool-only OpenRouter completions without a retry (%j)', async message => {
    const provider = new OpenRouterProvider({} as never, {} as never);
    spyOn(provider as any, 'getConfig').mockReturnValue({
      apiKey: 'mock-key', model: 'cmem-observer', fallbackModels: [],
      apiUrl: 'https://cmem.ai/api/inference/v1/chat/completions',
    });
    const network = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      model: 'deepseek/deepseek-v4-flash-0731',
      choices: [{ message, finish_reason: 'length' }],
      usage: { completion_tokens: 4096 },
    }), { status: 200, headers: { 'x-request-id': 'fixture-request' } }));
    const log = spyOn(logger, 'error').mockImplementation(() => {});

    await expect(provider.formatTelegramWrapup(input)).rejects.toThrow('OpenRouter returned no assistant text');

    expect(network).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('TELEGRAM', expect.any(String), expect.objectContaining({
      model: 'deepseek/deepseek-v4-flash-0731', requestId: 'fixture-request',
      finishReason: 'length', completionTokens: 4096,
    }), expect.any(Error));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private reasoning');
    expect(JSON.stringify(log.mock.calls)).not.toContain('not an answer');
  });

  it('does not add OpenRouter-specific output controls to an unknown compatible gateway', async () => {
    const provider = new OpenRouterProvider({} as never, {} as never);
    spyOn(provider as any, 'getConfig').mockReturnValue({
      apiKey: 'mock-key', model: 'local-model', fallbackModels: [],
      apiUrl: 'https://gateway.test/v1/chat/completions',
    });
    const network = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '• Finished' } }],
    }), { status: 200 }));

    await expect(provider.formatTelegramWrapup(input)).resolves.toBe('• Finished');

    const body = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it('leaves ordinary summary generation request options and empty-response bookkeeping unchanged', async () => {
    const provider = new OpenRouterProvider({} as never, {} as never);
    const network = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '', reasoning_content: 'private reasoning' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }), { status: 200 }));

    const result = await (provider as any).query([{ role: 'user', content: 'summary prompt' }], {
      apiKey: 'mock-key', model: 'cmem-observer', fallbackModels: [],
      apiUrl: 'https://cmem.ai/api/inference/v1/chat/completions',
    });

    expect(result).toMatchObject({ content: '', tokensUsed: 20, inputTokens: 12, outputTokens: 8 });
    const body = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(body.response_format).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });
});
