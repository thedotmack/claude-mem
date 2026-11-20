import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createDeliverablesSchema, getDeliverable, recordDeliverable } from '../../src/services/sqlite/deliverables.js';

describe('deliverable declaration after an inferred copy', () => {
  const databases: Database[] = [];
  afterEach(() => databases.splice(0).forEach(db => db.close()));

  function database() {
    const db = new Database(':memory:');
    databases.push(db);
    createDeliverablesSchema(db);
    return db;
  }

  const inferred = {
    project: 'report', contentSessionId: 'session-1', platformSource: 'claude',
    title: 'draft', kind: 'document', sourcePath: '/scratch/report.pdf',
    bucketPath: '/data/deliverables/report/report-abcd1234.pdf',
    bytes: 50, sha256: 'a'.repeat(64), declared: false,
    toolUseId: 'write-1', occurredAtEpoch: 1000, createdAtEpoch: 2000,
  };
  const declared = {
    ...inferred, declared: true, title: 'Quarterly report', listName: 'quarterly-report',
    field: 'work_product', toolUseId: 'attach-1', occurredAtEpoch: 3000, createdAtEpoch: 4000,
  };

  it('preserves an explicit title and attachment when the bytes were already captured', () => {
    const db = database();
    const first = recordDeliverable(db, inferred);
    expect(recordDeliverable(db, declared)).toEqual({ id: first.id, inserted: false });
    expect(getDeliverable(db, first.id)).toMatchObject({
      title: 'Quarterly report', declared: 1, list_name: 'quarterly-report', field: 'work_product',
      tool_use_id: 'attach-1', occurred_at_epoch: 3000,
      bucket_path: inferred.bucketPath, sha256: inferred.sha256, bytes: 50, created_at_epoch: 2000,
    });
    expect(db.query('SELECT count(*) AS n FROM deliverables').get()).toEqual({ n: 1 });
  });

  it('keeps a declaration when an older inferred Stop is replayed later', () => {
    const db = database();
    const first = recordDeliverable(db, inferred);
    recordDeliverable(db, declared);
    recordDeliverable(db, { ...inferred, createdAtEpoch: 5000 });
    expect(getDeliverable(db, first.id)).toMatchObject({
      title: declared.title, declared: 1, list_name: declared.listName, tool_use_id: declared.toolUseId,
    });
  });

  it('still deduplicates repeated declarations and keeps sessions independent', () => {
    const db = database();
    const first = recordDeliverable(db, declared);
    recordDeliverable(db, { ...declared, title: 'duplicate delivery' });
    expect(getDeliverable(db, first.id)?.title).toBe(declared.title);
    const other = recordDeliverable(db, { ...inferred, contentSessionId: 'session-2' });
    expect(other.inserted).toBe(true);
    expect(getDeliverable(db, other.id)).toMatchObject({ title: inferred.title, declared: 0 });
  });
});
