import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionStore, TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS } from '../../src/services/sqlite/SessionStore.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { logger } from '../../src/utils/logger.js';
import {
  TELEGRAM_WRAPUP_PROMPT,
  buildTelegramWrapupPrompt,
  deliverSessionWrapup,
  formatWrapupMessage,
  joinStoredSummaryForTelegram,
  type TelegramWrapupFormatterInput,
  loadTelegramWrapupConfig,
  resolveWrapupRoute,
} from '../../src/services/integrations/TelegramWrapupNotifier.js';

describe('Telegram wrap-up notifier', () => {
  let store: SessionStore;
  const originalFetch = globalThis.fetch;
  const formatSummary = mock(async (_input: TelegramWrapupFormatterInput) => '• Shipped the wrap-up');

  beforeEach(() => {
    store = new SessionStore(':memory:');
    formatSummary.mockReset();
    formatSummary.mockImplementation(async () => '• Shipped the wrap-up');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
    store.close();
  });

  function settings(overrides: Partial<SettingsDefaults> = {}): SettingsDefaults {
    return {
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TELEGRAM_ENABLED: 'true',
      CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED: 'true',
      CLAUDE_MEM_TELEGRAM_BOT_TOKEN: 'default-token',
      CLAUDE_MEM_TELEGRAM_CHAT_ID: 'global-chat-that-wrapups-must-ignore',
      CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES: JSON.stringify({
        'project-a': {
          chat_id: 'route-chat',
          bot_token: 'route-token',
          key: 'route-a',
        },
      }),
      ...overrides,
    };
  }

  function createSession(project: string, contentSessionId: string): { sessionDbId: number; memorySessionId: string } {
    const sessionDbId = store.createSDKSession(contentSessionId, project, 'prompt', undefined, 'claude');
    const memorySessionId = 'memory-' + contentSessionId;
    store.updateMemorySessionId(sessionDbId, memorySessionId);
    return { sessionDbId, memorySessionId };
  }

  function storeSummary(memorySessionId: string, project: string, request = 'Build the Telegram wrap-up notifier'): void {
    store.storeSummary(memorySessionId, project, {
      request,
      investigated: 'Read the notifier design',
      learned: 'Routes must be per project',
      completed: 'Stored one durable ledger claim',
      next_steps: 'Wire SessionEnd in a later phase',
      notes: null,
    }, 3);
  }

  function successfulFetch(): typeof fetch {
    return mock((_url: string | URL | Request, _init?: RequestInit) => (
      Promise.resolve(new Response('', { status: 200 }))
    )) as unknown as typeof fetch;
  }

  it('uses only the exact formatting instruction and the unabridged summary', () => {
    const summaryText = 'Full summary\n'.repeat(1_000);
    const instruction = 'format as a very short bulleted list that narratively explains this summary in < 255 char';
    expect(TELEGRAM_WRAPUP_PROMPT).toBe(instruction);
    expect(buildTelegramWrapupPrompt(summaryText)).toBe(`${instruction}\n\n${summaryText}`);
  });

  it('joins stored fields plainly without trimming or adding field labels', () => {
    expect(joinStoredSummaryForTelegram({
      request: '  request\ncontinued  ',
      investigated: 'investigated',
      learned: 'learned',
      completed: 'completed',
      next_steps: 'next steps',
      files_read: '["read.ts"]',
      files_edited: '["edited.ts"]',
      notes: 'notes',
    })).toBe('  request\ncontinued  \ninvestigated\nlearned\ncompleted\nnext steps\n["read.ts"]\n["edited.ts"]\nnotes');
  });

  it('passes every field of the latest stored summary whole to the formatter', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-whole-summary');
    storeSummary(memorySessionId, 'project-a', 'outdated summary');
    const summary = {
      request: 'request '.repeat(1_000),
      investigated: '  investigated\nwith details  ',
      learned: 'learned',
      completed: 'completed',
      next_steps: 'next steps',
      files_read: ['read.ts'],
      files_edited: ['edited.ts'],
      notes: 'notes '.repeat(1_000),
    };
    store.storeSummary(memorySessionId, 'project-a', summary, 4, 0, Date.now() + 1);
    const fetchMock = successfulFetch();

    await deliverSessionWrapup({ sessionStore: store, sessionDbId, formatSummary, settings: settings(), fetchImpl: fetchMock });

    expect(formatSummary).toHaveBeenCalledWith({
      sessionDbId,
      contentSessionId: 'content-whole-summary',
      project: 'project-a',
      platformSource: 'claude',
      summaryText: [summary.request, summary.investigated, summary.learned, summary.completed,
        summary.next_steps, '["read.ts"]', '["edited.ts"]', summary.notes].join('\n'),
    });
  });

  it('escapes model bullets without adding headings or hand-written sections', () => {
    expect(formatWrapupMessage('- Fixed a_bug.\n* Shipped [tests]!'))
      .toBe('\\- Fixed a\\_bug\\.\n\\* Shipped \\[tests\\]\\!');
  });

  it.each(['-', '*', '•'])('caps %s lists at the last complete bullet under 255 characters', marker => {
    const first = `${marker} ${'a'.repeat(100)}`;
    const second = `${marker} ${'b'.repeat(100)}`;
    const third = `${marker} ${'c'.repeat(100)}`;
    const formatted = formatWrapupMessage(`${first}\n${second}\n${third}`);
    expect(formatted).toBe(formatWrapupMessage(`${first}\n${second}`));
    expect(formatted.length).toBeLessThanOrEqual(255);
    expect(formatted).not.toContain('ccc');
  });

  it('keeps multiline bullets intact when capping and accounts for MarkdownV2 escaping', () => {
    const first = `• ${'a'.repeat(100)}\n  continued`;
    const second = `• ${'_'.repeat(100)}`;
    expect(formatWrapupMessage(`${first}\n${second}`)).toBe(first);
  });

  it('allows exactly 255 characters and discards the next complete bullet', () => {
    const full = `• ${'a'.repeat(253)}`;
    expect(formatWrapupMessage(full)).toBe(full);
    expect(formatWrapupMessage(`${full}\n• extra`)).toBe(full);
  });

  it('logs and rejects an oversized first bullet rather than silently returning an empty message', () => {
    const log = spyOn(logger, 'error').mockImplementation(() => {});
    expect(() => formatWrapupMessage(`• ${'a'.repeat(300)}\n• Later bullet`))
      .toThrow('no complete bullet within 255 characters');
    expect(log).toHaveBeenCalledWith('TELEGRAM', expect.any(String), expect.objectContaining({ bullets: 2 }), expect.any(Error));
  });

  it('logs and rejects an empty model response even outside the delivery wrapper', () => {
    const log = spyOn(logger, 'error').mockImplementation(() => {});
    expect(() => formatWrapupMessage('  ')).toThrow('formatter returned no text');
    expect(log).toHaveBeenCalledWith('TELEGRAM', 'Telegram wrap-up formatter returned no text', {}, expect.any(Error));
  });

  it('keeps Unicode and MarkdownV2 escapes intact within the 255-character cap', () => {
    const first = `• ${'😀_'.repeat(60)}`;
    const formatted = formatWrapupMessage(`${first}\n• ${'more'.repeat(100)}`);
    expect(formatted).toBe(`• ${'😀\\_'.repeat(60)}`);
    expect(formatted.length).toBeLessThanOrEqual(255);
  });

  it('caps the actual Telegram payload at a complete bullet boundary', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-capped');
    storeSummary(memorySessionId, 'project-a');
    formatSummary.mockResolvedValueOnce(`• Shipped\n• ${'more details '.repeat(100)}`);
    const fetchMock = successfulFetch();

    await deliverSessionWrapup({ sessionStore: store, sessionDbId, formatSummary, settings: settings(), fetchImpl: fetchMock });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.text).toBe('• Shipped');
    expect(body.parse_mode).toBe('MarkdownV2');
  });

  it.each(['string', 'text blocks'])('delivers non-empty text from the real OpenRouter response envelope (%s)', async shape => {
    const { sessionDbId, memorySessionId } = createSession('project-a', `content-provider-${shape}`);
    storeSummary(memorySessionId, 'project-a');
    const config = settings({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'mock-key',
      CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_TIER_SUMMARY_MODEL: '',
    });
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(config);
    // Same choices/message/reasoning/usage envelope as the summary-generator
    // fixtures in tests/worker/openrouter-empty-content.test.ts. Only the
    // assistant answer belongs in Telegram, never reasoning or tool data.
    const answer = '• SessionEnd sends one short wrap-up\n• Stop keeps storing summaries';
    const inferenceFetch = mock(async () => new Response(JSON.stringify({
      model: 'deepseek/deepseek-v4-flash-0731',
      choices: [{
        message: {
          role: 'assistant',
          content: shape === 'string' ? answer : answer.split('\n').map(text => ({ type: 'text', text })),
          reasoning_content: 'Private reasoning is not a notification',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
    }), { status: 200 }));
    globalThis.fetch = inferenceFetch as unknown as typeof fetch;
    const provider = new OpenRouterProvider({} as never, {} as never);
    const telegramFetch = successfulFetch();

    await expect(deliverSessionWrapup({
      sessionStore: store, sessionDbId, settings: config, fetchImpl: telegramFetch,
      formatSummary: input => provider.formatTelegramWrapup(input),
    })).resolves.toBe('sent');

    expect(inferenceFetch).toHaveBeenCalledTimes(1);
    const [url, request] = inferenceFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cmem.ai/api/inference/v1/chat/completions');
    const body = JSON.parse(String(request.body));
    expect(body.model).toBe('cmem-observer');
    expect(body.max_tokens).toBe(4096);
    expect(body.response_format).toEqual({ type: 'text' });
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.messages).toEqual([{
      role: 'user', content: buildTelegramWrapupPrompt(joinStoredSummaryForTelegram(store.getSummaryForSession(memorySessionId)!)),
    }]);
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const final = JSON.parse(String(telegramFetch.mock.calls[0][1]?.body));
    expect(final.text).toBe('• SessionEnd sends one short wrap\\-up\n• Stop keeps storing summaries');
    expect(final.text.length).toBeGreaterThan(0);
    expect(final.text.length).toBeLessThanOrEqual(255);
  });

  it('does not call the model or Telegram when wrap-ups are disabled', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-disabled');
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();

    await expect(deliverSessionWrapup({
      sessionStore: store, sessionDbId, formatSummary, fetchImpl: fetchMock,
      settings: settings({ CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED: 'false' }),
    })).resolves.toBe('disabled');

    expect(formatSummary).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['error', 'empty'])('releases the claim after a formatter %s so delivery can retry', async failure => {
    const { sessionDbId, memorySessionId } = createSession('project-a', `content-formatter-${failure}`);
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();
    if (failure === 'error') formatSummary.mockRejectedValueOnce(new Error('formatter failed'));
    else formatSummary.mockResolvedValueOnce('  ');
    const input = { sessionStore: store, sessionDbId, formatSummary, settings: settings(), fetchImpl: fetchMock };

    await expect(deliverSessionWrapup(input)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(deliverSessionWrapup(input)).resolves.toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(formatSummary).toHaveBeenCalledTimes(2);
  });

  it('resolves exact routes, parent-project routes, and rejects unknown projects', () => {
    const config = loadTelegramWrapupConfig(settings({
      CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES: JSON.stringify({
        'project-a': { chat_id: 'exact-chat', key: 'exact-key' },
        parent: { chat_id: 'parent-chat' },
      }),
    }));

    expect(resolveWrapupRoute(config, 'project-a')).toMatchObject({
      chatId: 'exact-chat',
      botToken: 'default-token',
      routeKey: 'exact-key',
      matchedProject: 'project-a',
    });
    expect(resolveWrapupRoute(config, 'parent/child')).toMatchObject({
      chatId: 'parent-chat',
      botToken: 'default-token',
      routeKey: 'parent',
      matchedProject: 'parent',
    });
    expect(resolveWrapupRoute(config, 'unknown-project')).toBeNull();
  });

  it('returns no_summary without posting when the session has no stored summary', async () => {
    const { sessionDbId } = createSession('project-a', 'content-no-summary');
    const fetchMock = successfulFetch();

    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('no_summary');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(formatSummary).not.toHaveBeenCalled();
  });

  it('posts once to the configured route and records the sent ledger claim', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-sent');
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();

    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('sent');
    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('already_sent');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botroute-token/sendMessage');
    const body = JSON.parse(String(init.body)) as { chat_id: string; text: string };
    expect(body.chat_id).toBe('route-chat');
    expect(body.text).toBe('• Shipped the wrap\\-up');
    expect(formatSummary).toHaveBeenCalledTimes(1);
  });

  it('allows only one concurrent caller to post a session wrap-up', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-race');
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();

    await Promise.all([
      deliverSessionWrapup({
        sessionStore: store,
        sessionDbId,
        formatSummary,
        settings: settings(),
        fetchImpl: fetchMock,
      }),
      deliverSessionWrapup({
        sessionStore: store,
        sessionDbId,
        formatSummary,
        settings: settings(),
        fetchImpl: fetchMock,
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reclaims an expired interrupted claim and sends the deferred wrap-up', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-interrupted');
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();
    const ledgerInput = {
      platformSource: 'claude',
      contentSessionId: 'content-interrupted',
      project: 'project-a',
      routeKey: 'route-a',
    };

    expect(store.claimTelegramWrapup({
      ...ledgerInput,
      summaryCreatedAtEpoch: 1_700_000_000_000,
    })).toBe(true);
    store.db.prepare(`
      UPDATE telegram_wrapups
      SET claimed_at_epoch = ?
      WHERE content_session_id = ?
    `).run(Date.now() - TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS - 1, ledgerInput.contentSessionId);

    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('sent');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the global chat when no project route exists', async () => {
    const { sessionDbId, memorySessionId } = createSession('unrouted-project', 'content-no-route');
    storeSummary(memorySessionId, 'unrouted-project');
    const fetchMock = successfulFetch();

    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('no_route');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases a failed claim so a later delivery can retry', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-retry');
    storeSummary(memorySessionId, 'project-a');
    let failPost = true;
    const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) => {
      const response = failPost
        ? new Response('', { status: 500, statusText: 'Server Error' })
        : new Response('', { status: 200 });
      return Promise.resolve(response);
    }) as unknown as typeof fetch;

    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).rejects.toThrow('Telegram API responded 500 Server Error');

    failPost = false;
    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('sent');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains a claim after a successful post when marking it sent fails', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-mark-failure');
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();
    const originalMarkTelegramWrapupSent = store.markTelegramWrapupSent;
    store.markTelegramWrapupSent = () => {
      throw new Error('simulated ledger write failure');
    };

    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).rejects.toThrow('simulated ledger write failure');

    const claim = store.db.query(
      "SELECT status FROM telegram_wrapups WHERE content_session_id = 'content-mark-failure'",
    ).get() as { status: string } | null;
    expect(claim?.status).toBe('claimed');

    store.markTelegramWrapupSent = originalMarkTelegramWrapupSent;
    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      formatSummary,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('already_sent');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
