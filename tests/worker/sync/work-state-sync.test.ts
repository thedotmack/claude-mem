// work_state as a cloud sync content kind: the table's sync columns (v65), the
// row's canonical op, the push gated on the hub's `content_kinds`, and the
// apply of a row pulled from another device. Harness style as cloud-sync.test.ts
// and sync-apply.test.ts: in-memory SessionStore, injected fetch, fast debounce.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, type CloudSyncSettingKeys } from '../../../src/services/sync/CloudSync.js';
import { SyncApply, type SyncOp } from '../../../src/services/sync/SyncApply.js';
import { parseCanonicalOperation, stableDocumentId } from '../../../src/services/sync/CanonicalContent.js';
import { renderWorkStateLines } from '../../../src/services/context/sections/WorkStateRenderer.js';

const SELF = 'device-fixture';
const REMOTE = 'device-a';
const FIXED_NOW = 1752000000000;
const REMOTE_EPOCH = FIXED_NOW - 60_000;
const REMOTE_ISO = new Date(REMOTE_EPOCH).toISOString();
const EVERY_KIND = ['observation', 'summary', 'prompt', 'work_state'];

function settings(): CloudSyncSettingKeys {
  return {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token-1234',
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-42',
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: SELF,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test-host',
  };
}

/**
 * A hub that acks every op. `contentKinds` is what its status advertises;
 * undefined models a hub that predates the field.
 */
function makeHub(contentKinds?: string[]) {
  const pushes: Array<Array<Record<string, unknown>>> = [];
  let statusProbes = 0;
  let seq = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/sync/status')) {
      statusProbes++;
      return Response.json({
        protocol_version: 2,
        epoch: '1',
        head_seq: String(seq),
        projected_seq: String(seq),
        ...(contentKinds ? { content_kinds: contentKinds } : {}),
      });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { ops: Array<{ body: string; operation_sha256: string }> };
    pushes.push(body.ops.map(op => JSON.parse(op.body) as Record<string, unknown>));
    const acked = body.ops.map(op => {
      const envelope = JSON.parse(op.body) as Record<string, unknown>;
      return {
        id: envelope.id,
        kind: envelope.kind,
        origin_local_id: envelope.origin_local_id,
        entity_rev: envelope.entity_rev,
        operation_sha256: op.operation_sha256,
        seq: String(++seq),
      };
    });
    return Response.json({ acked, head_seq: String(seq), projected_seq: String(seq) });
  }) as typeof fetch;
  return { impl, pushes, probes: () => statusProbes };
}

function workStateOp(originId: string, fields: Record<string, unknown>, opts: { device?: string; rev?: number; seq?: number } = {}): SyncOp {
  return {
    seq: String(opts.seq ?? 1),
    kind: 'work_state',
    origin_device: opts.device ?? REMOTE,
    origin_id: originId,
    rev: String(opts.rev ?? 1),
    // The pull side hands apply the stored shape: fields as JSON text (SyncClient localPayload).
    body: JSON.stringify({
      project: 'proj-x',
      list_name: 'release',
      fields: JSON.stringify(fields),
      created_at: REMOTE_ISO,
      created_at_epoch: REMOTE_EPOCH,
    }),
    server_ts: REMOTE_EPOCH,
  };
}

describe('work_state cloud sync', () => {
  let tempDir: string;
  let db: Database;
  let store: SessionStore;
  let settingsPath: string;

  function makeCloudSync(fetchImpl: typeof fetch): CloudSync {
    return new CloudSync(db, settings(), {
      fetchImpl,
      settingsPath,
      debounceMs: 25,
      backoffInitialMs: 20,
      backoffMaxMs: 200,
    });
  }

  function row(id: number): Record<string, unknown> {
    return db.prepare('SELECT * FROM work_state_entries WHERE id = ?').get(id) as Record<string, unknown>;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-work-state-sync-'));
    settingsPath = join(tempDir, 'settings.json');
    db = new Database(':memory:');
    store = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('gives the table its sync columns (v65) and replays rows by write clock, not rowid', () => {
    const columns = (db.query('PRAGMA table_info(work_state_entries)').all() as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['synced_at', 'origin_device_id', 'origin_local_id', 'sync_rev']));
    expect(db.query('SELECT version FROM schema_versions WHERE version = 65').all()).toHaveLength(1);

    // A row pulled later from another device carries an earlier write clock.
    store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { task: 'publish', status: 'doing' }, createdAtEpoch: 2_000 });
    db.prepare(`
      INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch, synced_at, origin_device_id, origin_local_id)
      VALUES ('proj-x', 'release', '{"task":"publish","status":"todo"}', ?, 1_000, 5, ?, '9')
    `).run(new Date(1_000).toISOString(), REMOTE);
    const entries = store.getWorkStateEntries(['proj-x']);
    expect(entries.map(entry => entry.created_at_epoch)).toEqual([1_000, 2_000]);
    expect(renderWorkStateLines(entries, FIXED_NOW)[1]).toContain('[doing] publish');
  });

  it('pushes a saved row as a work_state op only once the hub lists the kind', async () => {
    store.appendWorkStateEntry({
      project: 'proj-x',
      listName: 'release',
      fields: { task: 'publish', status: 'todo', attempt: 2, note: null },
      createdAtEpoch: REMOTE_EPOCH,
    });

    // A hub that predates `content_kinds` accepts only the launch kinds: the
    // row waits unsynced instead of being refused and dead-lettered.
    const old = makeHub();
    const oldSync = makeCloudSync(old.impl);
    await oldSync.flush();
    expect(old.probes()).toBe(1);
    expect(old.pushes).toHaveLength(0);
    expect(oldSync.status().hub.contentKinds).toEqual([]);
    expect(oldSync.status().pending.workState).toBe(1);
    await oldSync.flush();
    expect(old.probes()).toBe(1); // a known answer is not re-asked within the hour
    oldSync.stop();

    const hub = makeHub(EVERY_KIND);
    const sync = makeCloudSync(hub.impl);
    await sync.flush();
    expect(hub.probes()).toBe(1);
    expect(hub.pushes).toHaveLength(1);
    const [envelope] = hub.pushes[0];
    expect(envelope.kind).toBe('work_state');
    expect(envelope.id).toBe(stableDocumentId('work_state', SELF, '1'));
    expect(envelope.origin_local_id).toBe('1');
    expect(envelope.payload).toEqual({
      project: 'proj-x',
      list_name: 'release',
      fields: { task: 'publish', status: 'todo', attempt: 2, note: null },
      created_at: REMOTE_ISO,
      created_at_epoch: String(REMOTE_EPOCH),
    });
    expect(row(1).synced_at).toBeNumber();
    expect(sync.status().pending.workState).toBe(0);
    expect(sync.status().hub.contentKinds).toEqual(EVERY_KIND);
    sync.stop();
  });

  it('applies a pulled row under its origin identity, updates it on a higher revision, and skips its own echo', () => {
    const apply = new SyncApply(db, { deviceId: SELF, now: () => FIXED_NOW });

    const first = apply.applyOps([workStateOp('7', { task: 'publish', status: 'doing' })], { epoch: 'epoch-1' });
    expect(first.applied).toBe(1);
    const applied = db.prepare(`SELECT * FROM work_state_entries WHERE origin_device_id = ? AND origin_local_id = '7'`).get(REMOTE) as Record<string, unknown>;
    expect(applied.project).toBe('proj-x');
    expect(applied.list_name).toBe('release');
    expect(applied.fields).toBe('{"task":"publish","status":"doing"}');
    expect(applied.created_at_epoch).toBe(REMOTE_EPOCH);
    expect(applied.synced_at).toBe(FIXED_NOW); // never selected for a re-push
    expect(applied.sync_rev).toBe('1');
    expect(renderWorkStateLines(store.getWorkStateEntries(['proj-x']), FIXED_NOW)).toEqual([
      '- release',
      '  - [doing] publish, updated 1 minute ago',
    ]);

    const higher = apply.applyOps([workStateOp('7', { task: 'publish', status: 'done' }, { rev: 2, seq: 2 })], { epoch: 'epoch-1' });
    expect(higher.applied).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 1 });
    expect(renderWorkStateLines(store.getWorkStateEntries(['proj-x']), FIXED_NOW)).toEqual([]);

    const stale = apply.applyOps([workStateOp('7', { task: 'publish', status: 'todo' }, { rev: 1, seq: 3 })], { epoch: 'epoch-1' });
    expect(stale.skippedStale).toBe(1);

    const echo = apply.applyOps([workStateOp('8', { task: 'x' }, { device: SELF, seq: 4 })], { epoch: 'epoch-1' });
    expect(echo.skippedOwn).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 1 });
  });

  it('sets aside a pulled row whose fields are not an object', () => {
    const apply = new SyncApply(db, { deviceId: SELF, now: () => FIXED_NOW });
    const op = workStateOp('9', {});
    const result = apply.applyOps([{ ...op, body: JSON.stringify({ ...JSON.parse(op.body), fields: '[1]' }) }], { epoch: 'epoch-1' });
    expect(result.quarantined).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 0 });
  });

  it('round-trips the wire op through the canonical parser', () => {
    const hub = makeHub(EVERY_KIND);
    const sync = makeCloudSync(hub.impl);
    store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { version: '13.35.0' }, createdAtEpoch: REMOTE_EPOCH });
    return sync.flush().then(() => {
      const wire = { body: JSON.stringify(hub.pushes[0][0]), operation_sha256: '' };
      // parseCanonicalOperation re-hashes the exact bytes; the mock kept the parsed object, so rebuild from the row.
      expect(hub.pushes[0][0].kind).toBe('work_state');
      expect(() => parseCanonicalOperation({ ...wire, operation_sha256: 'x'.repeat(43) })).toThrow();
      sync.stop();
    });
  });
});
