// #3531 — two checkouts whose directory names differ only in case
// (`PasteyPal` vs `pasteypal`) used to fork memory into two buckets because
// project keys were compared with BINARY collation. Reads now compare with
// COLLATE NOCASE; stored keys are never rewritten, so nothing is re-keyed and
// there is nothing to remap for cloud sync.
import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';

const NOCASE_SCHEMA_VERSION = 55;

function seed(store: SessionStore, contentId: string, memoryId: string, project: string, title: string): void {
  const sessionDbId = store.createSDKSession(contentId, project, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);
  store.storeObservation(memoryId, project, {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: `${title} narrative`,
    concepts: [],
    files_read: [],
    files_modified: [],
  }, 1);
}

describe('case-insensitive project keys (#3531)', () => {
  it('records its schema version and creates the NOCASE indexes', () => {
    const store = new SessionStore(':memory:');
    try {
      const version = store.db
        .prepare('SELECT version FROM schema_versions WHERE version = ?')
        .get(NOCASE_SCHEMA_VERSION) as { version: number } | undefined;
      expect(version?.version).toBe(NOCASE_SCHEMA_VERSION);

      const indexes = (store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%nocase'")
        .all() as Array<{ name: string }>).map(row => row.name).sort();
      expect(indexes).toEqual([
        'idx_observations_merged_into_nocase',
        'idx_observations_project_nocase',
        'idx_sdk_sessions_project_nocase',
        'idx_summaries_merged_into_nocase',
        'idx_summaries_project_nocase',
      ]);
    } finally {
      store.close();
    }
  });

  it('never rewrites stored keys', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store, 'content-a', 'memory-a', 'PasteyPal', 'MACHINE_A');
      const stored = store.db.prepare('SELECT project FROM observations').all() as Array<{ project: string }>;
      expect(stored.map(row => row.project)).toEqual(['PasteyPal']);
    } finally {
      store.close();
    }
  });

  it('lists every stored spelling of a project for exact-match stores like Chroma', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store, 'content-a', 'memory-a', 'PasteyPal', 'MACHINE_A');
      seed(store, 'content-b', 'memory-b', 'pasteypal', 'MACHINE_B');
      seed(store, 'content-c', 'memory-c', 'other-project', 'UNRELATED');

      expect(store.getProjectReadKeys(['PASTEYPAL']).sort()).toEqual(['PASTEYPAL', 'PasteyPal', 'pasteypal']);
      expect(store.getProjectReadKeys(['never-seen'])).toEqual(['never-seen']);
    } finally {
      store.close();
    }
  });

  it('search filters match a project across case', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store, 'content-a', 'memory-a', 'PasteyPal', 'MACHINE_A');
      seed(store, 'content-b', 'memory-b', 'pasteypal', 'MACHINE_B');
      seed(store, 'content-c', 'memory-c', 'other-project', 'UNRELATED');

      const search = new SessionSearch(store.db);
      const titles = search.searchObservations(undefined, { project: 'pasteypal', limit: 10 })
        .map(row => row.title)
        .sort();
      expect(titles).toEqual(['MACHINE_A', 'MACHINE_B']);
    } finally {
      store.close();
    }
  });

  it('search follows merged_into_project across case', () => {
    const store = new SessionStore(':memory:');
    try {
      // A worktree row adopted into the repo under one spelling (#3641) is found
      // by a search for another spelling of the repo.
      seed(store, 'content-wt', 'memory-wt', 'PasteyPal/feature-x', 'ADOPTED_WORKTREE');
      store.db
        .prepare('UPDATE observations SET merged_into_project = ? WHERE memory_session_id = ?')
        .run('PasteyPal', 'memory-wt');
      seed(store, 'content-c', 'memory-c', 'other-project', 'UNRELATED');

      const search = new SessionSearch(store.db);
      const titles = search.searchObservations(undefined, { project: 'pasteypal', limit: 10 })
        .map(row => row.title);
      expect(titles).toEqual(['ADOPTED_WORKTREE']);
    } finally {
      store.close();
    }
  });
});
