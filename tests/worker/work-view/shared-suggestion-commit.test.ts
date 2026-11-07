import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SharedWorkSync } from '../../../src/services/work-view/SharedWorkSync.js';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';
import { getSharedReviews, sharedSuggestionDescriptor } from '../../../src/services/work-view/shared-reviews.mjs';
import { groupIdFor } from '../../../src/services/work-view/request-groups.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';

const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const conversation = (name: string) => JSON.stringify(['conversation', 'claude', name]);
const target = conversation('target'), candidate = conversation('candidate');
const targetId = groupIdFor(target), ownId = groupIdFor(candidate);

function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'suggestion-commit-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'work'); fs.mkdirSync(ledger);
  const databasePath = join(directory, 'memory.db');
  const store = new SessionStore(databasePath); store.setLocalSyncDeviceId('origin'); cleanup.push(() => store.close());
  const notifications: unknown[] = [];
  const sync = new SharedWorkSync(store.db, { databasePath, directory: ledger, deviceId: 'origin', enabled: true,
    notify() { notifications.push(store.db.inTransaction); } });
  cleanup.push(() => sync.close());
  sync.saveFile('request-groups.json', { version: 1, updatedAt: null,
    groups: { [targetId]: { title: 'Target', anchor: target }, [ownId]: { title: 'Candidate', anchor: candidate } },
    conversations: { [target]: targetId, [candidate]: ownId }, ignored: {},
    suggestions: { [candidate]: { requestId: targetId, confidence: .8, evidence: 'Related work', status: 'open' } } });
  notifications.length = 0;
  const state = () => getSharedReviews(store.db, 'origin');
  const token = () => sharedSuggestionDescriptor(state(), candidate).hash;
  const count = () => (store.db.query('SELECT COUNT(*) AS n FROM work_state_entries').get() as { n: number }).n;
  const file = join(ledger, 'request-groups.json');
  return { store, sync, state, token, count, file, ledger, notifications };
}

test('outer deferred commit failure leaves canonical state, compatibility file and notifications unchanged', () => {
  const f = fixture(), before = f.count(), bytes = fs.readFileSync(f.file, 'utf8'), token = f.token();
  f.store.db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE commit_child(parent_id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_shared_commit AFTER INSERT ON work_state_entries
      WHEN NEW.list_name GLOB '__my_work_v1:*'
      BEGIN INSERT INTO commit_child(parent_id) VALUES(999); END;`);
  expect(() => f.sync.answerSuggestion(candidate, 'not-this', token)).toThrow('FOREIGN KEY constraint failed');
  expect(f.store.db.inTransaction).toBe(false);
  expect(f.count()).toBe(before);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
  expect(f.token()).toBe(token);
  expect(f.notifications).toEqual([]);
  expect((f.store.db.query('SELECT COUNT(*) AS n FROM commit_child').get() as { n: number }).n).toBe(0);
  expect((f.store.db.query("SELECT pending_json FROM my_work_file_state WHERE name='request-groups.json'").get() as any).pending_json).toBeNull();
  f.store.db.exec('DROP TRIGGER fail_shared_commit');
  const restarted = new SharedLedgerAdapter(f.store.db, { directory: f.ledger, deviceId: 'origin' });
  restarted.reconcile({ captureActivity: false });
  expect(f.count()).toBe(before);
  expect(f.token()).toBe(token);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
});

test('post-commit file failure preserves durable decision and pending intent without reimporting it', () => {
  const f = fixture(), before = f.count(), bytes = fs.readFileSync(f.file, 'utf8');
  const rename = fs.renameSync;
  const brokenRename = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === f.file) throw new Error('Synthetic local materialization failure');
    return rename(from, to);
  });
  let outcome: unknown;
  try { outcome = f.sync.answerSuggestion(candidate, 'not-this', f.token()); }
  finally { brokenRename.mockRestore(); }
  expect(outcome).toMatchObject({ status: 'declined', materialization: 'pending' });
  expect(f.count()).toBeGreaterThan(before);
  expect(f.notifications).toEqual([false]);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
  const accepted = f.state().records.get(sharedRecordKey('group', targetId))!;
  expect((accepted.value as any).suggestions[candidate].status).toBe('declined');
  expect((f.store.db.query("SELECT pending_json FROM my_work_file_state WHERE name='request-groups.json'").get() as any).pending_json).toContain('declined');
  const committedCount = f.count();
  const restarted = new SharedLedgerAdapter(f.store.db, { directory: f.ledger, deviceId: 'origin' });
  restarted.reconcile({ captureActivity: false });
  expect(f.count()).toBe(committedCount);
  expect(f.state().records.get(sharedRecordKey('group', targetId))!.hash).toBe(accepted.hash);
  expect(fs.readFileSync(f.file, 'utf8')).toContain('declined');
  expect((f.store.db.query("SELECT pending_json FROM my_work_file_state WHERE name='request-groups.json'").get() as any).pending_json).toBeNull();
});
