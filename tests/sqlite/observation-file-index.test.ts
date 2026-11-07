// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../src/services/sqlite/observations/get.js';
import { SyncApply, type SyncOp } from '../../src/services/sync/SyncApply.js';

// file-context's by-file lookup used to json_each every observation's
// files_read/files_modified on the one shared connection. These tests pin the
// replacement: a path index that answers the lookup without scanning the table.

type ObservationInput = {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
};

const obs = (over: Partial<ObservationInput> = {}): ObservationInput => ({
  type: 'discovery',
  title: 'file lookup',
  subtitle: null,
  facts: [],
  narrative: 'a file was read',
  concepts: [],
  files_read: [],
  files_modified: [],
  ...over,
});

function makeSession(store: SessionStore, memId = 's1'): void {
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES (?, ?, 'proj', 'active', '2026-06-17', 1750000000)`,
    [memId, memId],
  );
}

describe('observation file path index', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });
  afterEach(() => store.db.close());

  it('answers a by-file lookup from the path index, not a json_each scan', () => {
    const hit = store.storeObservation('s1', 'proj', obs({
      title: 'hit', narrative: 'hit', files_read: ['src/permission.go'], files_modified: ['src/permission_test.go'],
    }));
    store.storeObservation('s1', 'proj', obs({
      title: 'miss', narrative: 'miss', files_read: ['src/other.go'],
    }));

    const plan = store.db.prepare(
      "EXPLAIN QUERY PLAN SELECT o.id FROM observation_files f JOIN observations o ON o.id = f.observation_id WHERE f.path IN ('src/permission.go')",
    ).all() as Array<{ detail: string }>;
    const planned = plan.map(row => row.detail).join('\n');
    expect(planned).not.toContain('json_each');
    expect(planned.toLowerCase()).toContain('index');

    const found = getObservationsByFilePath(store.db, ['src/permission.go', 'src/permission_test.go']);
    expect(found.map(row => row.id)).toEqual([hit.id]);
  });

  it('backfills the index for rows written before it existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-file-index-'));
    const dbPath = join(dir, 'claude-mem-test.db');
    const first = new SessionStore(dbPath);
    makeSession(first);
    const { id } = first.storeObservation('s1', 'proj', obs({ files_read: ['src/legacy.go'] }));
    // Put the database back to how it looked before v68: the observation is
    // there, the index and its bookkeeping are not.
    first.db.run('DELETE FROM observation_files');
    first.db.run('DELETE FROM schema_versions WHERE version = 68');
    first.db.close();

    const reopened = new SessionStore(dbPath);
    const found = getObservationsByFilePath(reopened.db, 'src/legacy.go');
    expect(found.map(row => row.id)).toEqual([id]);
    reopened.db.close();
  });

  it('rolls the observation back when its path mappings cannot be written', () => {
    // A crash between the row insert and the mapping inserts must not leave a
    // permanently unsearchable observation: the import replay match skips the
    // existing row and the v68 migration is already stamped, so nothing repairs it.
    store.db.run('DROP TABLE observation_files');
    expect(() => store.importObservation({
      memory_session_id: 's1', project: 'proj', text: null, type: 'discovery',
      title: 'atomic', subtitle: null, facts: null, narrative: 'n', concepts: null,
      files_read: '["src/atomic.go"]', files_modified: null,
      prompt_number: 1, discovery_tokens: 0,
      created_at: '2026-06-17T00:00:00.000Z', created_at_epoch: 1750000001,
    })).toThrow();
    const rows = store.db.prepare("SELECT COUNT(*) c FROM observations WHERE title = 'atomic'").get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

// CloudSync writes observations through SyncApply's own SQL, not SessionStore,
// so the mapping has to be maintained on both of its branches: an insert makes
// a pulled observation searchable and a revision must not leave the previous
// revision's paths behind.
describe('observation file path index under SyncApply', () => {
  let db: Database;
  let apply: SyncApply;

  const body = (over: Record<string, unknown> = {}) => ({
    memory_session_id: 'mem-remote', project: 'remote-proj', text: null, type: 'discovery',
    title: 'Remote', subtitle: null, facts: '[]', narrative: 'n', concepts: '[]',
    files_read: '["src/synced.go"]', files_modified: '[]',
    prompt_number: 1, discovery_tokens: 0, content_hash: 'hash-1', generated_by_model: null,
    agent_type: null, agent_id: null, metadata: null, merged_into_project: null,
    created_at: '2026-06-17T00:00:00.000Z', created_at_epoch: 1750000000,
    ...over,
  });
  const op = (seq: string, rev: string, b: Record<string, unknown>): SyncOp => ({
    seq, kind: 'observation', origin_device: 'device-remote', origin_id: '11', rev,
    body: JSON.stringify(b), server_ts: 1750000000,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    new SessionStore(db);
    apply = new SyncApply(db, { deviceId: 'device-self', now: () => 1750000000 });
  });
  afterEach(() => db.close());

  it('makes a pulled observation searchable by file path', () => {
    expect(apply.applyOps([op('1', '1', body())]).applied).toBe(1);
    expect(getObservationsByFilePath(db, 'src/synced.go').length).toBe(1);
  });

  it('replaces the previous revision\'s paths on an updated observation', () => {
    expect(apply.applyOps([op('1', '1', body())]).applied).toBe(1);
    const revision = apply.applyOps([op('2', '2', body({
      files_read: '["src/renamed.go"]', content_hash: 'hash-2',
    }))]);
    expect(revision.applied).toBe(1);
    expect(getObservationsByFilePath(db, 'src/renamed.go').length).toBe(1);
    expect(getObservationsByFilePath(db, 'src/synced.go')).toEqual([]);
  });
});
