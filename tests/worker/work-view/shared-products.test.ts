import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { upsertToolUse } from '../../../src/services/sqlite/tool-uses.js';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { buildAgentView, readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';
import { groupIdFor } from '../../../src/services/work-view/request-groups.mjs';
import { conversationKey } from '../../../src/services/work-view/request-projection.mjs';
import { reduceWorkState } from '../../../src/services/work-view/work-state-reduce.mjs';
import { recordedFile } from '../../../src/services/work-view/work-product.mjs';
import { publishSharedRecords, readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { applySharedProjection, buildSharedProjectionUpdates, decorateSharedView, isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const NOW = Date.now();
function store() {
  const result = new SessionStore(new Database(':memory:'));
  cleanups.push(() => result.db.close());
  return result;
}
function state(db: Database, deviceId: string) {
  return reduceWorkState(db.query('SELECT * FROM work_state_entries').all().map((row: any) => ({ ...row, fields: JSON.parse(row.fields) })), { currentProject: 'repo', localDeviceId: deviceId });
}
function transferShared(origin: SessionStore, replica: SessionStore) {
  const rows = origin.db.query("SELECT * FROM work_state_entries WHERE list_name LIKE '__my_work_v1:%' ORDER BY id").all() as any[];
  const apply = new SyncApply(replica.db, { deviceId: 'b' });
  apply.applyOps(decodeChanges(rows.map((row, index) => ({ seq: String(index + 1), ...buildContentOperation({
    kind: 'work_state', originDeviceId: 'a', originLocalId: String(row.id), entityRev: row.sync_rev,
    payload: { project: row.project, list_name: row.list_name, fields: JSON.parse(row.fields), created_at: row.created_at, created_at_epoch: String(row.created_at_epoch) },
  }) }))), { epoch: '1' });
}

test('public links and origin-only file declarations survive canonical replication without raw tool records or paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-products-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const localPath = join(dir, 'private-origin-report.pdf');
  writeFileSync(localPath, 'synthetic report');
  const origin = store(), replica = store();
  const sessionId = origin.createSDKSession('product-session', 'repo', 'Create a launch report', undefined, 'claude');
  origin.updateMemorySessionId(sessionId, 'product-memory');
  origin.saveUserPrompt('product-session', 1, 'Create a launch report', sessionId);
  origin.storeObservation('product-memory', 'repo', {
    type: 'discovery', title: 'Created launch report', subtitle: null, narrative: 'A report was created.',
    facts: [], concepts: [], files_read: [], files_modified: [localPath],
  }, 1, 0);
  upsertToolUse(origin.db, { toolUseId: 'public-link', contentSessionId: 'product-session', sessionDbId: sessionId,
    memorySessionId: 'product-memory', project: 'repo', platformSource: 'claude', toolName: 'Artifact',
    toolInput: JSON.stringify({ title: 'Published report' }), toolResponse: JSON.stringify({ url: 'https://example.com/report' }), createdAtEpoch: NOW });
  upsertToolUse(origin.db, { toolUseId: 'public-pr', contentSessionId: 'product-session', sessionDbId: sessionId,
    memorySessionId: 'product-memory', project: 'repo', platformSource: 'claude', toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'gh pr create --title "Launch PR"' }),
    toolResponse: JSON.stringify({ stdout: 'https://github.com/example/repo/pull/12' }), createdAtEpoch: NOW });
  const originState = state(origin.db, 'a');
  const records = readAgentRecords(origin.db, { workState: originState, now: NOW });
  const key = conversationKey(records.sessions.find((session: any) => session.id === sessionId));
  const id = groupIdFor(key);
  const ledger = { groups: { groups: { [id]: { title: 'Launch report', anchor: key, projectRoot: 'repo' } }, conversations: { [key]: id } } };
  const view = buildAgentView(originState, records, { ledger, now: NOW });
  const updates = buildSharedProjectionUpdates(origin.db, { ledger, records, view, deviceId: 'a' });
  const products = updates.find(update => update.kind === 'provenance')!.value.products;
  expect(products).toEqual(expect.arrayContaining([
    expect.objectContaining({ url: 'https://example.com/report' }),
    expect.objectContaining({ url: 'https://github.com/example/repo/pull/12' }),
    expect.objectContaining({ title: 'private-origin-report.pdf', availability: 'origin-only', originDeviceId: 'a' }),
  ]));
  expect(JSON.stringify(updates)).not.toContain(dir);
  expect(products.every((product: any) => product.availability !== 'origin-only' || product.url === undefined)).toBe(true);
  publishSharedRecords(origin.db, { deviceId: 'a', project: 'repo', updates, validateValue: isSharedProjectionValue });
  transferShared(origin, replica);

  const read = (target: SessionStore, deviceId: string) => {
    const current = state(target.db, deviceId);
    const raw = readAgentRecords(target.db, { workState: current, now: NOW });
    const shared = applySharedProjection(target.db, readSharedRecords(target.db, { deviceId, validateValue: isSharedProjectionValue }), { records: raw, deviceId });
    return decorateSharedView(buildAgentView(current, shared.records, { ledger: shared.ledger, now: NOW }), { database: target.db, deviceId }).humanRequests[0];
  };
  const local = read(origin, 'a'), remote = read(replica, 'b');
  expect(local.workProduct.filter((product: any) => product.title === 'private-origin-report.pdf')).toHaveLength(1);
  expect(local.workProduct.find((product: any) => product.title === 'private-origin-report.pdf')).toMatchObject({ available: true });
  expect(remote.workProduct.find((product: any) => product.title === 'private-origin-report.pdf')).toMatchObject({ availability: 'origin-only', available: false });
  expect(remote.workProduct.find((product: any) => product.title === 'private-origin-report.pdf').url).toBeUndefined();
  expect(remote.workProduct.find((product: any) => product.title === 'private-origin-report.pdf').fileUrl).toBeUndefined();
  expect(remote.workProduct.some((product: any) => product.url === 'https://example.com/report')).toBe(true);
  expect(remote.workProduct.some((product: any) => product.url === 'https://github.com/example/repo/pull/12')).toBe(true);
  expect(replica.db.query('SELECT COUNT(*) AS n FROM tool_uses').get()).toEqual({ n: 0 });
});

test('an imported file path never opens another computer\'s coincidentally matching file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-product-path-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'same-path.pdf');
  writeFileSync(path, 'file exists on this test computer');
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, files_modified TEXT, created_at_epoch INTEGER, origin_device_id TEXT, origin_local_id TEXT)');
  db.query('INSERT INTO observations VALUES (1, ?, ?, ?, ?)').run(JSON.stringify([path]), NOW, 'a', '17');
  const read = (sql: string, params: any[]) => db.query(sql).all(...params);
  expect(recordedFile(read, 'observation', 1, 0, 'b')).toBeNull();
  expect(recordedFile(read, 'observation', 1, 0)).toBeNull();
  expect(recordedFile(read, 'observation', 1, 0, 'a')).toBe(path);
  const unknownViewer = decorateSharedView({ humanRequests: [{ workProduct: [{ kind: 'document', title: 'same-path.pdf', path, fileUrl: '/api/work-view/file/observation/1/0', sourceRef: { kind: 'observation', id: 1, index: 0 } }] }] }, { database: db });
  expect(unknownViewer.humanRequests[0].workProduct[0]).toMatchObject({ availability: 'origin-only', available: false });
  expect(JSON.stringify(unknownViewer)).not.toContain(path);
  expect(JSON.stringify(unknownViewer)).not.toContain('/api/work-view/file/');
  db.query('UPDATE observations SET origin_device_id = NULL').run();
  expect(recordedFile(read, 'observation', 1, 0, 'b')).toBe(path);
});

test('origin-only declarations cannot claim another writer or carry a download URL', () => {
  const key = JSON.stringify(['conversation', 'claude', 'x']);
  const base = { session: { platform_source: 'claude', content_session_id: 'x' }, attributions: [], launches: [], activity: [] };
  const product = { kind: 'document', title: 'report.pdf', productId: `local_${'a'.repeat(64)}`, originDeviceId: 'a', availability: 'origin-only' };
  expect(isSharedProjectionValue('provenance', key, { ...base, products: [product] }, false, 'a')).toBe(true);
  expect(isSharedProjectionValue('provenance', key, { ...base, products: [product] }, false, 'b')).toBe(false);
  expect(isSharedProjectionValue('provenance', key, { ...base, products: [{ ...product, url: 'https://example.com/file' }] }, false, 'a')).toBe(false);
  expect(isSharedProjectionValue('provenance', key, { ...base, products: [{ ...product, path: '/private/file' }] }, false, 'a')).toBe(false);
});

test('git product identities survive capture and canonical replication without raw tools', () => {
  const origin = store(), replica = store();
  const sessionId = origin.createSDKSession('git-product-session', 'repo', 'Publish this change', undefined, 'claude');
  origin.updateMemorySessionId(sessionId, 'git-product-memory');
  origin.saveUserPrompt('git-product-session', 1, 'Publish this change', sessionId);
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  upsertToolUse(origin.db, { toolUseId: 'git-product', contentSessionId: 'git-product-session', sessionDbId: sessionId,
    memorySessionId: 'git-product-memory', project: 'repo', platformSource: 'claude', toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'git commit -m "Publish change" && git push https://github.com/example/repo.git main' }),
    toolResponse: JSON.stringify({ stdout: `[main ${sha}] Publish change\nTo https://github.com/example/repo.git\n  1111111..${sha} main -> main` }), createdAtEpoch: NOW });
  const current = state(origin.db, 'a'), records = readAgentRecords(origin.db, { workState: current, now: NOW });
  const key = conversationKey(records.sessions.find((session: any) => session.id === sessionId)), id = groupIdFor(key);
  const ledger = { groups: { groups: { [id]: { title: 'Publish change', anchor: key, projectRoot: 'repo' } }, conversations: { [key]: id } } };
  const view = buildAgentView(current, records, { ledger, now: NOW });
  const updates = buildSharedProjectionUpdates(origin.db, { ledger, records, view, deviceId: 'a' });
  const products = updates.find(update => update.kind === 'provenance')!.value.products;
  expect(products).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'commit', sha, branch: 'main', repo: 'example/repo' }),
    expect.objectContaining({ kind: 'branch', branch: 'main', repo: 'example/repo', heads: [sha] }),
  ]));
  publishSharedRecords(origin.db, { deviceId: 'a', project: 'repo', updates, validateValue: isSharedProjectionValue }); transferShared(origin, replica);
  const imported = [...readSharedRecords(replica.db, { deviceId: 'b', validateValue: isSharedProjectionValue }).records.values()].find(record => record.kind === 'provenance')!.value as any;
  expect(imported.products).toEqual(products);
  expect(replica.db.query('SELECT count(*) AS n FROM tool_uses').get()).toEqual({ n: 0 });
  for (const invalid of [{ sha: 'not-a-sha' }, { branch: '../private' }, { repo: '/private/repo' }, { heads: Array.from({ length: 101 }, () => sha) }]) {
    expect(isSharedProjectionValue('provenance', key, { ...imported, products: [{ ...products[0], ...invalid }] }, false, 'a')).toBe(false);
  }
});
