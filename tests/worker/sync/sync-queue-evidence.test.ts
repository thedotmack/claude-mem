import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { readSyncQueueInventory, SyncQueueEvidenceReader, type SyncQueueFlags } from '../../../src/services/sync/SyncQueueEvidence.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const enabled: SyncQueueFlags = { deviceId: 'local-test', sharedWorkWritesEnabled: true, workStateSupported: true };

function fixture(path = ':memory:'): Database {
  const db = new Database(path);
  cleanup.push(() => { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); });
  for (const table of ['observations', 'session_summaries', 'user_prompts', 'work_state_entries']) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, sync_rev TEXT NOT NULL DEFAULT '1',
      synced_at INTEGER, origin_device_id TEXT, list_name TEXT, created_at_epoch INTEGER NOT NULL,
      memory_session_id TEXT, project TEXT, merged_into_project TEXT, content_session_id TEXT, session_db_id INTEGER)`);
  }
  db.exec(`CREATE TABLE sync_content_outbox (id INTEGER PRIMARY KEY, kind TEXT, origin_local_id TEXT,
    entity_rev TEXT, body TEXT, deleted INTEGER DEFAULT 0, created_at_epoch INTEGER);
    CREATE TABLE sync_outbox (id INTEGER PRIMARY KEY, created_at_epoch INTEGER, rev TEXT DEFAULT '1', body TEXT DEFAULT '{}', canonical_body TEXT);
    CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, memory_session_id TEXT, content_session_id TEXT, project TEXT)`);
  return db;
}

function frozen(db: Database, kind: string, local: string, rev: string, at: number, deleted = 0, list?: string): void {
  db.prepare(`INSERT INTO sync_content_outbox(kind, origin_local_id, entity_rev, body, deleted, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?)`).run(kind, local, rev, JSON.stringify({ payload: list ? { list_name: list } : null }), deleted, at);
}

it('counts distinct native revisions, frozen rows, and true queue ages without changing source rows', () => {
  const db = fixture();
  db.exec(`INSERT INTO observations(id,sync_rev,synced_at,origin_device_id,list_name,created_at_epoch) VALUES (1,'1',NULL,NULL,NULL,10), (2,'2',NULL,NULL,NULL,20),
    (3,'1',90,NULL,NULL,30), (4,'1',NULL,'remote',NULL,40);
    INSERT INTO session_summaries(id,sync_rev,synced_at,origin_device_id,list_name,created_at_epoch) VALUES (1,'1',NULL,NULL,NULL,50);
    INSERT INTO work_state_entries(id,sync_rev,synced_at,origin_device_id,list_name,created_at_epoch) VALUES (1,'1',NULL,NULL,'ordinary',60),
    (2,'1',NULL,NULL,'__my_work_v1:secret',70), (3,'1',NULL,NULL,'__my_work_v1:frozen',80);
    INSERT INTO sync_outbox(id,created_at_epoch) VALUES (1,600), (2,700)`);
  frozen(db, 'observation', '1', '1', 1000);
  frozen(db, 'observation', '2', '1', 1100);
  frozen(db, 'observation', '99', '2', 1200, 1);
  frozen(db, 'work_state', '3', '1', 2000, 0, '__my_work_v1:frozen');
  frozen(db, 'work_state', '99', '2', 2100, 1);
  const before = db.serialize();
  const inventory = readSyncQueueInventory(db, { ...enabled, sharedWorkWritesEnabled: false });
  expect(inventory.kinds.observation).toEqual({ nativePending: 1, frozenPending: 3, eligiblePending: 4,
    heldPending: 0, heldSharedState: 0, heldUnsupportedKind: 0, heldMutation: 0, oldestMutationHeldQueuedAt: null, tombstones: 1,
    oldestQueuedAt: 1000, oldestEligibleQueuedAt: 1000, oldestNativeCreatedAt: 20 });
  expect(inventory.kinds.summary.oldestQueuedAt).toBeNull();
  expect(inventory.kinds.summary.oldestNativeCreatedAt).toBe(50);
  expect(inventory.kinds.work_state).toEqual({ nativePending: 2, frozenPending: 2, eligiblePending: 2,
    heldPending: 2, heldSharedState: 2, heldUnsupportedKind: 0, heldMutation: 0, oldestMutationHeldQueuedAt: null, tombstones: 1,
    oldestQueuedAt: 2000, oldestEligibleQueuedAt: 2100, oldestNativeCreatedAt: 60 });
  expect(inventory.mutations).toEqual({ pending: 2, oldestQueuedAt: 600 });
  expect(inventory.tombstones).toEqual({ pending: 2, eligiblePending: 2, oldestQueuedAt: 1200 });
  expect(db.serialize()).toEqual(before);

  const unsupported = readSyncQueueInventory(db, { ...enabled, sharedWorkWritesEnabled: false, workStateSupported: false });
  expect(unsupported.kinds.work_state).toMatchObject({ eligiblePending: 0, heldPending: 4, heldSharedState: 2,
    heldUnsupportedKind: 4, oldestEligibleQueuedAt: null });
  expect(unsupported.tombstones.eligiblePending).toBe(1);
  expect(readSyncQueueInventory(db, enabled).kinds.work_state.eligiblePending).toBe(4);
});

it('returns unknown for in-memory and closed readers and collapses pending reads', async () => {
  const unknown = new SyncQueueEvidenceReader(':memory:');
  expect(unknown.getSnapshot(enabled)).toEqual({ inventory: null, observedAt: null, stale: true, refreshing: false });
  expect(await unknown.read(enabled)).toBeNull();
  unknown.close();

  const directory = mkdtempSync(join(tmpdir(), 'sync-queue-evidence-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'queue.db');
  fixture(path);
  const reader = new SyncQueueEvidenceReader(path);
  cleanup.push(() => reader.close());
  const first = reader.getSnapshot(enabled);
  expect(first).toEqual({ inventory: null, observedAt: null, stale: true, refreshing: true });
  const pending = reader.read(enabled);
  expect(reader.read(enabled)).toBe(pending);
  const result = await pending;
  expect(result?.kinds.observation.nativePending).toBe(0);
  expect(reader.getSnapshot(enabled)).toMatchObject({ inventory: result, observedAt: result?.observedAt, stale: false, refreshing: false });
  expect(reader.getSnapshot({ ...enabled, workStateSupported: false })).toMatchObject({ stale: true, refreshing: true });
  await reader.read(enabled);
  reader.close();
  expect(await reader.read(enabled)).toBeNull();
});

it('counts mutation-held revisions while leaving unrelated rows and frozen prerequisites eligible', () => {
  const db = fixture();
  db.exec(`INSERT INTO observations(id,sync_rev,project,created_at_epoch) VALUES
    (1,'2','new',10), (2,'1','unrelated',20);
    INSERT INTO work_state_entries(id,sync_rev,project,list_name,created_at_epoch) VALUES (1,'1','new','ordinary',30)`);
  const mutation = { op: 'remap_project', where: { project: 'old' }, fields: { project: 'new' } };
  db.prepare('INSERT INTO sync_outbox(id,created_at_epoch,rev,body) VALUES (1,100,?,?)').run('2', JSON.stringify(mutation));
  frozen(db, 'observation', '3', '1', 1000);
  frozen(db, 'observation', '4', '2', 2000);
  db.prepare('UPDATE sync_content_outbox SET body = ? WHERE origin_local_id = ?').run(JSON.stringify({ payload: { project: 'old', memory_session_id: 'memory-1' } }), '3');
  db.prepare('UPDATE sync_content_outbox SET body = ? WHERE origin_local_id = ?').run(JSON.stringify({ payload: { project: 'new', memory_session_id: 'memory-1' } }), '4');
  const inventory = readSyncQueueInventory(db, enabled);
  expect(inventory.kinds.observation).toMatchObject({ nativePending: 2, frozenPending: 2, eligiblePending: 2,
    heldPending: 2, heldMutation: 2, oldestMutationHeldQueuedAt: 2000, oldestEligibleQueuedAt: 1000 });
  expect(inventory.kinds.work_state).toMatchObject({ eligiblePending: 1, heldPending: 0, heldMutation: 0 });

  // A later title also affects the old bytes, but cannot hold the prerequisite
  // of the FIFO remap ahead of it: that would report a queue that cannot advance.
  db.prepare('INSERT INTO sync_outbox(id,created_at_epoch,rev,body) VALUES (2,200,?,?)').run('1', JSON.stringify({
    op: 'set_title', target: { memory_session_id: 'memory-1' }, fields: { custom_title: 'Title' },
  }));
  expect(readSyncQueueInventory(db, enabled).kinds.observation).toMatchObject({
    eligiblePending: 2, heldPending: 2, heldMutation: 2,
    oldestMutationHeldQueuedAt: 2000, oldestEligibleQueuedAt: 1000,
  });
});

it('serves cached status and HTTP while a queue inventory read is waiting on SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-queue-isolation-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'queue.db');
  const db = fixture(path);
  db.exec('PRAGMA journal_mode = DELETE');
  const reader = new SyncQueueEvidenceReader(path);
  cleanup.push(() => reader.close());
  const first = await reader.read(enabled);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json(reader.getSnapshot(enabled)) });
  cleanup.push(() => server.stop(true));
  db.exec('BEGIN EXCLUSIVE');
  let finished = false;
  const held = reader.read(enabled).then(value => { finished = true; return value; });
  await Bun.sleep(50);
  const response = await fetch(`http://127.0.0.1:${server.port}`, { signal: AbortSignal.timeout(1000) });
  expect(await response.json()).toMatchObject({ observedAt: first?.observedAt, refreshing: true });
  expect(finished).toBe(false);
  db.exec('ROLLBACK');
  expect(await held).not.toBeNull();
}, 15_000);

it('retains its last observation as stale when a later inventory cannot be read', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-queue-stale-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'queue.db');
  const db = fixture(path);
  const reader = new SyncQueueEvidenceReader(path);
  cleanup.push(() => reader.close());
  const inventory = await reader.read(enabled);
  db.exec('DROP TABLE sync_outbox');
  expect(await reader.read(enabled)).toBeNull();
  expect(reader.getSnapshot(enabled)).toEqual({ inventory, observedAt: inventory?.observedAt ?? null,
    stale: true, refreshing: false });
});

it('loads the inventory role through the packaged CJS worker entrypoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-queue-bundle-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'queue.db');
  fixture(databasePath);
  const banner = [
    'var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");',
    'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;',
  ].join('\n');
  for (const [entry, output] of [
    ['src/services/sync/SyncQueueEvidence.ts', 'queue-client.cjs'],
    ['src/services/work-view/work-view-read-worker.ts', 'work-view-read-worker.cjs'],
  ]) {
    await build({ entryPoints: [entry], outfile: join(directory, output), bundle: true, platform: 'node', target: 'node18', format: 'cjs',
      external: ['bun:sqlite'], define: { 'import.meta.url': '__IMPORT_META_URL__' }, banner: { js: banner }, logLevel: 'silent' });
  }
  const bundled = await import(pathToFileURL(join(directory, 'queue-client.cjs')).href);
  const reader = new bundled.SyncQueueEvidenceReader(databasePath) as SyncQueueEvidenceReader;
  cleanup.push(() => reader.close());
  expect((await reader.read(enabled))?.mutations.pending).toBe(0);
});
