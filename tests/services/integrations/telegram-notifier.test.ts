import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { notifyTelegram } from '../../../src/services/integrations/TelegramNotifier.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

describe('notifyTelegram brainbeat webhook', () => {
  let settingsSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  const observation = {
    type: 'security_alert',
    title: 'Found exposed token',
    subtitle: 'Retry path logs raw credential',
    facts: [],
    narrative: null,
    concepts: ['auth', 'logging'],
    files_read: [],
    files_modified: [],
  };

  beforeEach(() => {
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile');
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    settingsSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  function mockSettings(overrides: Record<string, string>): void {
    settingsSpy.mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      ...overrides,
    });
  }

  it('POSTs a brainbeat payload when an observation matches trigger filters', async () => {
    mockSettings({
      CLAUDE_MEM_TELEGRAM_ENABLED: 'false',
      CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS: 'auth',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/webhook',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET: 'top-secret',
    });
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));

    await notifyTelegram({
      observations: [observation],
      observationIds: [42],
      project: 'claude-mem',
      memorySessionId: 'session-1',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bot.example/webhook');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-claude-mem-shared-secret']).toBe('top-secret');

    const payload = JSON.parse(String(init.body));
    expect(payload.observation_id).toBe(42);
    expect(payload.type).toBe('security_alert');
    expect(payload.project).toBe('claude-mem');
    expect(payload.why_fired).toEqual({
      matched_type: true,
      matched_concepts: ['auth'],
    });
    expect(typeof payload.timestamp).toBe('string');
  });

  it('does not POST brainbeat when observation does not match filters', async () => {
    mockSettings({
      CLAUDE_MEM_TELEGRAM_ENABLED: 'false',
      CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'design_decision',
      CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS: 'perf',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/webhook',
    });

    await notifyTelegram({
      observations: [observation],
      observationIds: [42],
      project: 'claude-mem',
      memorySessionId: 'session-1',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows webhook POST failures', async () => {
    mockSettings({
      CLAUDE_MEM_TELEGRAM_ENABLED: 'false',
      CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/webhook',
    });
    fetchSpy.mockRejectedValue(new Error('network down'));

    await expect(
      notifyTelegram({
        observations: [observation],
        observationIds: [42],
        project: 'claude-mem',
        memorySessionId: 'session-1',
      })
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still sends Telegram when both Telegram and webhook destinations are configured', async () => {
    mockSettings({
      CLAUDE_MEM_TELEGRAM_ENABLED: 'true',
      CLAUDE_MEM_TELEGRAM_BOT_TOKEN: 'bot-token',
      CLAUDE_MEM_TELEGRAM_CHAT_ID: '12345',
      CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/webhook',
    });
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.startsWith('https://api.telegram.org/bot')) {
        return new Response(null, { status: 200 });
      }
      if (text === 'https://bot.example/webhook') {
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 404 });
    });

    await notifyTelegram({
      observations: [observation],
      observationIds: [42],
      project: 'claude-mem',
      memorySessionId: 'session-1',
    });

    const calledUrls = fetchSpy.mock.calls.map(call => String(call[0]));
    expect(calledUrls.some(url => url.startsWith('https://api.telegram.org/bot'))).toBe(true);
    expect(calledUrls).toContain('https://bot.example/webhook');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
