import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore Telegram wrap-ups', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function ledgerInput() {
    return {
      platformSource: 'claude',
      contentSessionId: 'content-wrapup-1',
      project: 'project-a',
      routeKey: 'project-a',
    };
  }

  it('creates schema version 52 and the Telegram wrap-up ledger', () => {
    const version = store.db.query(
      'SELECT version FROM schema_versions WHERE version = 52',
    ).get() as { version: number } | null;
    const table = store.db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_wrapups'",
    ).get() as { name: string } | null;

    expect(version?.version).toBe(52);
    expect(table?.name).toBe('telegram_wrapups');
  });

  it('claims once, releases a claim, and can claim again', () => {
    const input = ledgerInput();

    expect(store.claimTelegramWrapup({
      ...input,
      summaryCreatedAtEpoch: 1_700_000_000_000,
    })).toBe(true);
    expect(store.claimTelegramWrapup({
      ...input,
      summaryCreatedAtEpoch: 1_700_000_000_000,
    })).toBe(false);

    store.releaseTelegramWrapupClaim(input);

    expect(store.claimTelegramWrapup({
      ...input,
      summaryCreatedAtEpoch: 1_700_000_000_000,
    })).toBe(true);
  });

  it('finds a session by platform and content id without inserting an unknown session', () => {
    const sessionDbId = store.createSDKSession(
      'content-wrapup-lookup',
      'project-a',
      'prompt',
      undefined,
      'codex',
    );
    const before = store.db.query('SELECT COUNT(*) AS count FROM sdk_sessions').get() as { count: number };

    expect(store.findSessionDbIdByContentSessionId('content-wrapup-lookup', 'codex')).toBe(sessionDbId);
    expect(store.findSessionDbIdByContentSessionId('content-wrapup-lookup', 'claude')).toBeNull();
    expect(store.findSessionDbIdByContentSessionId('unknown-content-session', 'codex')).toBeNull();

    const after = store.db.query('SELECT COUNT(*) AS count FROM sdk_sessions').get() as { count: number };
    expect(after.count).toBe(before.count);
  });
});
