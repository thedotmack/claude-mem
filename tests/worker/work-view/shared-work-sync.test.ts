import { afterEach, expect, test } from 'bun:test';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SharedWorkSync } from '../../../src/services/work-view/SharedWorkSync.js';
import { readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { groupIdFor, writeJsonAtomic } from '../../../src/services/work-view/request-groups.mjs';
import { getSharedReviews, sharedSuggestionDescriptor } from '../../../src/services/work-view/shared-reviews.mjs';
import { publishSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shared-work-runtime-'));
  disposals.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'claude-mem.db'), ledger = join(directory, 'work-view');
  const store = new SessionStore(databasePath); mkdirSync(ledger);
  disposals.push(() => store.close());
  const conversation = JSON.stringify(['conversation', 'claude', 'source-session']);
  const group = { version: 1, updatedAt: null, groups: { [groupIdFor(conversation)]: { title: 'Shared runtime', anchor: conversation } },
    conversations: { [conversation]: groupIdFor(conversation) }, ignored: {}, suggestions: {} };
  const options = { databasePath, directory: ledger, deviceId: 'runtime-device', notify() {}, intervalMs: 60_000, enabled: true };
  return { directory, databasePath, ledger, store, group, options };
}
function createSync(f: ReturnType<typeof fixture>) {
  const sync = new SharedWorkSync(f.store.db, f.options); disposals.push(() => sync.close()); return sync;
}

test('disabled runtime leaves legacy file writers active and does not capture shared rows', async () => {
  const f = fixture();
  const sync = new SharedWorkSync(f.store.db, { ...f.options, enabled: false });
  disposals.push(() => sync.close());
  sync.start();
  writeJsonAtomic(join(f.ledger, 'request-groups.json'), f.group);
  await sync.reconcile();
  expect(readSharedRecords(f.store.db, { deviceId: f.options.deviceId }).records.size).toBe(0);
  expect((f.store.db.query('SELECT COUNT(*) AS count FROM work_state_entries').get() as any).count).toBe(0);
  expect(f.store.db.query("SELECT name FROM sqlite_master WHERE name='my_work_file_state'").all()).toEqual([]);
});

test('suggestion decisions settle delayed materialization and reject stale canonical group bases', async () => {
  const f = fixture(), sync = createSync(f);
  const a = Object.keys(f.group.groups)[0], c = JSON.stringify(['conversation', 'claude', 'candidate']), own = groupIdFor(c);
  const groups: any = structuredClone(f.group);
  groups.groups[own] = { title: 'Candidate', anchor: c };
  groups.conversations[c] = own;
  groups.suggestions[c] = { requestId: a, confidence: .7, evidence: 'Earlier evidence', status: 'open' };
  sync.saveFile('request-groups.json', groups);
  const oldHash = sharedSuggestionDescriptor(getSharedReviews(f.store.db, f.options.deviceId), c).hash;
  const record = [...getSharedReviews(f.store.db, f.options.deviceId).records.values()].find(record => record.kind === 'group' && record.key === a)!;
  const newer: any = structuredClone(record.value); newer.suggestions[c].evidence = 'New canonical evidence';
  publishSharedRecords(f.store.db, { deviceId: f.options.deviceId, project: '__my_work__', validateValue: isSharedProjectionValue,
    updates: [{ kind: 'group', key: a, value: newer, expectedHash: record.hash }] });
  expect(readFileSync(join(f.ledger, 'request-groups.json'), 'utf8')).toContain('Earlier evidence');
  await sync.prepareOwnerAction();
  expect(readFileSync(join(f.ledger, 'request-groups.json'), 'utf8')).toContain('New canonical evidence');
  expect(() => sync.answerSuggestion(c, 'not-this', oldHash)).toThrow('changed since read');
  const fresh = sharedSuggestionDescriptor(getSharedReviews(f.store.db, f.options.deviceId), c).hash;
  expect(sync.answerSuggestion(c, 'not-this', fresh)).toMatchObject({ status: 'declined' });
  expect(() => sync.answerSuggestion(c, 'join', fresh)).toThrow('changed since read');
});

test('runtime imports through the actual background worker and unregisters the direct writer at close', async () => {
  const f = fixture(), sync = createSync(f);
  writeFileSync(join(f.ledger, 'request-groups.json'), JSON.stringify(f.group));
  sync.start(); await sync.reconcile();
  expect(readSharedRecords(f.store.db, { deviceId: f.options.deviceId }).records.size).toBe(1);
  expect(sync.status()).toMatchObject({ invalid: 0, files: [] });
  const before = (f.store.db.query('SELECT COUNT(*) AS count FROM work_state_entries').get() as any).count;
  await sync.reconcile();
  expect((f.store.db.query('SELECT COUNT(*) AS count FROM work_state_entries').get() as any).count).toBe(before);
  sync.close();
  writeJsonAtomic(join(f.ledger, 'story.json'), { narrative: 'After close', preferences: [] });
  expect((f.store.db.query('SELECT COUNT(*) AS count FROM work_state_entries').get() as any).count).toBe(before);
  const restarted = createSync(f); restarted.start(); await restarted.reconcile();
  expect(readSharedRecords(f.store.db, { deviceId: f.options.deviceId }).records.size).toBe(2);
}, 15_000);

test('close settles an in-flight locked pass, releases registration, and rejects no pending callers', async () => {
  const f = fixture(), sync = createSync(f); sync.start(); await sync.reconcile();
  f.store.db.exec('BEGIN IMMEDIATE');
  try {
    writeFileSync(join(f.ledger, 'request-groups.json'), JSON.stringify(f.group));
    const first = sync.reconcile(), duplicate = sync.reconcile();
    expect(first).toBe(duplicate);
    await Bun.sleep(40);
    sync.close();
    await Promise.race([first, Bun.sleep(500).then(() => { throw new Error('close did not settle pending reconciliation'); })]);
  } finally { f.store.db.exec('ROLLBACK'); }
  expect(() => createSync(f).start()).not.toThrow();
}, 15_000);

const banner = 'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;';
const bundle = (entry: string, outfile: string) => build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', target: 'node18', format: 'cjs',
  external: ['bun:sqlite'], define: { 'import.meta.url': '__IMPORT_META_URL__' }, banner: { js: banner }, logLevel: 'silent' });
function writeRuntimeEntry(f: ReturnType<typeof fixture>) {
  const entry = join(f.directory, 'fixture.ts');
  writeFileSync(entry, `import { Database } from 'bun:sqlite';
import { SharedWorkSync } from ${JSON.stringify(resolve('src/services/work-view/SharedWorkSync.ts'))};
import { readSharedRecords } from ${JSON.stringify(resolve('src/services/work-view/shared-record-store.mjs'))};
const db = new Database(process.argv[2]);
const sync = new SharedWorkSync(db, { databasePath: process.argv[2], directory: process.argv[3], deviceId: 'runtime-device', notify() {}, enabled: true });
sync.reconcile().then(() => { console.log(JSON.stringify({ size: readSharedRecords(db, { deviceId: 'runtime-device' }).records.size, status: sync.status() })); sync.close(); db.close(); });
`);
  return entry;
}
async function assertPackagedRun(f: ReturnType<typeof fixture>, command: string[]) {
  const child = Bun.spawn([...command, f.databasePath, f.ledger], { cwd: f.directory, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Shared runtime exited ${code}: ${stderr}\n${stdout}`);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ size: 1, status: { invalid: 0, files: [] } });
}

test('the packaged runtime uses the packaged shared worker from an empty working directory', async () => {
  const f = fixture();
  writeFileSync(join(f.ledger, 'request-groups.json'), JSON.stringify(f.group));
  const entry = writeRuntimeEntry(f), outfile = join(f.directory, 'fixture.cjs');
  await bundle(entry, outfile);
  await bundle(resolve('src/services/work-view/work-view-read-worker.ts'), join(f.directory, 'work-view-read-worker.cjs'));
  await assertPackagedRun(f, [process.execPath, outfile]);
  expect(readFileSync(join(f.ledger, 'request-groups.json'), 'utf8')).toContain('Shared runtime');
}, 30_000);

test('the standalone runtime finds its embedded shared worker with no adjacent source files', async () => {
  const f = fixture();
  writeFileSync(join(f.ledger, 'request-groups.json'), JSON.stringify(f.group));
  const entry = writeRuntimeEntry(f), outfile = join(f.directory, 'shared-runtime');
  const compiled = Bun.spawnSync([process.execPath, 'build', '--compile', '--entry-naming', '[name].js', entry,
    resolve('src/services/work-view/work-view-read-worker.ts'), '--outfile', outfile], { cwd: process.cwd(), env: process.env });
  expect(compiled.exitCode, new TextDecoder().decode(compiled.stderr)).toBe(0);
  // Bun 1.4 currently leaves invalid signatures on generated macOS arm64 fixtures.
  // Sign only this disposable test executable so Gatekeeper can launch it.
  if (process.platform === 'darwin') {
    const signed = Bun.spawnSync(['codesign', '--force', '--sign', '-', outfile]);
    expect(signed.exitCode, new TextDecoder().decode(signed.stderr)).toBe(0);
  }
  rmSync(entry);
  await assertPackagedRun(f, [outfile]);
}, 60_000);
