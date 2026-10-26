import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const copy = {
  project: 'acme', contentSessionId: 'c-1', platformSource: 'claude', title: 'Launch report', kind: 'page',
  sourcePath: '/w/.scratch/report.html', bucketPath: '/data/deliverables/acme/report-3f9a1c2b.html',
  bytes: 22, sha256: '3f9a1c2b'.repeat(8), declared: false, toolUseId: 'toolu_1', occurredAtEpoch: 1_000, createdAtEpoch: 2_000,
};

describe('SessionStore deliverables', () => {
  let store: SessionStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it('creates the table without a schema version row, so an older worker sharing the database still opens it', () => {
    store = new SessionStore(':memory:');
    const tables = store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'deliverables'").all();
    expect(tables).toHaveLength(1);
    const latest = store.db.query('SELECT MAX(version) AS version FROM schema_versions').get() as { version: number };
    expect(latest.version).toBe(68);
  });

  it('records one row per session and bucket copy, and finds the row a re-fired Stop already wrote', () => {
    store = new SessionStore(':memory:');
    const first = store.recordDeliverable(copy);
    expect(first.inserted).toBe(true);
    expect(store.recordDeliverable({ ...copy, title: 'renamed' })).toEqual({ id: first.id, inserted: false });

    const row = store.getDeliverable(first.id)!;
    expect(row).toMatchObject({
      project: 'acme', content_session_id: 'c-1', platform_source: 'claude', title: 'Launch report', kind: 'page',
      source_path: '/w/.scratch/report.html', bucket_path: '/data/deliverables/acme/report-3f9a1c2b.html',
      bytes: 22, declared: 0, tool_use_id: 'toolu_1', occurred_at_epoch: 1_000, created_at_epoch: 2_000,
    });
    expect(row.created_at).toBe(new Date(2_000).toISOString());

    // The same copy attached by another session is that session's own deliverable.
    const other = store.recordDeliverable({ ...copy, contentSessionId: 'c-2', declared: true, listName: 'launch', field: 'work_product' });
    expect(other.inserted).toBe(true);
    expect(store.getDeliverable(other.id)).toMatchObject({ content_session_id: 'c-2', declared: 1, list_name: 'launch', field: 'work_product' });

    expect(store.getDeliverable(999)).toBeNull();
    expect(store.getDeliverable(0)).toBeNull();
  });
});
