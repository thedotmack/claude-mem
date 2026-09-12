import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

class TestOpenRouterProvider extends OpenRouterProvider {
  buildMessages(history: ConversationMessage[]) {
    return (this as unknown as { conversationToOpenAIMessages(history: ConversationMessage[]): unknown })
      .conversationToOpenAIMessages(history);
  }
}

describe('OpenRouterProvider conversation normalization', () => {
  let provider: TestOpenRouterProvider;
  let settingsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-api-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
    }));

    provider = new TestOpenRouterProvider({} as DatabaseManager, {} as SessionManager);
  });

  afterEach(() => {
    settingsSpy.mockRestore();
  });

  it('drops empty history entries instead of sending an empty messages array', () => {
    const messages = provider.buildMessages([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '' },
    ]);

    expect(messages).toEqual([{ role: 'user', content: '(context unavailable)' }]);
  });

  it('keeps the newest non-empty message as the fallback when everything else is blank', () => {
    const messages = provider.buildMessages([
      { role: 'user', content: 'keep me' },
      { role: 'assistant', content: '   ' },
    ]);

    expect(messages).toEqual([{ role: 'user', content: 'keep me' }]);
  });

  it('never returns an empty messages array for oversized single-message histories', () => {
    const oversized = 'x'.repeat(500_000);
    const messages = provider.buildMessages([{ role: 'user', content: oversized }]);

    expect(messages.length).toBe(1);
    expect(messages[0]?.content).toBe(oversized);
  });
});

describe('OpenRouterProvider request guard', () => {
  let originalFetch: typeof fetch;
  let settingsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    settingsSpy?.mockRestore();
  });

  it('posts at least one message even when history is blank', async () => {
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_OPENROUTER_API_KEY: 'test-api-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
    }));

    const provider = new TestOpenRouterProvider({} as DatabaseManager, {} as SessionManager);
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }))));

    global.fetch = fetchMock as unknown as typeof fetch;

    await (provider as unknown as {
      queryOpenRouterMultiTurn(
        history: ConversationMessage[],
        apiKey: string,
        model: string,
        apiUrl: string,
        siteUrl?: string,
        appName?: string,
      ): Promise<unknown>;
    }).queryOpenRouterMultiTurn(
      [{ role: 'user', content: '   ' }],
      'test-api-key',
      'xiaomi/mimo-v2-flash:free',
      'https://openrouter.ai/api/v1/chat/completions',
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages.length).toBeGreaterThan(0);
  });
});
