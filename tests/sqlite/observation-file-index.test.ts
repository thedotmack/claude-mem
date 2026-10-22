// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../src/services/sqlite/observations/get.js';

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
});
