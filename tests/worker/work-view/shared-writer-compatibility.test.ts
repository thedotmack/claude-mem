import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';
import { readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';
import { resolvePythonCommand } from '../../../src/services/work-view/python.js';

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shared-writer-compat-'));
  disposals.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'work-view'); mkdirSync(ledger);
  const store = new SessionStore(join(directory, 'claude-mem.db'));
  disposals.push(() => store.close());
  const adapter = new SharedLedgerAdapter(store.db, { directory: ledger, deviceId: 'writer-device' });
  return { directory, ledger, store, adapter };
}
const read = (f: ReturnType<typeof fixture>) => readSharedRecords(f.store.db, { deviceId: 'writer-device' });
const storyRecord = (f: ReturnType<typeof fixture>) => read(f).records.get(sharedRecordKey('story', 'current'));

async function runOwnerGoals(f: ReturnType<typeof fixture>, shared: boolean) {
  writeFileSync(join(f.ledger, 'story.json'), JSON.stringify({ narrative: 'Original story', preferences: [] }));
  writeFileSync(join(f.directory, 'prompts.md'), '## 2026-11-01 10:00 · Owner\nPlease keep tests fast.\n');
  writeFileSync(join(f.directory, 'goals.json'), JSON.stringify({ generated_at: '2026-11-01T10:00:00Z', human_summary: 'Keep tests fast.', focus_areas: [], asks: [],
    rules: [{ then: 'Keep tests fast.', when: '', evidence: [{ at: '2026-11-01 10:00', quote: 'Please keep tests fast.' }] }] }));
  let sharedCalls = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/work-view') return Response.json({ goals: null, focusAreas: [], ...(shared ? { sharedPersistenceVersion: 1 } : {}) });
    const body = await request.json() as any;
    if (path === '/api/work-state/entries') {
      f.store.appendWorkStateEntry({ project: 'home', listName: body.list, fields: body.fields });
      return new Response('Saved to owner-goals in home.');
    }
    if (path === '/api/work-view/shared-ledger') {
      sharedCalls++;
      // The endpoint has committed the accepted update, but its caller never receives an acknowledgement.
      f.adapter.beforeWrite(body.file, body.value);
      await Bun.sleep(400);
      return Response.json({ saved: true });
    }
    return new Response('not found', { status: 404 });
  } });
  disposals.push(() => server.stop(true));
  const python = await resolvePythonCommand();
  // Keep this real HTTP timeout bounded without changing the production timeout.
  const driver = `import runpy,sys,urllib.request\noriginal=urllib.request.urlopen\nurllib.request.urlopen=lambda request,timeout=30: original(request,timeout=0.1)\nsys.argv=sys.argv[1:]\nrunpy.run_path(sys.argv[0],run_name='__main__')`;
  const child = Bun.spawn([python.command, ...python.args, '-c', driver,
    resolve('plugin/skills/owner-goals/scripts/save_goals.py'), '--goals', join(f.directory, 'goals.json'), '--prompts', join(f.directory, 'prompts.md')], {
    env: { ...process.env, PYTHONUTF8: '1', CLAUDE_MEM_DATA_DIR: f.directory, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(server.port) },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode, sharedCalls };
}

test('Python keeps an accepted shared write after ambiguous timeout and never falls back to raw file overwrite', async () => {
  const f = fixture(); const result = await runOwnerGoals(f, true);
  expect(result.exitCode).toBe(3);
  expect(result.sharedCalls).toBe(1);
  expect(result.stderr).toContain('timed out');
  expect(storyRecord(f)?.value).toMatchObject({ narrative: 'Original story', preferences: [{ source: 'owner-goals', preference: 'Keep tests fast.' }] });
  expect(JSON.parse(readFileSync(join(f.ledger, 'story.json'), 'utf8')).preferences).toEqual([]);
  expect(f.store.getWorkStateEntries(['home'])).toHaveLength(1);
  f.adapter.reconcile({ captureActivity: false });
  expect(JSON.parse(readFileSync(join(f.ledger, 'story.json'), 'utf8')).preferences).toHaveLength(1);
}, 10_000);

test('Python uses the legacy file path only when an old worker does not advertise shared persistence', async () => {
  const f = fixture(); const result = await runOwnerGoals(f, false);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.sharedCalls).toBe(0);
  expect(storyRecord(f)).toBeUndefined();
  expect(JSON.parse(readFileSync(join(f.ledger, 'story.json'), 'utf8')).preferences).toHaveLength(1);
  f.adapter.reconcile({ captureActivity: false });
  expect(storyRecord(f)?.value).toMatchObject({ preferences: [{ source: 'owner-goals' }] });
}, 10_000);

test('the offline CLI persists directly to the local database without requiring an HTTP worker', async () => {
  const f = fixture(); let httpCalls = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { httpCalls++; return new Response('offline', { status: 503 }); } });
  disposals.push(() => server.stop(true));
  const input = join(f.directory, 'story-input.json');
  writeFileSync(input, JSON.stringify({ narrative: 'Saved without the worker', preferences: [] }));
  const child = Bun.spawn([process.execPath, resolve('src/services/work-view/request-groups-cli.mjs'), 'record-story', input], {
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: f.directory, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(server.port), CLAUDE_MEM_WORK_VIEW_SHARED_STATE: 'true' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ recorded: 'story' });
  expect(httpCalls).toBe(0);
  const settings = JSON.parse(readFileSync(join(f.directory, 'settings.json'), 'utf8'));
  const deviceId = settings.env?.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID;
  expect(deviceId).toBeTruthy();
  expect(readSharedRecords(f.store.db, { deviceId }).records.get(sharedRecordKey('story', 'current'))?.value).toMatchObject({ narrative: 'Saved without the worker' });
  expect(f.store.getWorkStateEntries(['__my_work__'])).toEqual([]);
}, 10_000);

test('a disabled CLI preserves legacy file writes without authoring shared records or metadata', async () => {
  const f = fixture();
  const input = join(f.directory, 'story-input.json');
  writeFileSync(input, JSON.stringify({ narrative: 'Legacy file only', preferences: [] }));
  const child = Bun.spawn([process.execPath, resolve('src/services/work-view/request-groups-cli.mjs'), 'record-story', input], {
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: f.directory, CLAUDE_MEM_WORK_VIEW_SHARED_STATE: 'false' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ recorded: 'story' });
  expect(JSON.parse(readFileSync(join(f.ledger, 'story.json'), 'utf8'))).toMatchObject({ narrative: 'Legacy file only' });
  expect(read(f).records.size).toBe(0);
  expect(f.store.db.query('SELECT * FROM my_work_file_state').all()).toEqual([]);
  expect(f.store.db.query("SELECT name FROM sqlite_master WHERE name='local_work_view_identity'").all()).toEqual([]);
}, 10_000);
