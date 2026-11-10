import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureLocalDeviceIdentity } from '../../../src/services/sync/local-device-identity.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { publishSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'local-device-identity-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'state.db'));
  db.exec('PRAGMA busy_timeout=5000');
  cleanup.push(() => db.close());
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{}');
  return { dir, db, path };
}

test('pins one durable identity and restores the same settings key before enabling cloud', () => {
  const { db, path } = fixture();
  const id = ensureLocalDeviceIdentity(db, path);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(readFileSync(path, 'utf8')).CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID).toBe(id);
  writeFileSync(path, '{}');
  expect(ensureLocalDeviceIdentity(db, path)).toBe(id);
  expect(JSON.parse(readFileSync(path, 'utf8')).CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID).toBe(id);
});

test('adopts configured or legacy native identity, preserving wrapped settings', () => {
  const configured = fixture();
  writeFileSync(configured.path, JSON.stringify({ theme: 'dark', env: { CLAUDE_MEM_MODEL: 'model' } }));
  expect(ensureLocalDeviceIdentity(configured.db, configured.path, 'configured-device')).toBe('configured-device');
  expect(JSON.parse(readFileSync(configured.path, 'utf8'))).toMatchObject({ theme: 'dark', env: { CLAUDE_MEM_MODEL: 'model', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'configured-device' } });
  const native = fixture();
  new SessionStore(native.db);
  publishSharedRecords(native.db, { deviceId: 'native-device', project: 'repo', updates: [{ kind: 'group', key: 'g', value: 'retained' }] });
  expect(ensureLocalDeviceIdentity(native.db, native.path)).toBe('native-device');
});

test('refuses a real identity conflict without rotating either stored identity', () => {
  const { db, path } = fixture();
  ensureLocalDeviceIdentity(db, path, 'original-device');
  const before = readFileSync(path, 'utf8');
  expect(() => ensureLocalDeviceIdentity(db, path, 'other-device')).toThrow('conflicts');
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(db.query('SELECT device_id FROM local_work_view_identity').get()).toEqual({ device_id: 'original-device' });
});

test('does not establish an identity when settings cannot be persisted', () => {
  const { db, dir } = fixture();
  expect(() => ensureLocalDeviceIdentity(db, dir, 'device-a')).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name='local_work_view_identity'").get()).toBeNull();
});

test('concurrent pre-sync processes acquire one identity through the database lock', async () => {
  const { db, dir, path } = fixture();
  const moduleUrl = new URL('../../../src/services/sync/local-device-identity.ts', import.meta.url).href;
  const start = join(dir, 'start');
  const ready = [join(dir, 'ready-0'), join(dir, 'ready-1')];
  const children = ready.map(pathname => Bun.spawn([process.execPath, '--eval', `
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { ensureLocalDeviceIdentity } from ${JSON.stringify(moduleUrl)};
const db = new Database(${JSON.stringify(join(dir, 'state.db'))});
db.exec('PRAGMA busy_timeout=5000');
writeFileSync(${JSON.stringify(pathname)}, '');
while (!existsSync(${JSON.stringify(start)})) await Bun.sleep(1);
try { console.log('IDENTITY=' + ensureLocalDeviceIdentity(db, ${JSON.stringify(path)})); } finally { db.close(); }
`], { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, CLAUDE_MEM_DATA_DIR: dir } }));
  try {
    const deadline = Date.now() + 4_000;
    while (!ready.every(pathname => existsSync(pathname))) {
      if (Date.now() > deadline) throw new Error('identity processes did not reach the start barrier');
      await Bun.sleep(5);
    }
    writeFileSync(start, '');
    const ids = await Promise.all(children.map(async child => {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr).toBe(0);
      const id = /IDENTITY=([^\n]+)/.exec(stdout)?.[1];
      expect(id).toBeTruthy();
      return id;
    }));
    expect(ids[0]).toBe(ids[1]);
    expect(ensureLocalDeviceIdentity(db, path)).toBe(ids[0]);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(children.map(child => child.exited));
  }
});
