import { describe, it, expect } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { projectReadKeys, projectScopeSql } from '../../src/services/sqlite/project-read-keys.js';

// #4782 — a project whose rows were merged into a requested one must not become
// a read key itself. Reads follow merged_into_project per row (projectScopeSql,
// gate P2-4), so promoting the source project would expose every unstamped row
// of it too: one adopted row pulled the whole workspace into the read scope.

function seedProject(store: SessionStore, hostId: string, project: string, titles: string[]): string {
  const sessionDbId = store.createSDKSession(hostId, project, 'prompt');
  const memorySessionId = store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-' + hostId);
  let epoch = 1_700_000_000_000;
  for (const title of titles) {
    store.storeObservation(memorySessionId, project, {
      type: 'discovery', title, subtitle: null, facts: [], narrative: 'n',
      concepts: ['how-it-works'], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    store.storeSummary(memorySessionId, project, {
      request: title, investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null,
    }, 1, 0, epoch);
    epoch += 60_000;
  }
  return memorySessionId;
}

describe('projectReadKeys adopted-row scoping (#4782)', () => {
  it('does not promote a merged-from project to a full read key', () => {
    const store = new SessionStore(':memory:');
    try {
      // The issue's scenario: one hand-picked VibeCoding row adopted into
      // nuviapel; the rest of VibeCoding stays untouched.
      seedProject(store, 'source', 'VibeCoding', ['ADOPTED', 'KEEPS_TO_ITSELF']);
      seedProject(store, 'target', 'nuviapel', ['NUVIAPEL_ROW']);
      store.db.run(`UPDATE observations SET merged_into_project = 'nuviapel' WHERE title = 'ADOPTED'`);
      store.db.run(`UPDATE session_summaries SET merged_into_project = 'nuviapel' WHERE request = 'ADOPTED'`);

      expect(projectReadKeys(store.db, ['nuviapel'])).toEqual(['nuviapel']);
    } finally {
      store.close();
    }
  });

  it('still reads adopted rows through the row-level merged scope (gate P2-4)', () => {
    const store = new SessionStore(':memory:');
    try {
      seedProject(store, 'source', 'VibeCoding', ['ADOPTED', 'KEEPS_TO_ITSELF']);
      seedProject(store, 'target', 'nuviapel', ['NUVIAPEL_ROW']);
      store.db.run(`UPDATE observations SET merged_into_project = 'nuviapel' WHERE title = 'ADOPTED'`);

      const scope = projectScopeSql('o', ['nuviapel'], { includeMerged: true });
      const titles = (store.db.prepare(
        `SELECT title FROM observations o WHERE ${scope.sql} ORDER BY title`
      ).all(...scope.params) as Array<{ title: string }>).map(row => row.title);

      // The stamped row and the project's own rows, never the unstamped ones.
      // (Ordered by title: both seeds share one epoch, so an epoch order ties.)
      expect(titles).toEqual(['ADOPTED', 'NUVIAPEL_ROW']);
    } finally {
      store.close();
    }
  });

  it('still promotes a source project merged wholesale (gate P2-4 chain)', () => {
    const store = new SessionStore(':memory:');
    try {
      // `project merge repo/feature repo`, then `project merge repo work`:
      // every row of each source is stamped, so the chain stays readable.
      seedProject(store, 'wt', 'repo/feature', ['WORKTREE_RECORD']);
      seedProject(store, 'repo', 'repo', ['REPO_RECORD']);
      seedProject(store, 'work', 'work', ['WORK_RECORD']);
      store.db.run(`UPDATE observations SET merged_into_project = 'repo' WHERE title = 'WORKTREE_RECORD'`);
      store.db.run(`UPDATE session_summaries SET merged_into_project = 'repo' WHERE request = 'WORKTREE_RECORD'`);
      store.db.run(`UPDATE observations SET merged_into_project = 'work' WHERE title = 'REPO_RECORD'`);
      store.db.run(`UPDATE session_summaries SET merged_into_project = 'work' WHERE request = 'REPO_RECORD'`);

      // The repo is a whole merge into work: promoted. The worktree is not
      // merged into work itself: reachable only through the repo's rows.
      expect(projectReadKeys(store.db, ['work'])).toEqual(['work', 'repo']);
    } finally {
      store.close();
    }
  });

  it('does not promote a project with an unstamped summary row', () => {
    const store = new SessionStore(':memory:');
    try {
      seedProject(store, 'source', 'VibeCoding', ['ADOPTED']);
      seedProject(store, 'target', 'nuviapel', ['NUVIAPEL_ROW']);
      store.db.run(`UPDATE observations SET merged_into_project = 'nuviapel' WHERE title = 'ADOPTED'`);
      // One summary left unstamped: the adoption never covered the whole project.
      store.db.run(`UPDATE session_summaries SET merged_into_project = NULL`);

      expect(projectReadKeys(store.db, ['nuviapel'])).toEqual(['nuviapel']);
    } finally {
      store.close();
    }
  });

  it('keeps discovering the stored spellings of the requested projects', () => {
    const store = new SessionStore(':memory:');
    try {
      seedProject(store, 'cased', 'Nuviapel', ['CASED_ROW']);

      expect(projectReadKeys(store.db, ['nuviapel'])).toEqual(['nuviapel', 'Nuviapel']);
    } finally {
      store.close();
    }
  });
});
