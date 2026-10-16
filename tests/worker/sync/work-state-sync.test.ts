// work_state as a cloud sync content kind: the table's sync columns (v66), the
// row's canonical op, the push gated on the hub's `content_kinds` (saved
// snapshots included, re-checked hourly), the apply of a row pulled from another
// device, the replay of ops an older build set aside, and one fold order on
// every device. Harness style as cloud-sync.test.ts and sync-apply.test.ts:
// in-memory SessionStore, injected fetch, fast debounce. The upgrade block
// covers the two schema steps (v66, v67) over databases from before and after
// v65, the Unicode title-key refresh's run-once gate.

import { describe, it, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { LATEST_SCHEMA_VERSION, readSchemaWriterStamp } from '../../../src/services/sqlite/connection.js';
import { computeTitleNormKey } from '../../../src/services/sqlite/dedup-store.js';
import {
  CloudSync,
  POISON_OP_REJECTION_THRESHOLD,
  type CloudSyncOptions,
  type CloudSyncSettingKeys,
} from '../../../src/services/sync/CloudSync.js';
import { SyncApply, type SyncOp } from '../../../src/services/sync/SyncApply.js';
import { SyncClient, decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { buildContentOperation, parseCanonicalOperation, stableDocumentId } from '../../../src/services/sync/CanonicalContent.js';
import { renderWorkStateLines } from '../../../src/services/context/sections/WorkStateRenderer.js';

const SELF = 'device-fixture';
const REMOTE = 'device-a';
const FIXED_NOW = 1752000000000;
const REMOTE_EPOCH = FIXED_NOW - 60_000;
const REMOTE_ISO = new Date(REMOTE_EPOCH).toISOString();
const EVERY_KIND = ['observation', 'summary', 'prompt', 'work_state'];
const LAUNCH_KINDS = ['observation', 'summary', 'prompt'];

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
 * A hub that acks every op. `contentKinds` is what its status advertises
 * (undefined models a hub that predates the field); setContentKinds changes it
 * mid-test, the way a per-account server setting does. Every POSTed op is
 * recorded, raw and parsed, before the hub answers. `failPushes` answers each
 * POST 503; `rejectWorkState` refuses a work_state op by name, as a hub that
 * does not know the kind does.
 */
function makeHub(initialContentKinds?: string[], options: { failPushes?: boolean; rejectWorkState?: boolean } = {}) {
  let contentKinds = initialContentKinds;
  const rawOps: Array<{ body: string; operation_sha256: string }> = [];
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
    const envelopes = body.ops.map(op => JSON.parse(op.body) as Record<string, unknown>);
    rawOps.push(...body.ops);
    pushes.push(envelopes);
    if (options.failPushes) return new Response('unavailable', { status: 503 });
    const refused = envelopes.findIndex(envelope => envelope.kind === 'work_state');
    if (options.rejectWorkState && refused >= 0) {
      return Response.json(
        { error: `invalid_ops: ops[${refused}] kind must be observation, summary, or prompt` },
        { status: 400 },
      );
    }
    const acked = body.ops.map((op, index) => ({
      id: envelopes[index].id,
      kind: envelopes[index].kind,
      origin_local_id: envelopes[index].origin_local_id,
      entity_rev: envelopes[index].entity_rev,
      operation_sha256: op.operation_sha256,
      seq: String(++seq),
    }));
    return Response.json({ acked, head_seq: String(seq), projected_seq: String(seq) });
  }) as typeof fetch;
  return {
    impl,
    pushes,
    rawOps,
    probes: () => statusProbes,
    pushedKinds: () => pushes.flat().map(envelope => envelope.kind),
    setContentKinds: (kinds: string[] | undefined) => { contentKinds = kinds; },
  };
}

function workStateOp(
  originId: string,
  fields: Record<string, unknown>,
  opts: { device?: string; rev?: number; seq?: number; listName?: string; createdAtEpoch?: number } = {},
): SyncOp {
  const createdAtEpoch = opts.createdAtEpoch ?? REMOTE_EPOCH;
  return {
    seq: String(opts.seq ?? 1),
    kind: 'work_state',
    origin_device: opts.device ?? REMOTE,
    origin_id: originId,
    rev: String(opts.rev ?? 1),
    // The pull side hands apply the stored shape: fields as JSON text (SyncClient localPayload).
    body: JSON.stringify({
      project: 'proj-x',
      list_name: opts.listName ?? 'release',
      fields: JSON.stringify(fields),
      created_at: new Date(createdAtEpoch).toISOString(),
      created_at_epoch: createdAtEpoch,
    }),
    server_ts: createdAtEpoch,
  };
}

/** Polls until `condition` holds, or fails the test after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('work_state cloud sync', () => {
  let tempDir: string;
  let db: Database;
  let store: SessionStore;
  let settingsPath: string;

  function makeCloudSync(fetchImpl: typeof fetch, overrides: Partial<CloudSyncOptions> = {}): CloudSync {
    return new CloudSync(db, settings(), {
      fetchImpl,
      settingsPath,
      debounceMs: 25,
      backoffInitialMs: 20,
      backoffMaxMs: 200,
      ...overrides,
    });
  }

  function row(id: number): Record<string, unknown> {
    return db.prepare('SELECT * FROM work_state_entries WHERE id = ?').get(id) as Record<string, unknown>;
  }

  function outboxKinds(): string[] {
    return (db.query('SELECT kind FROM sync_content_outbox ORDER BY id').all() as Array<{ kind: string }>).map(item => item.kind);
  }

  function deadLetterCount(): number {
    return (db.query('SELECT COUNT(*) AS n FROM sync_dead_letter').get() as { n: number }).n;
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

  it('sets aside a pulled row whose fields are not an object, or not JSON at all, each under its own reason', () => {
    const apply = new SyncApply(db, { deviceId: SELF, now: () => FIXED_NOW });
    const withFields = (op: SyncOp, fields: string): SyncOp => ({ ...op, body: JSON.stringify({ ...JSON.parse(op.body), fields }) });
    const result = apply.applyOps([
      withFields(workStateOp('9', {}, { seq: 1 }), '[1]'),
      withFields(workStateOp('10', {}, { seq: 2 }), '{not json'),
    ], { epoch: 'epoch-1' });
    expect(result.quarantined).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 0 });
    const reasons = (db.query('SELECT reason FROM sync_pull_quarantine ORDER BY seq').all() as Array<{ reason: string }>)
      .map(item => item.reason);
    expect(reasons[0]).toContain('work_state fields must be a JSON object');
    expect(reasons[1]).toContain('work_state fields is not parseable JSON');
  });

  it('round-trips the pushed wire op: its exact bytes parse, and another device applies them', async () => {
    const hub = makeHub(EVERY_KIND);
    const sync = makeCloudSync(hub.impl);
    store.appendWorkStateEntry({
      project: 'proj-x', listName: 'release', fields: { version: '13.35.0', attempt: 2, shipped: false }, createdAtEpoch: REMOTE_EPOCH,
    });
    await sync.flush();
    sync.stop();
    expect(hub.rawOps).toHaveLength(1);
    const [wire] = hub.rawOps;
    // parseCanonicalOperation re-hashes the bytes the hub received.
    expect(parseCanonicalOperation(wire).kind).toBe('work_state');

    // Another device pulls the same bytes as a hub change and applies them.
    const otherDb = new Database(':memory:');
    try {
      const otherStore = new SessionStore(otherDb);
      const result = new SyncApply(otherDb, { deviceId: REMOTE, now: () => FIXED_NOW })
        .applyOps(decodeChanges([{ seq: '1', ...wire }]), { epoch: 'epoch-1' });
      expect(result).toMatchObject({ applied: 1, quarantined: 0 });
      expect(otherStore.getWorkStateEntries(['proj-x'])).toEqual([expect.objectContaining({
        list_name: 'release',
        fields: { version: '13.35.0', attempt: 2, shipped: false },
        created_at_epoch: REMOTE_EPOCH,
      })]);
      expect(otherDb.query('SELECT origin_device_id, origin_local_id FROM work_state_entries').get())
        .toEqual({ origin_device_id: SELF, origin_local_id: '1' });
    } finally {
      otherDb.close();
    }
  });

  it('holds a saved work_state snapshot until the hub lists the kind, and never dead-letters it', async () => {
    store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { task: 'publish', status: 'todo' }, createdAtEpoch: REMOTE_EPOCH });

    // The push fails after the snapshot is saved, so the snapshot waits in the outbox.
    const failing = makeHub(EVERY_KIND, { failPushes: true });
    const first = makeCloudSync(failing.impl);
    await first.flush();
    first.stop();
    expect(outboxKinds()).toEqual(['work_state']);

    // After a restart the client has not asked yet. A hub that does not list
    // the kind, and refuses it by name, never sees the snapshot, even past the
    // poison-op threshold that would dead-letter a refused op.
    const old = makeHub(undefined, { rejectWorkState: true });
    const restarted = makeCloudSync(old.impl);
    for (let attempt = 0; attempt <= POISON_OP_REJECTION_THRESHOLD; attempt++) await restarted.flush();
    restarted.stop();
    expect(old.pushedKinds()).toEqual([]);
    expect(outboxKinds()).toEqual(['work_state']);
    expect(deadLetterCount()).toBe(0);
    expect(row(1).synced_at).toBeNull();

    // A hub that lists the kind receives the saved snapshot.
    const hub = makeHub(EVERY_KIND);
    const sync = makeCloudSync(hub.impl);
    await sync.flush();
    sync.stop();
    expect(hub.pushedKinds()).toEqual(['work_state']);
    expect(outboxKinds()).toEqual([]);
    expect(row(1).synced_at).toBeNumber();
  });

  it('re-asks a hub that lists the kind once an hour, and holds work_state after the hub stops listing it', async () => {
    const hub = makeHub(EVERY_KIND);
    const sync = makeCloudSync(hub.impl);
    try {
      store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { task: 'publish' }, createdAtEpoch: REMOTE_EPOCH });
      await sync.flush();
      expect(hub.pushedKinds()).toEqual(['work_state']);

      // The account's server setting is turned off, and a new row is written.
      hub.setContentKinds(LAUNCH_KINDS);
      store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { task: 'review' }, createdAtEpoch: REMOTE_EPOCH + 1 });
      await sync.flush();
      expect(hub.probes()).toBe(1); // within the hour the last answer stands
      expect(hub.pushedKinds()).toEqual(['work_state', 'work_state']);

      store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { task: 'tag' }, createdAtEpoch: REMOTE_EPOCH + 2 });
      setSystemTime(new Date(Date.now() + 61 * 60_000));
      try {
        await sync.flush();
      } finally {
        setSystemTime();
      }
      expect(hub.probes()).toBe(2);
      expect(hub.pushedKinds()).toEqual(['work_state', 'work_state']);
      expect(sync.status().hub.contentKinds).toEqual(LAUNCH_KINDS);
      expect(sync.status().pending.workState).toBe(1);
      expect(deadLetterCount()).toBe(0);
    } finally {
      sync.stop();
    }
  });

  it('re-asks on its own while work_state waits, so an idle device needs no new write', async () => {
    const hub = makeHub(undefined);
    const sync = makeCloudSync(hub.impl, { contentKindsReprobeMs: 40 });
    try {
      store.appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { task: 'publish' }, createdAtEpoch: REMOTE_EPOCH });
      await sync.flush();
      expect(hub.pushedKinds()).toEqual([]);

      // The hub starts listing the kind. Nothing is written, so nothing calls notify().
      hub.setContentKinds(EVERY_KIND);
      await waitFor(() => sync.status().pending.workState === 0);
      expect(hub.pushedKinds()).toEqual(['work_state']);
      expect(hub.probes()).toBeGreaterThanOrEqual(2);
    } finally {
      sync.stop();
    }
  });

  it('applies, exactly once after the upgrade, a work_state op an older build set aside as undecodable', () => {
    // Stored the way 13.29.0 to 13.39.x set it aside: no kind, the raw hub change, never retried.
    const wire = buildContentOperation({
      kind: 'work_state',
      originDeviceId: REMOTE,
      originLocalId: '7',
      entityRev: '1',
      payload: {
        project: 'proj-x',
        list_name: 'release',
        fields: { task: 'publish', status: 'doing' },
        created_at: REMOTE_ISO,
        created_at_epoch: String(REMOTE_EPOCH),
      },
    });
    db.prepare(`
      INSERT INTO sync_pull_quarantine (epoch, seq, reason, raw_body, retryable, created_at_epoch)
      VALUES ('1', '3', 'kind must be observation, summary, or prompt', ?, 0, ?)
    `).run(JSON.stringify({ seq: '3', ...wire, server_ts: String(REMOTE_EPOCH) }), FIXED_NOW);
    const apply = new SyncApply(db, { deviceId: SELF, now: () => FIXED_NOW });
    const noNetwork = (async () => { throw new Error('no network in this test'); }) as typeof fetch;
    const boot = () => {
      const client = new SyncClient(apply, {
        hubUrl: 'https://hub.test', token: 'test-token-1234', userId: 'user-42', deviceId: SELF, fetchImpl: noNetwork, wsEnabled: false,
      });
      client.start();
      client.stop();
    };

    boot();
    boot();

    expect(db.query('SELECT origin_device_id, origin_local_id, fields FROM work_state_entries').all()).toEqual([
      { origin_device_id: REMOTE, origin_local_id: '7', fields: '{"status":"doing","task":"publish"}' },
    ]);
    expect(db.query('SELECT COUNT(*) AS n FROM sync_pull_quarantine').get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM sync_state WHERE k = 'work_state_set_aside_replayed'").get()).toEqual({ n: 1 });
    expect(renderWorkStateLines(store.getWorkStateEntries(['proj-x']), FIXED_NOW)).toEqual([
      '- release',
      '  - [doing] publish, updated 1 minute ago',
    ]);
  });

  it('folds same-millisecond writes from two devices the same way on both, as cmem.ai does', () => {
    // Each device writes a state value and a list of its own at the same
    // millisecond, then pulls the other's two rows; on each device its own rows
    // carry the lower rowids. cmem.ai's order: the clock, the device id, its rowid.
    const devices = [
      { id: 'device-a', phase: 'alpha', list: 'alpha-list' },
      { id: 'device-b', phase: 'beta', list: 'beta-list' },
    ];
    const databases = devices.map(() => new Database(':memory:'));
    try {
      const stores = databases.map(database => new SessionStore(database));
      devices.forEach((device, index) => {
        stores[index].setLocalSyncDeviceId(device.id);
        stores[index].appendWorkStateEntry({ project: 'proj-x', listName: 'release', fields: { phase: device.phase }, createdAtEpoch: REMOTE_EPOCH });
        stores[index].appendWorkStateEntry({ project: 'proj-x', listName: device.list, fields: { owner: device.id }, createdAtEpoch: REMOTE_EPOCH });
      });
      devices.forEach((device, index) => {
        const other = devices[1 - index];
        new SyncApply(databases[index], { deviceId: device.id, now: () => FIXED_NOW }).applyOps([
          workStateOp('1', { phase: other.phase }, { device: other.id, seq: 1 }),
          workStateOp('2', { owner: other.id }, { device: other.id, seq: 2, listName: other.list }),
        ], { epoch: 'epoch-1' });
      });

      const [onA, onB] = stores.map(each => renderWorkStateLines(each.getWorkStateEntries(['proj-x']), FIXED_NOW));
      expect(onA).toEqual([
        '- beta-list: owner=device-b, updated 1 minute ago',
        '- release: phase=beta, updated 1 minute ago',
        '- alpha-list: owner=device-a, updated 1 minute ago',
      ]);
      expect(onB).toEqual(onA);
    } finally {
      for (const database of databases) database.close();
    }
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
