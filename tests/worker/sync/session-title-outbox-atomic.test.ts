import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { MEDIA_PROMPT_PLACEHOLDER } from '../../../src/services/sqlite/prompt-storage.js';
import { CloudSync } from '../../../src/services/sync/CloudSync.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import type { CanonicalHubChange, CanonicalWireOp } from '../../../src/services/sync/CanonicalContent.js';

function refuseTitleOutbox(store: SessionStore): void {
  store.db.exec(`CREATE TRIGGER owned_title_outbox_failure BEFORE INSERT ON sync_outbox
    WHEN json_extract(NEW.body, '$.op') = 'set_title'
    BEGIN SELECT RAISE(ABORT, 'owned_title_outbox_failure'); END`);
}
function titleOps(store: SessionStore): any[] {
  return (store.db.query('SELECT body FROM sync_outbox ORDER BY id').all() as { body: string }[])
    .map(row => JSON.parse(row.body));
}

describe('local session titles and their sync operations commit together', () => {
  for (const existing of [false, true]) {
    it(`rolls back a failed ${existing ? 'title fill' : 'titled session insert'} and publishes its retry once`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'claude-mem-title-atomic-'));
      const databasePath = join(directory, 'memory.db');
      let store = new SessionStore(databasePath, { syncOpsEnabled: true });
      const receiver = new SessionStore(':memory:');
      let sync: CloudSync | undefined;
      try {
        const originalId = existing ? store.createSDKSession('conversation', 'unknown', MEDIA_PROMPT_PLACEHOLDER, undefined, 'cursor') : null;
        const before = store.db.query('SELECT * FROM sdk_sessions').all();
        refuseTitleOutbox(store);
        expect(() => store.createSDKSession('conversation', 'real-project', 'Real opening prompt', 'Chosen title', 'cursor'))
          .toThrow('owned_title_outbox_failure');
        expect(store.db.query('SELECT * FROM sdk_sessions').all()).toEqual(before);
        expect(titleOps(store)).toEqual([]);

        // The atomic outcome must survive reopening the actual database.
        store.close();
        store = new SessionStore(databasePath, { syncOpsEnabled: true });
        expect(store.db.query('SELECT * FROM sdk_sessions').all()).toEqual(before);
        store.db.exec('DROP TRIGGER owned_title_outbox_failure');
        const id = store.createSDKSession('conversation', 'real-project', 'Real opening prompt', 'Chosen title', 'cursor');
        if (originalId !== null) expect(id).toBe(originalId);
        expect(store.getSessionById(id)).toMatchObject({
          project: 'real-project', user_prompt: 'Real opening prompt', custom_title: 'Chosen title', platform_source: 'cursor',
        });
        expect(store.createSDKSession('conversation', 'real-project', 'Later prompt', 'Later suggested title', 'cursor')).toBe(id);
        expect(titleOps(store)).toEqual([{
          op: 'set_title', target: { content_session_id: 'conversation', platform_source: 'cursor' },
          fields: { custom_title: 'Chosen title' },
        }]);

        const changes: CanonicalHubChange[] = [];
        sync = new CloudSync(store.db, {
          CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'owned-token', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'owned-user',
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'title-device',
          CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'owned-device',
        }, { settingsPath: join(directory, 'settings.json'), fetchImpl: (async (_input, init) => {
          const { ops } = JSON.parse(String(init?.body)) as { ops: CanonicalWireOp[] };
          const acked = ops.map(wire => {
            const envelope = JSON.parse(wire.body), seq = String(changes.length + 1);
            changes.push({ ...wire, seq, server_ts: String(Date.now()) });
            return { id: envelope.id, kind: envelope.kind, origin_local_id: envelope.origin_local_id,
              entity_rev: envelope.entity_rev, operation_sha256: wire.operation_sha256, seq };
          });
          return Response.json({ acked, head_seq: String(changes.length), projected_seq: String(changes.length) });
        }) as typeof fetch });
        await sync.flush();
        await sync.flush();
        expect(changes).toHaveLength(1);
        expect(titleOps(store)).toEqual([]);
        const receiverId = receiver.createSDKSession('conversation', 'real-project', 'Receiver opening', undefined, 'cursor');
        const applied = new SyncApply(receiver.db, { deviceId: 'receiver' }).applyOps(decodeChanges(changes), { requireContiguous: true });
        expect(applied.applied).toBe(1);
        expect(receiver.getSessionById(receiverId)?.custom_title).toBe('Chosen title');
      } finally {
        sync?.stop(); store.close(); receiver.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it('leaves an existing title and the sync-disabled path independent of a failing outbox', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: true });
    const disabled = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      const id = store.createSDKSession('existing', 'project', 'prompt', 'Original');
      refuseTitleOutbox(store);
      expect(store.createSDKSession('existing', 'project', 'prompt', 'Ignored')).toBe(id);
      expect(store.getSessionById(id)?.custom_title).toBe('Original');
      expect(titleOps(store)).toHaveLength(1);
      refuseTitleOutbox(disabled);
      const local = disabled.createSDKSession('local', 'project', 'prompt', 'Local title');
      expect(disabled.getSessionById(local)?.custom_title).toBe('Local title');
      expect(titleOps(disabled)).toEqual([]);
    } finally { store.close(); disabled.close(); }
  });

  it('participates in a caller-owned transaction without publishing after its rollback', () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: true });
    try {
      expect(() => store.db.transaction(() => {
        store.createSDKSession('nested', 'project', 'prompt', 'Nested title');
        throw new Error('owned outer rollback');
      })()).toThrow('owned outer rollback');
      expect(store.db.query('SELECT * FROM sdk_sessions').all()).toEqual([]);
      expect(titleOps(store)).toEqual([]);
    } finally { store.close(); }
  });
});
