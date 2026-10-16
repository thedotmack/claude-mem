// work_state as a cloud sync content kind: the table's sync columns (v66), the
// row's canonical op, the push gated on the hub's `content_kinds`, and the
// apply of a row pulled from another device. Harness style as cloud-sync.test.ts
// and sync-apply.test.ts: in-memory SessionStore, injected fetch, fast debounce.
// The upgrade block covers the two schema steps (v66, v67) over databases from
// before and after v65, the Unicode title-key refresh's run-once gate.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { LATEST_SCHEMA_VERSION, readSchemaWriterStamp } from '../../../src/services/sqlite/connection.js';
import { computeTitleNormKey } from '../../../src/services/sqlite/dedup-store.js';
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

  it('gives the table its sync columns (v66) and replays rows by write clock, not rowid', () => {
    const columns = (db.query('PRAGMA table_info(work_state_entries)').all() as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['synced_at', 'origin_device_id', 'origin_local_id', 'sync_rev']));
    expect(db.query('SELECT version FROM schema_versions WHERE version = 66').all()).toHaveLength(1);

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

const SYNC_LEDGERS = ['sync_entity_heads', 'sync_content_outbox', 'sync_launch_exclusions'];
const WORK_STATE_SYNC_COLUMNS = ['synced_at', 'origin_device_id', 'origin_local_id', 'sync_rev'];

function tableSql(db: Database, table: string): string {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
}

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

function appliedVersions(db: Database): number[] {
  return (db.query('SELECT version FROM schema_versions ORDER BY version').all() as Array<{ version: number }>)
    .map(row => row.version);
}

/**
 * Undo the two work-state sync steps on a database the current chain built:
 * the ledgers' kind CHECK goes back to the three launch kinds, the table loses
 * its sync columns, and the v66/v67 rows go. What is left is main's v65 schema.
 */
function rollBackWorkStateSyncSteps(db: Database): void {
  for (const table of SYNC_LEDGERS) {
    const sql = tableSql(db, table);
    db.run(`DROP TABLE ${table}`);
    db.run(sql.replace(", 'work_state'", ''));
  }
  db.run('DROP INDEX idx_work_state_entries_unsynced');
  db.run('DROP INDEX ux_work_state_entries_origin');
  for (const column of WORK_STATE_SYNC_COLUMNS) db.run(`ALTER TABLE work_state_entries DROP COLUMN ${column}`);
  db.run('DELETE FROM schema_versions WHERE version IN (66, 67)');
}

/** Counts every attempt to write the v65 row, kept or ignored: a BEFORE trigger fires either way. */
function countV65Writes(db: Database): () => number {
  db.run('CREATE TEMP TABLE v65_writes (attempt INTEGER)');
  db.run(`CREATE TEMP TRIGGER count_v65_writes BEFORE INSERT ON schema_versions
    WHEN NEW.version = 65 BEGIN INSERT INTO v65_writes VALUES (1); END`);
  return () => (db.query('SELECT COUNT(*) AS n FROM v65_writes').get() as { n: number }).n;
}

describe('work_state sync schema upgrade (v66, v67)', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('applies both steps to a database that already ran v65, and never writes the v65 row', () => {
    rollBackWorkStateSyncSteps(db);
    db.run('PRAGMA user_version = 65'); // the writer stamp main leaves at v65
    expect(appliedVersions(db).at(-1)).toBe(65);
    for (const table of SYNC_LEDGERS) expect(tableSql(db, table)).not.toContain("'work_state'");
    // Rows written on main's schema must survive the upgrade.
    const entryId = store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { task: 'publish', status: 'todo' } });
    db.prepare(`
      INSERT INTO sync_entity_heads
        (entity_id, kind, origin_device_id, origin_local_id, entity_rev, operation_sha256, deleted, updated_at_epoch)
      VALUES ('head-1', 'observation', ?, '1', '1', 'sha', 0, 1)
    `).run(SELF);
    const v65Writes = countV65Writes(db);

    new SessionStore(db);

    expect(columnNames(db, 'work_state_entries')).toEqual(expect.arrayContaining(WORK_STATE_SYNC_COLUMNS));
    // The row written before the upgrade is native and waits for its first push.
    expect(db.prepare('SELECT synced_at, origin_device_id, sync_rev FROM work_state_entries WHERE id = ?').get(entryId))
      .toEqual({ synced_at: null, origin_device_id: null, sync_rev: '1' });
    for (const table of SYNC_LEDGERS) expect(tableSql(db, table)).toContain("'work_state'");
    expect(db.query('SELECT entity_id, kind FROM sync_entity_heads').all()).toEqual([{ entity_id: 'head-1', kind: 'observation' }]);
    db.run("INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev) VALUES ('work_state', '1', '1')");
    expect(appliedVersions(db)).toEqual(expect.arrayContaining([65, 66, 67]));
    expect(readSchemaWriterStamp(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(v65Writes()).toBe(0);
  });

  it('still runs the v65 Unicode title-key refresh on a database from before v65', () => {
    const sessionId = store.createSDKSession('content-1', 'proj-x', 'prompt');
    store.updateMemorySessionId(sessionId, 'memory-1');
    const observationId = store.storeObservation('memory-1', 'proj-x', {
      type: 'discovery', title: 'कि', subtitle: null, narrative: 'कि',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1).id;
    rollBackWorkStateSyncSteps(db);
    db.run("UPDATE observations SET title_norm_key = 'pre-v65' WHERE id = ?", [observationId]);
    db.run('DELETE FROM schema_versions WHERE version = 65');
    db.run('PRAGMA user_version = 0'); // binaries from before the writer stamp never set it
    const v65Writes = countV65Writes(db);

    new SessionStore(db);

    expect(db.query('SELECT title_norm_key FROM observations WHERE id = ?').get(observationId))
      .toEqual({ title_norm_key: computeTitleNormKey('proj-x', 'claude', 'कि') });
    expect(v65Writes()).toBe(1); // the refresh's own row, and no other writer
    expect(appliedVersions(db)).toEqual(expect.arrayContaining([65, 66, 67]));
    expect(columnNames(db, 'work_state_entries')).toEqual(expect.arrayContaining(WORK_STATE_SYNC_COLUMNS));
    for (const table of SYNC_LEDGERS) expect(tableSql(db, table)).toContain("'work_state'");
  });
});
