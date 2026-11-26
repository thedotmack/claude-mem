// Greptile P2 on #6506: a summary-only generator has no observation to inherit
// a checkout from. The checkout sent with the Stop payload must survive the
// queue so the live turn can resolve the project's host model.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ingestSummarize, setIngestContext } from '../../src/services/worker/http/shared.js';
import { logger } from '../../src/utils/logger.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

describe('summary checkout reaches the queued message (#6506)', () => {
  let store: SessionStore;
  let manager: SessionManager;
  let spies: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(() => {
    spies = [
      spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(
        () => SettingsDefaultsManager.getAllDefaults()
      ),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    store = new SessionStore(new Database(':memory:'));
    manager = new SessionManager({
      getSessionStore: () => store,
      getSessionById: (id: number) => store.getSessionById(id),
      getChromaSync: () => null,
      getCloudSync: () => null,
    } as unknown as DatabaseManager);
    setIngestContext({
      sessionManager: manager as never,
      dbManager: { getSessionStore: () => store } as never,
      eventBroadcaster: { broadcastSummarizeQueued() {} } as never,
      ensureGeneratorRunning: async () => {},
    });
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    store.close();
  });

  it('carries the Stop payload cwd from ingest through queueSummarize to the generator', async () => {
    const sid = store.createSDKSession('summary-cwd', 'a-project', 'first prompt', undefined, 'claude');
    const outcome = await ingestSummarize({
      contentSessionId: 'summary-cwd',
      platformSource: 'claude',
      lastAssistantMessage: 'answer',
      cwd: '/work/checkout',
    });

    expect(outcome.status).toBe('accepted');

    let queued: { type?: string; cwd?: string } | undefined;
    for await (const message of manager.getMessageIterator(sid)) {
      queued = message;
      break;
    }
    expect(queued?.type).toBe('summarize');
    expect(queued?.cwd).toBe('/work/checkout');
  });
});
