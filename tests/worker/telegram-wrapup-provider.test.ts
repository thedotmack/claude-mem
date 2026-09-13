import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
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
        { ...config, model: 'configured-summary-model' },
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
      expect(query).toHaveBeenCalledWith(expect.any(Array), { ...config, model: 'active-model' });
    });

    it(`${Provider.name} does not query without its existing credentials`, async () => {
      const provider = new Provider({} as never, {} as never);
      spyOn(provider as any, 'getConfig').mockReturnValue({ apiKey: '', model: 'model' });
      const query = spyOn(provider as any, 'query').mockResolvedValue({ content: '• Finished' });
      await expect(provider.formatTelegramWrapup(input)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    });
  }
});
