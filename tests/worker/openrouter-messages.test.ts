import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OpenRouterProvider, withTurnImages, buildOpenRouterRequestBody } from '../../src/services/worker/OpenRouterProvider.js';
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
      CLAUDE_MEM_OPENROUTER_MODEL: 'cohere/north-mini-code:free',
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
      CLAUDE_MEM_OPENROUTER_MODEL: 'cohere/north-mini-code:free',
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
      'cohere/north-mini-code:free',
      'https://openrouter.ai/api/v1/chat/completions',
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages.length).toBeGreaterThan(0);
  });
});

describe('withTurnImages (Phase 4 request boundary)', () => {
  const image = { requestLabel: 'event1_image1', eventOrdinal: 1, eventKey: 'k', attachmentId: 'a', eventLabel: 'event1_image1', dataUrl: 'data:image/webp;base64,UklGRg==' };
  const messages = [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'user' as const, content: 'turn' },
  ];

  it('returns the same string messages when the turn has no images', () => {
    expect(withTurnImages(messages, undefined)).toBe(messages);
    expect(withTurnImages(messages, [])).toBe(messages);
  });

  it('changes only the final user message into text-first parts', () => {
    const result = withTurnImages(messages, [image])!;
    expect(result.slice(0, -1)).toEqual(messages.slice(0, -1));
    expect(result.at(-1)).toEqual({ role: 'user', content: [
      { type: 'text', text: 'turn' },
      { type: 'text', text: 'Images attached to this turn: event1_image1. Each image follows a line [image LABEL]. In each <observation> informed by an image, list the label inside <attachments><attachment>LABEL</attachment></attachments>. Use only these labels.' },
      { type: 'text', text: '[image event1_image1]' },
      { type: 'image_url', image_url: { url: image.dataUrl } },
    ] });
    expect(messages.at(-1)!.content).toBe('turn');
  });

  it('refuses to attach images when the final message is not a user turn', () => {
    expect(withTurnImages(messages.slice(0, -1), [image])).toBeNull();
  });

  it('builds a text-only body byte-identical to the string-message body', () => {
    const input = { model: 'm', fallbackModels: [], apiUrl: 'https://openrouter.ai/api/v1/chat/completions', maxOutputTokens: 4096 };
    expect(JSON.stringify(buildOpenRouterRequestBody({ ...input, messages: withTurnImages(messages, undefined)! })))
      .toBe(JSON.stringify(buildOpenRouterRequestBody({ ...input, messages })));
  });
});
