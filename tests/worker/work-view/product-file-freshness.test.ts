import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { recordDeliverable } from '../../../src/services/sqlite/deliverables.js';
import { WorkStateSource } from '../../../src/services/work-view/data-source.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
let directory: string;
let store: SessionStore;
let source: WorkStateSource;
let original: string;
let copy: string;

beforeEach(() => {
  setSystemTime(NOW);
  directory = mkdtempSync(join(tmpdir(), 'work-product-freshness-'));
  const databasePath = join(directory, 'memory.db');
  original = join(directory, 'report.html');
  copy = join(directory, 'report-copy.html');
  writeFileSync(original, '<h1>Original report</h1>');
  utimesSync(original, new Date(NOW - 60_000), new Date(NOW - 60_000));
  store = new SessionStore(databasePath);
  const session = store.createSDKSession('report-session', 'repo', 'Create the report', undefined, 'claude');
  store.updateMemorySessionId(session, 'report-memory');
  store.saveUserPrompt('report-session', 1, 'Create the report', session);
  store.storeObservation('report-memory', 'repo', {
    type: 'change', title: 'Created the report', subtitle: null, narrative: 'The report is ready.',
    facts: [], concepts: [], files_read: [], files_modified: [original],
  }, 1, 0, NOW);
  source = new WorkStateSource({ databasePath, currentProject: 'repo' });
});

afterEach(() => {
  source.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  setSystemTime();
});

function read(options = {}) {
  const snapshot = source.read(options).agentView;
  expect(snapshot.source.connected).toBe(true);
  expect(snapshot.humanRequests).toHaveLength(1);
  return snapshot;
}

function addCopy() {
  writeFileSync(copy, '<h1>Original report</h1>');
  recordDeliverable(store.db, {
    project: 'repo', contentSessionId: 'report-session', platformSource: 'claude',
    title: 'Saved report', kind: 'page', sourcePath: original, bucketPath: copy,
    bytes: 24, sha256: 'fixture', declared: true, occurredAtEpoch: NOW, createdAtEpoch: NOW,
  });
}

test('ordinary reads update file availability after deletion and recreation without a database commit', () => {
  const first = read();
  expect(first.humanRequests[0].workProduct[0].available).toBe(true);
  const version = source.openDatabase().prepare('PRAGMA data_version').get();
  rmSync(original);
  expect(source.file('observation', 1, 0)).toBeNull();
  const deleted = read();
  expect(deleted.humanRequests[0].workProduct[0].available).toBe(false);
  expect(deleted.revision).toBe(first.revision + 1);
  writeFileSync(original, '<h1>Restored report</h1>');
  const restored = read();
  expect(restored.humanRequests[0].workProduct[0].available).toBe(true);
  expect(restored.revision).toBe(deleted.revision + 1);
  expect(source.openDatabase().prepare('PRAGMA data_version').get()).toEqual(version);
  // An unchanged file set still reuses the cached activity projection.
  expect(read().revision).toBe(restored.revision);
});

test('removing a bucket copy restores the still-readable original on the request', () => {
  addCopy();
  expect(read().humanRequests[0].workProduct.map((product: any) => product.title)).toEqual(['Saved report']);
  rmSync(copy);
  const products = read().humanRequests[0].workProduct;
  expect(products).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Saved report', available: false }),
    expect.objectContaining({ path: original, available: true }),
  ]));
  expect(source.file('observation', 1, 0)).toBe(original);
});

test('editing a source after its saved copy exposes the newer version without new activity', () => {
  addCopy();
  expect(read().humanRequests[0].workProduct).toHaveLength(1);
  writeFileSync(original, '<h1>Revised report</h1>');
  utimesSync(original, new Date(NOW + 60_000), new Date(NOW + 60_000));
  const products = read().humanRequests[0].workProduct;
  expect(products).toHaveLength(2);
  expect(products).toContainEqual(expect.objectContaining({ path: original, available: true }));
});

test('background reads observe filesystem changes when their existing activity window expires', () => {
  const options = { maxActivityAgeMs: 120_000 };
  const first = read(options);
  rmSync(original);
  setSystemTime(NOW + 30_000);
  expect(read(options).revision).toBe(first.revision);
  setSystemTime(NOW + 120_000);
  expect(read(options).humanRequests[0].workProduct[0].available).toBe(false);
});

function changeFileAfterProjection(change: () => void) {
  const database = source.openDatabase();
  const prepare = database.prepare.bind(database);
  let changed = false;
  database.prepare = (sql: string) => {
    // Linked evidence is read after product visibility has been projected.
    // A file edit or cleanup can happen during this part of a real read.
    if (!changed && sql === 'SELECT id, project, title, subtitle, narrative, created_at_epoch FROM observations WHERE id = ?') {
      changed = true;
      change();
    }
    return prepare(sql);
  };
  return () => changed;
}

test('a file deleted while linked evidence is read invalidates the next projection', () => {
  const changed = changeFileAfterProjection(() => rmSync(original));
  const first = read();
  expect(changed()).toBe(true);
  expect(first.humanRequests[0].workProduct[0].available).toBe(true);
  expect(source.file('observation', 1, 0)).toBeNull();
  expect(read().humanRequests[0].workProduct[0].available).toBe(false);
});

test('a source edited after copy suppression is exposed by the next read', () => {
  addCopy();
  const changed = changeFileAfterProjection(() => {
    writeFileSync(original, '<h1>Revised during projection</h1>');
    utimesSync(original, new Date(NOW + 60_000), new Date(NOW + 60_000));
  });
  expect(read().humanRequests[0].workProduct).toHaveLength(1);
  expect(changed()).toBe(true);
  const products = read().humanRequests[0].workProduct;
  expect(products).toHaveLength(2);
  expect(products).toContainEqual(expect.objectContaining({ path: original, available: true }));
});
