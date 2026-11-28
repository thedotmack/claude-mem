import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { groupIdFor, ledgerFileHash } from '../../../src/services/work-view/request-groups.mjs';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';
import { readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';
import { removeTempDir } from '../../helpers/temp-dir.js';
import { scratchDir } from '../../helpers/scratch-dir.js';

// Two writers of one ledger file, each on its own connection, as the worker and a CLI run are. Whichever commits its
// shared records last must be what the shared record and the file hold, and a value built from a file another writer
// replaced since must be refused, never saved over the newer one.
const DEVICE = 'write-order-device';
const anchor = JSON.stringify(['conversation', 'claude', 'a']);
const groupId = groupIdFor(anchor);
const progressName = `progress/${groupId}.json`;

const disposals: Array<() => unknown> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

function fixture() {
  const dir = scratchDir('shared-ledger-write-order');
  disposals.push(() => removeTempDir(dir));
  const ledger = join(dir, 'work-view');
  mkdirSync(join(ledger, 'progress'), { recursive: true });
  writeFileSync(join(ledger, 'request-groups.json'), JSON.stringify({ version: 1, updatedAt: null,
    groups: { [groupId]: { title: 'Release cards', anchor, projectRoot: 'repo' } }, conversations: { [anchor]: groupId }, ignored: {}, suggestions: {} }));
  const databasePath = join(dir, 'claude-mem.db');
  const store = new SessionStore(databasePath);
  store.setLocalSyncDeviceId(DEVICE);
  disposals.push(() => store.close());
  /** A writer on its own connection. */
  const writer = (notify?: () => void) => {
    const db = new Database(databasePath);
    db.exec('PRAGMA busy_timeout = 5000');
    disposals.push(() => db.close());
    return new SharedLedgerAdapter(db, { directory: ledger, deviceId: DEVICE, ...(notify ? { notify } : {}) });
  };
  const progressFile = join(ledger, progressName);
  const sharedSummary = () => (readSharedRecords(store.db, { deviceId: DEVICE }).records.get(sharedRecordKey('progress', groupId))?.value as any)?.summary;
  const fileSummary = () => JSON.parse(readFileSync(progressFile, 'utf8')).summary;
  const leftovers = () => readdirSync(join(ledger, 'progress')).filter(name => name.endsWith('.tmp'));
  return { dir, databasePath, ledger, store, writer, progressFile, sharedSummary, fileSummary, leftovers };
}
const review = (summary: string, percent: number) => ({ groupId, state: 'in-progress', percent, summary });

for (const finishedFirst of ['the later write', 'the earlier write'] as const) {
  test(`of two writes of one file, the later commit survives in the shared record and the file when ${finishedFirst} finishes first`, () => {
    const f = fixture();
    const a = f.writer(), b = f.writer();
    // A commits, then B commits: B is the newer decision.
    const finishA = a.beforeWrite(progressName, review('A', 10))!;
    const finishB = b.beforeWrite(progressName, review('B', 20))!;
    // Each finish writes the file under the write lock, and only while its intent is still the newest. A's finish, run
    // last or first, finds B's intent and writes nothing: a superseded write is complete, never pending.
    const results = finishedFirst === 'the later write' ? [finishB(), finishA()] : [finishA(), finishB()];
    expect(results).toEqual([{ materialization: 'complete' }, { materialization: 'complete' }]);
    expect(f.fileSummary()).toBe('B');
    expect(f.leftovers()).toEqual([]);
    // The reconciler sees nothing to import: no file holds a value its records do not.
    expect(f.writer().reconcile({ captureActivity: false }).files).toEqual([]);
    expect(f.sharedSummary()).toBe('B');
    expect(f.fileSummary()).toBe('B');
  });
}

test('a write built from a file another writer replaced since, or while another write is still pending, is refused and saves nothing', () => {
  const f = fixture();
  const cli = f.writer(), worker = f.writer();
  expect(worker.saveFile(progressName, review('first', 10))).toEqual({ materialization: 'complete' });
  const readByCli = ledgerFileHash(f.progressFile);
  // The worker saves a newer review after the CLI read the file.
  expect(worker.saveFile(progressName, review('newer', 20))).toEqual({ materialization: 'complete' });
  expect(() => cli.beforeWrite(progressName, review('stale', 30), { readHash: readByCli }))
    .toThrow(`Shared My Work: ${progressName} changed since this command read it (another writer saved a newer version), so this write was not saved: no shared record and no file were written. Run the command again.`);
  expect([f.sharedSummary(), f.fileSummary()]).toEqual(['newer', 'newer']);
  // The worker's next write has committed and its file is not written yet: the file still hashes as the CLI read it, but
  // a value built from it would undo the committed decision.
  const readAgain = ledgerFileHash(f.progressFile);
  const finishWorker = worker.beforeWrite(progressName, review('committed', 40))!;
  expect(() => cli.beforeWrite(progressName, review('stale', 30), { readHash: readAgain })).toThrow('which is still being written to the file');
  expect(f.sharedSummary()).toBe('committed');
  expect(finishWorker()).toEqual({ materialization: 'complete' });
  // Built from the file as it is now, the write saves.
  expect(cli.beforeWrite(progressName, review('current', 50), { readHash: ledgerFileHash(f.progressFile) })!()).toEqual({ materialization: 'complete' });
  expect([f.sharedSummary(), f.fileSummary()]).toEqual(['current', 'current']);
});

test('a reconcile pass whose own finish was left pending runs again on the next pass, not from its cached result', () => {
  const f = fixture();
  let holder: Database | null = null;
  let takeLockOnCommit = false;
  // Another writer takes the lock right after this pass commits a local edit, before its finish records the file.
  const adapter = new SharedLedgerAdapter(f.store.db, { directory: f.ledger, deviceId: DEVICE, notify: () => {
    if (!takeLockOnCommit) return;
    takeLockOnCommit = false;
    holder = new Database(f.databasePath);
    disposals.push(() => holder?.close());
    holder.exec('BEGIN IMMEDIATE');
  } });
  expect(adapter.saveFile(progressName, review('saved', 10))).toEqual({ materialization: 'complete' });
  expect(adapter.reconcile({ captureActivity: false }).files).toEqual([]);
  // A local edit of the file, which the next pass imports.
  writeFileSync(f.progressFile, JSON.stringify(review('edited by hand', 15)));
  f.store.db.exec('PRAGMA busy_timeout = 200');
  takeLockOnCommit = true;
  // (The pass visits a progress file twice, once as a file-state row and once in the folder listing, so the second visit
  // also reports the lock.)
  expect(adapter.reconcile({ captureActivity: false }).files)
    .toContainEqual({ file: progressName, message: 'Saved; recording the local file is pending: another writer held the claude-mem database for longer than 200 ms' });
  expect(f.sharedSummary()).toBe('edited by hand');
  // That writer rolls back, so the database's data_version does not move and no file changes: only the pending finish
  // says this pass has work left.
  holder!.exec('ROLLBACK');
  expect(adapter.reconcile({ captureActivity: false }).files).toEqual([]);
  expect((f.store.db.query('SELECT pending_json FROM my_work_file_state WHERE name = ?').get(progressName) as any).pending_json).toBeNull();
  expect([f.sharedSummary(), f.fileSummary()]).toEqual(['edited by hand', 'edited by hand']);
});
