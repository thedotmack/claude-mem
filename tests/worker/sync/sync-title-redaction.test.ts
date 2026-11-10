import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildContentOperation, buildMutationOperation } from '../../../src/services/sync/CanonicalContent.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache } from '../../../src/utils/redaction.js';

const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const title = `Investigate fixture credential ${key}`;
const redacted = "Investigate fixture credential <redacted type='aws_access_key'/>";
const epoch = Date.parse('2026-11-01T12:00:00.000Z');

describe('receiving device redaction for synced session titles', () => {
  let store: SessionStore;
  let apply: SyncApply;
  let settingsSpy: ReturnType<typeof spyOn>;
  let enabled = true;

  beforeEach(() => {
    enabled = true;
    store = new SessionStore(':memory:');
    apply = new SyncApply(store.db, { deviceId: 'local-fixture' });
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_REDACT_ENABLED: String(enabled),
    }));
    _resetRedactionConfigCache();
  });
  afterEach(() => {
    settingsSpy.mockRestore();
    _resetRedactionConfigCache();
    store.close();
  });

  function receiveTitle(memoryTarget: boolean) {
    const wire = { seq: '1', ...buildMutationOperation({ originDeviceId: 'peer-fixture', entityRev: '1',
      mutation: { op: 'set_title', target: memoryTarget ? { memory_session_id: 'memory' }
        : { content_session_id: 'conversation', platform_source: 'claude' }, fields: { custom_title: title } },
    }) };
    const frozenWire = JSON.stringify(wire);
    const result = apply.applyOps(decodeChanges([wire]));
    expect(result.applied).toBe(1);
    expect(JSON.stringify(wire)).toBe(frozenWire);
  }

  function receivePrompt() {
    apply.applyOps(decodeChanges([{ seq: '2', ...buildContentOperation({
      kind: 'prompt', originDeviceId: 'peer-fixture', originLocalId: '1', entityRev: '1',
      payload: { project: 'project', content_session_id: 'conversation', memory_session_id: 'memory',
        platform_source: 'claude', prompt_number: '1', prompt_text: 'A user request',
        created_at: new Date(epoch).toISOString(), created_at_epoch: String(epoch) },
    }) }]));
  }

  for (const memoryTarget of [false, true]) {
    it(`redacts a ${memoryTarget ? 'memory' : 'content'} title before updating an existing session`, () => {
      const id = store.createSDKSession('conversation', 'project', 'seed');
      store.ensureMemorySessionIdRegistered(id, 'memory');
      receiveTitle(memoryTarget);
      expect(store.db.query('SELECT custom_title FROM sdk_sessions WHERE id = ?').get(id))
        .toEqual({ custom_title: redacted });
    });

    it(`redacts a ${memoryTarget ? 'memory' : 'content'} title before parking and later claiming it`, () => {
      receiveTitle(memoryTarget);
      expect(store.db.query("SELECT v FROM sync_state WHERE k LIKE 'parked_title:%'").all())
        .toEqual([{ v: redacted }]);
      receivePrompt();
      expect(store.db.query("SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'memory'").get())
        .toEqual({ custom_title: redacted });
      expect(store.db.query("SELECT v FROM sync_state WHERE k LIKE 'parked_title:%'").all()).toEqual([]);
    });
  }

  it('preserves the peer title when local redaction is disabled', () => {
    enabled = false;
    receiveTitle(false);
    receivePrompt();
    expect(store.db.query("SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'memory'").get())
      .toEqual({ custom_title: title });
  });
});
