import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  BRAINBEAT_TIMEOUT_MS,
  brainbeatFailureReason,
  notifyGrokBotBrainbeat,
  webhookOrigin,
} from '../../src/services/integrations/GrokBotBrainbeat.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

describe('Grok Bot brainbeat webhook', () => {
  let settingsSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

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
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    settingsSpy.mockRestore();
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function mockSettings(overrides: Record<string, string>): void {
    settingsSpy.mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      ...overrides,
    });
  }

  it('POSTs a brainbeat for an awareness-trigger match, whatever the Telegram settings say', async () => {
    mockSettings({
      CLAUDE_MEM_TELEGRAM_ENABLED: 'false',
      CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED: 'false',
      CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: '',
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS: 'auth',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/webhook',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET: 'top-secret',
    });
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));

    await notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'claude-mem' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bot.example/webhook');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-claude-mem-shared-secret']).toBe('top-secret');
    expect(init.signal).toBeInstanceOf(AbortSignal); // bounded: a hung receiver cannot stall anything

    const payload = JSON.parse(String(init.body));
    expect(payload.event).toBe('claude_mem.brainbeat');
    expect(payload.observation_id).toBe(42);
    expect(payload.project).toBe('claude-mem');
    expect(payload.why_fired).toEqual({ matched_type: true, matched_concepts: ['auth'] });
  });

  it('is off while CLAUDE_MEM_GROK_BOT_WEBHOOK_URL is empty', async () => {
    mockSettings({ CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'security_alert', CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: '' });
    await notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'claude-mem' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not POST when the observation matches no awareness trigger', async () => {
    mockSettings({
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'decision',
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS: 'perf',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/webhook',
    });
    await notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'claude-mem' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches every matching POST at once instead of one after another', async () => {
    mockSettings({
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/webhook',
    });
    const release: Array<() => void> = [];
    fetchSpy.mockImplementation(() => new Promise<Response>(resolve => {
      release.push(() => resolve(new Response(null, { status: 202 })));
    }));

    const pending = notifyGrokBotBrainbeat({ observations: [observation, observation], observationIds: [1, 2], project: 'p' });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2); // both in flight before either answered
    release.forEach(done => done());
    await pending;
  });

  it('never throws, and logs only the receiver origin (no path, query or userinfo)', async () => {
    mockSettings({
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://user:pass@bot.example/hook?token=abc',
    });
    fetchSpy.mockRejectedValue(new Error('network down'));

    await expect(notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'p' })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const context = warnSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(context.webhook).toBe('https://bot.example');
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain('token=abc');
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain('pass');
  });

  it('never logs the fetch error itself, whose message can carry the full URL', async () => {
    const url = 'https://user:pass@bot.example/hook?token=abc';
    mockSettings({
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: url,
    });
    // fetch refuses credentialed URLs with a TypeError that quotes the URL.
    fetchSpy.mockRejectedValue(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${url}`));

    await notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'p' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0];
    // JSON.stringify(Error) prints `{}`, so check that no Error object reaches the logger at all.
    expect(call.some((arg: unknown) => arg instanceof Error)).toBe(false);
    expect(JSON.stringify(call)).not.toContain('pass');
    expect(JSON.stringify(call)).not.toContain('token=abc');
    expect((call[2] as Record<string, unknown>).reason).toBe('TypeError');
  });

  it('logs the HTTP status or a timeout as the reason', async () => {
    mockSettings({
      CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/hook',
    });
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));
    await notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'p' });
    expect((warnSpy.mock.calls[0][2] as Record<string, unknown>).reason).toBe('HTTP 503');

    fetchSpy.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    await notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'p' });
    expect((warnSpy.mock.calls[1][2] as Record<string, unknown>).reason).toBe(`timed out after ${BRAINBEAT_TIMEOUT_MS}ms`);
  });

  it('refuses redirects, so the secret and observation never reach another origin', async () => {
    const stolen: string[] = [];
    const elsewhere = Bun.serve({
      port: 0,
      async fetch(request) {
        stolen.push(`${request.headers.get('x-claude-mem-shared-secret')} ${await request.text()}`);
        return new Response(null, { status: 202 });
      },
    });
    const redirecting = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${elsewhere.port}/collect` } }),
    });
    try {
      mockSettings({
        CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'security_alert',
        CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: `http://127.0.0.1:${redirecting.port}/hook`,
        CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET: 'top-secret',
      });
      // No mock: the spy passes through to the real fetch.
      await notifyGrokBotBrainbeat({ observations: [observation], observationIds: [42], project: 'p' });

      expect(stolen).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      redirecting.stop(true);
      elsewhere.stop(true);
    }
  });

  it('reduces a URL to its origin for logs', () => {
    expect(webhookOrigin('https://user:pw@host.example:8443/a/b?x=1')).toBe('https://host.example:8443');
    expect(webhookOrigin('not a url')).toBe('(invalid webhook URL)');
  });

  it('keeps a bare system code in the reason, and nothing else from the error', () => {
    const refused = Object.assign(new TypeError('fetch failed for https://user:pw@host/'), { code: 'ConnectionRefused' });
    expect(brainbeatFailureReason(refused)).toBe('TypeError (ConnectionRefused)');
    const withCause = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    expect(brainbeatFailureReason(withCause)).toBe('TypeError (ECONNREFUSED)');
    const oddCode = Object.assign(new Error('x'), { code: 'https://user:pw@host/' });
    expect(brainbeatFailureReason(oddCode)).toBe('Error');
    expect(brainbeatFailureReason('boom')).toBe('unknown error');
  });
});
