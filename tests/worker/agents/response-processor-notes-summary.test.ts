import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { parseAgentXml } from '../../../src/sdk/parser.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';

const settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile');
afterEach(() => settingsSpy.mockRestore());

describe('notes-only summary replies', () => {
  it('stores the notes and confirms the real queued summary', async () => {
    settingsSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    }));
    const store = new SessionStore(':memory:');
    const dbManager = {
      getSessionById: (id: number) => store.getSessionById(id),
      getSessionStore: () => store,
      getChromaSync: () => null,
      getCloudSync: () => null,
    } as unknown as DatabaseManager;
    const manager = new SessionManager(dbManager);
    const sid = store.createSDKSession('notes-content', 'notes-project', 'Review notes');
    const session = manager.initializeSession(sid, undefined, 1);
    session.memorySessionId = 'notes-memory';
    store.ensureMemorySessionIdRegistered(sid, session.memorySessionId);
    session.lastGeneratorSource = 'summarize';
    manager.queueSummarize(sid, 'Keep the release notes');
    const messages = manager.getMessageIterator(sid);
    try {
      expect((await messages.next()).value.type).toBe('summarize');
      const result = await processAgentResponse(
        '<summary><notes>Migration requires a backup &amp; review.</notes></summary>',
        session, dbManager, manager, undefined, 10, null, 'SDK',
      );
      expect(result?.summaryId).toBeGreaterThan(0);
      expect(store.getSummaryForSession('notes-memory')?.notes).toBe('Migration requires a backup & review.');
      expect(manager.getTotalQueueDepth()).toBe(0);
    } finally {
      session.abortController.abort();
      await messages.return(undefined);
      manager.removeSessionImmediate(sid);
      store.close();
    }
  });

  it('still rejects missing and whitespace-only summary fields', () => {
    for (const raw of ['<summary></summary>', '<summary><notes> &#32;&#10; </notes></summary>']) {
      expect(parseAgentXml(raw).valid).toBe(false);
    }
  });
});
