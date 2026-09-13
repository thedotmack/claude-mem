import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionStore, TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS } from '../../src/services/sqlite/SessionStore.js';
import {
  deliverSessionWrapup,
  loadTelegramWrapupConfig,
  resolveWrapupRoute,
} from '../../src/services/integrations/TelegramWrapupNotifier.js';

describe('Telegram wrap-up notifier', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
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
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('no_summary');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts once to the configured route and records the sent ledger claim', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-sent');
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();

    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('sent');
    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('already_sent');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botroute-token/sendMessage');
    const body = JSON.parse(String(init.body)) as { chat_id: string; text: string };
    expect(body.chat_id).toBe('route-chat');
    expect(body.text).toContain('Build the Telegram wrap\\-up notifier');
  });

  it('allows only one concurrent caller to post a session wrap-up', async () => {
    const { sessionDbId, memorySessionId } = createSession('project-a', 'content-race');
    storeSummary(memorySessionId, 'project-a');
    const fetchMock = successfulFetch();

    await Promise.all([
      deliverSessionWrapup({
        sessionStore: store,
        sessionDbId,
        settings: settings(),
        fetchImpl: fetchMock,
      }),
      deliverSessionWrapup({
        sessionStore: store,
        sessionDbId,
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
      settings: settings(),
      fetchImpl: fetchMock,
    })).rejects.toThrow('Telegram API responded 500 Server Error');

    failPost = false;
    await expect(deliverSessionWrapup({
      sessionStore: store,
      sessionDbId,
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
      settings: settings(),
      fetchImpl: fetchMock,
    })).resolves.toBe('already_sent');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
