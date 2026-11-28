import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../src/services/sqlite/connection.js';
import { ensureLocalDeviceIdentity } from '../../../src/services/sync/local-device-identity.js';
import { groupIdFor } from '../../../src/services/work-view/request-groups.mjs';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';
import { readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';
import { removeTempDir } from '../../helpers/temp-dir.js';
import { scratchDir } from '../../helpers/scratch-dir.js';

// The CLI's ledger writes with shared state on (record-progress, apply) commit their shared records to claude-mem.db,
// then write their file. Another writer holding the database must make a write wait up to the worker's busy timeout,
// never fail it at once; a refusal must leave neither half (no shared record and no file); and a write whose records
// committed is saved, whatever happens to its file afterwards.
const DEVICE = 'busy-test-device';
const anchor = JSON.stringify(['conversation', 'claude', 'a']);
const groupId = groupIdFor(anchor);
const progressName = `progress/${groupId}.json`;
const reviewJson = JSON.stringify({ groupId, state: 'in-progress', percent: 40, summary: 'Under way.',
  reviewBasis: { checkedThrough: '2026-11-27T10:00:00.000Z', conversations: [anchor] } });
// Named pipes hand a run its input only when the test says so; Windows has none. The progress-folder test needs a folder
// the run cannot create files in, which a root user can.
const testWithNamedPipes = process.platform === 'win32' ? test.skip : test;
const testWithFilePermissions = process.platform === 'win32' || process.getuid?.() === 0 ? test.skip : test;

const disposals: Array<() => unknown> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

function fixture() {
  const dir = scratchDir('record-progress-busy');
  disposals.push(() => removeTempDir(dir));
  const ledger = join(dir, 'work-view');
  mkdirSync(join(ledger, 'progress'), { recursive: true });
  writeFileSync(join(ledger, 'request-groups.json'), JSON.stringify({ version: 1, updatedAt: null,
    groups: { [groupId]: { title: 'Release cards', anchor, projectRoot: 'repo' } }, conversations: { [anchor]: groupId }, ignored: {}, suggestions: {} }));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEVICE, CLAUDE_MEM_WORK_VIEW_SHARED_STATE: 'true' }));
  const store = new SessionStore(join(dir, 'claude-mem.db'));
  disposals.push(() => store.close());
  // As on any computer that has written once: the identity is pinned and the adapter's file-state table exists. The
  // CLI's opening then only reads, so the one lock a holder can block is the one the write itself takes.
  ensureLocalDeviceIdentity(store.db, settingsPath, DEVICE);
  new SharedLedgerAdapter(store.db, { directory: ledger, deviceId: DEVICE });
  const review = join(dir, 'review.json');
  writeFileSync(review, reviewJson);
  /** Another connection holding the write lock, as the worker or a parallel reviewer does while it commits. */
  const holdLock = () => {
    const holder = new Database(join(dir, 'claude-mem.db'));
    disposals.push(() => holder.close());
    holder.exec('BEGIN IMMEDIATE');
    return () => holder.exec('COMMIT');
  };
  const progressFile = join(ledger, progressName);
  const shared = () => readSharedRecords(store.db, { deviceId: DEVICE }).records;
  const sharedProgress = () => shared().get(sharedRecordKey('progress', groupId));
  const fileState = (name = progressName) => store.db.query('SELECT pending_json FROM my_work_file_state WHERE name = ?').get(name) as { pending_json: string | null } | null;
  return { dir, ledger, store, review, holdLock, progressFile, shared, sharedProgress, fileState };
}

function runCli(f: ReturnType<typeof fixture>, args: string[]) {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, resolve('src/services/work-view/request-groups-cli.mjs'), ...args], {
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: f.dir, CLAUDE_MEM_WORK_VIEW_SHARED_STATE: 'true' }, stdout: 'pipe', stderr: 'pipe',
  });
  let exited = false;
  const done = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    .then(([stdout, stderr, exitCode]) => { exited = true; return { stdout, stderr, exitCode, ms: performance.now() - started }; });
  return { done, exited: () => exited };
}

const recordProgress = (f: ReturnType<typeof fixture>, review = f.review) => runCli(f, ['record-progress', review]);

/** A named pipe for a run's input file: the run blocks reading it until the test writes it. */
function namedPipe(f: ReturnType<typeof fixture>, name: string) {
  const path = join(f.dir, name);
  const made = spawnSync('mkfifo', [path]);
  if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
  return path;
}

/**
 * Resolves with `pipe` open for writing once the run has opened it to read its input, so the run has done everything
 * that comes before that read. A run that exits first fails the test with its stderr instead of leaving the open waiting.
 */
async function runReadingInput(run: ReturnType<typeof runCli>, pipe: string) {
  const opened = open(pipe, 'w');
  const exitedFirst = await Promise.race([opened.then(() => null), run.done]);
  if (exitedFirst) {
    // Satisfy the pending open so it does not wait for a reader that will never come.
    await (await open(pipe, constants.O_RDONLY | constants.O_NONBLOCK)).close();
    await (await opened).close();
    throw new Error(`the run exited (${exitedFirst.exitCode}) before it read its input: ${exitedFirst.stderr}`);
  }
  return opened;
}

async function handInput(input: Awaited<ReturnType<typeof open>>, text: string) {
  await input.write(text);
  await input.close();
}

testWithNamedPipes('a locked database makes record-progress wait, and it saves both halves once the lock clears', async () => {
  const f = fixture();
  const pipe = namedPipe(f, 'review.pipe');
  const release = f.holdLock();
  const run = recordProgress(f, pipe);
  // The run has opened the database and read the ledger; what is left before its write lock is checking the review and
  // reading this fixture's one shared record.
  await handInput(await runReadingInput(run, pipe), reviewJson);
  // WAIT_MS: far longer than those steps (a whole unlocked record-progress, from its review arriving to its exit, took
  // 13 to 17 ms in 8 runs on the owner's Mac on 2026-11-27), and far shorter than the 5,000 ms the run waits for a lock
  // before it refuses, which it counts from its lock attempt, not from its start.
  const WAIT_MS = 1_500;
  await Bun.sleep(WAIT_MS);
  // Still waiting: nothing is saved while another writer holds the database.
  expect(run.exited()).toBe(false);
  expect(existsSync(f.progressFile)).toBe(false);
  expect(f.sharedProgress()).toBeUndefined();
  release();
  const result = await run.done;
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ recorded: groupId, state: 'in-progress', percent: 40, readings: 1 });
  expect(JSON.parse(readFileSync(f.progressFile, 'utf8'))).toMatchObject({ groupId, percent: 40 });
  expect(f.sharedProgress()?.value).toMatchObject({ groupId, percent: 40 });
  // The recovery intent is cleared: the file is recorded as written.
  expect(f.fileState()).toEqual({ pending_json: null });
}, 30_000);

test('a database still locked after the busy timeout fails record-progress with a clear message and writes neither half', async () => {
  const f = fixture();
  const release = f.holdLock();
  const result = await recordProgress(f).done;
  release();
  expect(result.exitCode).toBe(1);
  expect(result.ms).toBeGreaterThanOrEqual(SQLITE_BUSY_TIMEOUT_MS);
  expect(result.stderr).toBe(`Shared My Work: another writer held the claude-mem database for longer than ${SQLITE_BUSY_TIMEOUT_MS} ms (its busy_timeout), so ${progressName} was not saved: no shared record and no file were written. Run the command again.\n`);
  expect(result.stdout).toBe('');
  expect(existsSync(f.progressFile)).toBe(false);
  expect(f.sharedProgress()).toBeUndefined();
  expect(f.fileState()).toBeNull();
  // The same review saves once the database is free.
  const again = await recordProgress(f).done;
  expect(again.exitCode, again.stderr).toBe(0);
  expect(f.sharedProgress()?.value).toMatchObject({ percent: 40 });
}, 30_000);

test('a lock taken after the commit leaves the file pending for the reconciler, never a failed save', () => {
  const f = fixture();
  // A short wait keeps the test fast; the outcome does not depend on its length.
  f.store.db.exec('PRAGMA busy_timeout = 200');
  const adapter = new SharedLedgerAdapter(f.store.db, { directory: f.ledger, deviceId: DEVICE });
  const value = { groupId, state: 'in-progress', percent: 55, summary: 'Further along.' };
  const finish = adapter.beforeWrite(progressName, value)!;
  // The decision is durable before the file is written.
  expect(f.sharedProgress()?.value).toMatchObject({ percent: 55 });
  const release = f.holdLock();
  expect(finish()).toEqual({ materialization: 'pending', reason: 'another writer held the claude-mem database for longer than 200 ms' });
  release();
  // The file is written only under the lock, so nothing was renamed, and its temp file is gone.
  expect(readdirSync(join(f.ledger, 'progress'))).toEqual([]);
  expect(f.fileState()?.pending_json).not.toBeNull();
  // The reconciler writes it the way it finishes a write interrupted between the commit and the rename.
  adapter.reconcile({ captureActivity: false });
  expect(f.fileState()).toEqual({ pending_json: null });
  expect(JSON.parse(readFileSync(f.progressFile, 'utf8'))).toMatchObject({ percent: 55 });
});

testWithFilePermissions('record-progress whose file cannot be written after its commit exits 0 and says it is saved', async () => {
  const f = fixture();
  // The commit needs only the database. Writing the file needs a temp file in the progress folder, which refuses one.
  const progressFolder = join(f.ledger, 'progress');
  chmodSync(progressFolder, 0o555);
  disposals.push(() => chmodSync(progressFolder, 0o755));
  const result = await recordProgress(f).done;
  chmodSync(progressFolder, 0o755);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ recorded: groupId, percent: 40 });
  expect(result.stderr).toStartWith(`Saved ${progressName}; writing or recording the file is left for the claude-mem worker to finish (EACCES`);
  expect(result.stderr).toEndWith(').\nNothing needs to run again.\n');
  expect(f.sharedProgress()?.value).toMatchObject({ percent: 40 });
  expect(existsSync(f.progressFile)).toBe(false);
  expect(f.fileState()?.pending_json).not.toBeNull();
  // The worker's reconciler writes it; running record-progress again would have added a second reading.
  new SharedLedgerAdapter(f.store.db, { directory: f.ledger, deviceId: DEVICE }).reconcile({ captureActivity: false });
  expect(f.fileState()).toEqual({ pending_json: null });
  expect(JSON.parse(readFileSync(f.progressFile, 'utf8'))).toMatchObject({ percent: 40, readings: [{ percent: 40 }] });
}, 30_000);

testWithNamedPipes('apply refuses a decision built from request-groups.json before another writer replaced it, and writes nothing', async () => {
  const f = fixture();
  const groupsFile = join(f.ledger, 'request-groups.json');
  const key = (name: string) => JSON.stringify(['conversation', 'claude', name]);
  const decisions = JSON.stringify({ groups: [{ title: 'Request from the CLI', conversations: [key('cli')] }] });
  const pipe = namedPipe(f, 'decisions.pipe');
  const run = runCli(f, ['apply', pipe]);
  // apply reads the ledger before its decisions, so the run now holds request-groups.json as it was.
  const input = await runReadingInput(run, pipe);
  // Another writer (the worker saving the owner's Join, say) replaces the file through its own shared write meanwhile.
  const owner = JSON.parse(readFileSync(groupsFile, 'utf8'));
  owner.groups[groupIdFor(key('owner'))] = { title: "The owner's request", anchor: key('owner'), projectRoot: 'repo' };
  owner.conversations[key('owner')] = groupIdFor(key('owner'));
  expect(new SharedLedgerAdapter(f.store.db, { directory: f.ledger, deviceId: DEVICE }).saveFile('request-groups.json', owner)).toEqual({ materialization: 'complete' });
  const ownerFile = readFileSync(groupsFile, 'utf8');
  await handInput(input, decisions);
  const result = await run.done;
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe('Shared My Work: request-groups.json changed since this command read it (another writer saved a newer version), so this write was not saved: no shared record and no file were written. Run the command again.\n');
  expect(result.stdout).toBe('');
  // The owner's decision stands in the shared records and in the file; the stale one is in neither.
  expect(readFileSync(groupsFile, 'utf8')).toBe(ownerFile);
  expect((f.shared().get(sharedRecordKey('group', groupIdFor(key('owner'))))?.value as any)?.group?.title).toBe("The owner's request");
  expect(f.shared().has(sharedRecordKey('group', groupIdFor(key('cli'))))).toBe(false);
  // Run again, apply reads the newer file and saves on top of it.
  writeFileSync(join(f.dir, 'decisions.json'), decisions);
  const again = await runCli(f, ['apply', join(f.dir, 'decisions.json')]).done;
  expect(again.exitCode, again.stderr).toBe(0);
  expect(Object.keys(JSON.parse(readFileSync(groupsFile, 'utf8')).conversations).sort()).toEqual([anchor, key('cli'), key('owner')].sort());
  expect((f.shared().get(sharedRecordKey('group', groupIdFor(key('owner'))))?.value as any)?.group?.title).toBe("The owner's request");
}, 30_000);
