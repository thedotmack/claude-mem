import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';
import { registerSharedFileWriter } from '../../../src/services/work-view/shared-file-hooks.mjs';
import { writeJsonAtomic } from '../../../src/services/work-view/request-groups.mjs';
import { HumanCopyWorker } from '../../../src/services/work-view/human-copy-worker.mjs';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache } from '../../../src/utils/redaction.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); _resetRedactionConfigCache(); });
const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const marker = "<redacted type='aws_access_key'/>";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shared-local-redaction-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore(join(directory, 'memory.db'));
  cleanup.push(() => store.close());
  const ledger = join(directory, 'work-view'); mkdirSync(ledger);
  const spy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_REDACT_ENABLED: 'true',
  }));
  cleanup.push(() => spy.mockRestore()); _resetRedactionConfigCache();
  const adapter = new SharedLedgerAdapter(store.db, { directory: ledger, deviceId: 'device-a' });
  return { directory, store, ledger, adapter };
}

test('configured redaction covers pending materialization, recovery and the registered writer target', () => {
  const f = fixture();
  f.adapter.beforeWrite('story.json', { narrative: `Pending ${secret}`, preferences: [] });
  const pending = JSON.stringify(f.store.db.query('SELECT * FROM my_work_file_state').all());
  const records = JSON.stringify(f.store.db.query('SELECT fields FROM work_state_entries').all());
  expect(pending).not.toContain(secret); expect(records).not.toContain(secret);
  expect(pending).toContain(marker);
  new SharedLedgerAdapter(f.store.db, { directory: f.ledger, deviceId: 'device-a' }).reconcile({ captureActivity: false });
  expect(readFileSync(join(f.ledger, 'story.json'), 'utf8')).not.toContain(secret);
  cleanup.push(registerSharedFileWriter(f.ledger, (name, value) => f.adapter.beforeWrite(name, value)));
  writeJsonAtomic(join(f.ledger, 'story.json'), { narrative: `Next ${secret}`, preferences: [] });
  const written = readFileSync(join(f.ledger, 'story.json'), 'utf8');
  expect(written).toContain(marker); expect(written).not.toContain(secret);
  const before = f.store.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get();
  f.adapter.reconcile({ captureActivity: false });
  expect(f.store.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual(before);
});

test('generated copy is redacted before shared persistence and local cache acceptance', async () => {
  const f = fixture(), cachePath = join(f.ledger, 'human-copy.json');
  let persisted: unknown;
  const worker = new HumanCopyWorker({ cachePath, quietMs: 0, minIntervalMs: 0, warn() {},
    provider: async () => ({ output: { title: `Viewer ${secret}`, summary: 'A clear viewer.', next: '', workstreams: [] } }),
    persistSharedCopy: (_id, entry) => { persisted = entry; },
  });
  cleanup.push(() => worker.close());
  worker.observe({ humanRequests: [{ id: 'request', original: { text: 'Build a clear viewer' }, scopeUpdates: [], workstreams: [] }] });
  for (let i = 0; i < 100 && !existsSync(cachePath); i++) await Bun.sleep(5);
  expect(worker.status().cached).toBe(1);
  expect(JSON.stringify(persisted)).toContain(marker);
  expect(JSON.stringify(persisted)).not.toContain(secret);
  const written = readFileSync(cachePath, 'utf8');
  expect(written).toContain(marker); expect(written).not.toContain(secret);
});
