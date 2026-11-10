import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { buildContentOperation, buildMutationOperation } from '../../../src/services/sync/CanonicalContent.js';

const epoch = Date.parse('2026-11-01T12:00:00.000Z');
const createdAt = new Date(epoch).toISOString();

describe('replicated session title platform identity', () => {
  let db: Database;
  let store: SessionStore;
  let apply: SyncApply;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    apply = new SyncApply(db, { deviceId: 'local-fixture' });
  });
  afterEach(() => store.close());

  function title(seq: number, platform: string | undefined, text: string) {
    return { seq: String(seq), ...buildMutationOperation({
      originDeviceId: 'remote-fixture', entityRev: '1',
      mutation: { op: 'set_title', target: { content_session_id: 'shared-conversation',
        ...(platform === undefined ? {} : { platform_source: platform }) },
        fields: { custom_title: text } },
    }) };
  }

  function prompt(seq: number, platform: string, memorySessionId: string | null = null) {
    return { seq: String(seq), ...buildContentOperation({
      kind: 'prompt', originDeviceId: 'remote-fixture', originLocalId: String(seq), entityRev: '1',
      payload: { project: 'project', content_session_id: 'shared-conversation',
        memory_session_id: memorySessionId, platform_source: platform, prompt_number: '1',
        prompt_text: 'A real user request', created_at: createdAt, created_at_epoch: String(epoch) },
    }) };
  }

  it('keeps a title parked until a prompt from its own platform arrives', () => {
    apply.applyOps(decodeChanges([prompt(1, 'claude'), title(2, 'claude', 'Claude title')]));
    const result = apply.applyOps(decodeChanges([title(3, 'codex', 'Codex title')]));
    expect(result.applied).toBe(1);
    expect(db.query("SELECT custom_title FROM sdk_sessions WHERE platform_source = 'claude'").get())
      .toEqual({ custom_title: 'Claude title' });
    expect(db.query("SELECT v FROM sync_state WHERE k = 'parked_title:content:codex:shared-conversation'").get())
      .toEqual({ v: 'Codex title' });

    apply.applyOps(decodeChanges([prompt(4, 'codex')]));
    expect(db.query('SELECT platform_source, custom_title FROM sdk_sessions ORDER BY platform_source').all())
      .toEqual([{ platform_source: 'claude', custom_title: 'Claude title' },
        { platform_source: 'codex', custom_title: 'Codex title' }]);
    expect(db.query("SELECT count(*) AS n FROM sync_state WHERE k LIKE 'parked_title:%'").get()).toEqual({ n: 0 });
  });

  it('does not apply a default-platform title to a non-Claude prompt', () => {
    apply.applyOps(decodeChanges([prompt(1, 'codex'), title(2, 'codex', 'Existing Codex title')]));
    apply.applyOps(decodeChanges([title(3, undefined, 'Incoming Claude title')]));
    expect(db.query("SELECT custom_title FROM sdk_sessions WHERE platform_source = 'codex'").get())
      .toEqual({ custom_title: 'Existing Codex title' });
    apply.applyOps(decodeChanges([prompt(4, 'claude')]));
    expect(db.query("SELECT custom_title FROM sdk_sessions WHERE platform_source = 'claude'").get())
      .toEqual({ custom_title: 'Incoming Claude title' });
  });

  it('still resolves a same-platform prompt attached to a synthetic content id', () => {
    const id = store.createSDKSession('synthetic-id', 'project', 'seed', undefined, undefined, 'claude');
    store.ensureMemorySessionIdRegistered(id, 'shared-memory');
    apply.applyOps(decodeChanges([prompt(1, 'claude', 'shared-memory'), title(2, 'claude', 'Resolved by prompt')]));
    expect(db.query('SELECT content_session_id, custom_title FROM sdk_sessions WHERE id = ?').get(id))
      .toEqual({ content_session_id: 'synthetic-id', custom_title: 'Resolved by prompt' });
  });
  it('titles a Codex session whose memories arrived before its first prompt', () => {
    // Memory-first replay: the observation creates a memory-keyed stub with a
    // synthetic content id and the default platform, the prompt teaches it the
    // real Codex identity, and the Codex title must land on it, not park.
    const source = new SessionStore(':memory:');
    try {
      const session = source.createSDKSession('shared-conversation', 'project', 'A real user request', undefined, 'codex');
      source.ensureMemorySessionIdRegistered(session, 'codex-memory');
      const observation = source.storeObservation('codex-memory', 'project', {
        type: 'discovery', title: 'Codex evidence', subtitle: null, narrative: 'Persisted evidence',
        facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [],
      }, 1, 0, epoch).id;
      const promptId = source.saveUserPrompt('shared-conversation', 1, 'A real user request', session, undefined, undefined, epoch);
      const content = (seq: number, kind: 'observation' | 'prompt', id: number) => ({
        ...getNativeContentOperation(source.db, kind, String(id), 'remote-fixture')!.operation,
        seq: String(seq), server_ts: String(epoch),
      });
      const result = apply.applyOps(decodeChanges([
        content(1, 'observation', observation), content(2, 'prompt', promptId), title(3, 'codex', 'Codex title'),
      ]));
      expect(result.quarantined).toBe(0);
      expect(db.query('SELECT content_session_id, platform_source, custom_title FROM sdk_sessions WHERE memory_session_id = ?')
        .get('codex-memory')).toEqual({ content_session_id: 'shared-conversation', platform_source: 'codex', custom_title: 'Codex title' });
      expect(db.query("SELECT count(*) AS n FROM sync_state WHERE k LIKE 'parked_title:%'").get()).toEqual({ n: 0 });
    } finally {
      source.close();
    }
  });
});
