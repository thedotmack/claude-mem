// Gate P2-5: a checkout reads several project keys (its current key plus the
// ones it wrote under before a git-remote slug, an environment or a marker
// re-keyed it), but search took a single project, so memory stored under the
// older keys was missing from search. Search now takes the whole list.
//
// Gate P2-16: the by-file search matched summaries on `project` only, ignoring
// merged_into_project, so an adopted worktree's summaries were missing.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { projectReadKeys } from '../../../src/services/sqlite/project-read-keys.js';

let store: SessionStore;
let search: SessionSearch;

function seedObservation(memorySessionId: string, project: string, title: string, mergedInto: string | null = null): void {
  const sessionDbId = store.createSDKSession(`content-${memorySessionId}`, project, `prompt about ${title}`);
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  store.storeObservation(memorySessionId, project, {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: `${title} alias keyword`,
    concepts: [],
    files_read: ['src/app.ts'],
    files_modified: [],
  }, 1);
  store.saveUserPrompt(`content-${memorySessionId}`, 1, `alias keyword prompt for ${title}`, sessionDbId);
  if (mergedInto) {
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE memory_session_id = ?').run(mergedInto, memorySessionId);
  }
}

function seedSummary(memorySessionId: string, project: string, mergedInto: string | null = null): void {
  // Keep the session's key separate so only the summary can supply this alias.
  const sessionDbId = store.createSDKSession(`content-${memorySessionId}`, 'summary-host', 'summary prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  store.storeSummary(memorySessionId, project, {
    request: 'SUMMARY_KEY_RECORD',
    investigated: 'project aliases',
    learned: 'summary-only spelling',
    completed: 'summary saved',
    next_steps: 'read context',
    notes: null,
  }, 1);
  if (mergedInto) {
    const statement = store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE memory_session_id = ?');
    try {
      statement.run(mergedInto, memorySessionId);
    } finally {
      statement.finalize();
    }
  }
}

beforeEach(() => {
  store = new SessionStore(':memory:');
  search = new SessionSearch(store.db);
  // The folder key the checkout wrote under before a slug renamed it.
  seedObservation('mem-folder', 'api', 'FOLDER_KEY_RECORD');
  // The slug key it writes under now.
  seedObservation('mem-slug', 'acme/api', 'SLUG_KEY_RECORD');
  seedObservation('mem-other', 'other', 'UNRELATED_RECORD');
});

afterEach(() => {
  store.close();
});

describe('search reads every key of a checkout (gate P2-5)', () => {
  it('matches observations under any of the projects, with and without a query', () => {
    const projects = ['api', 'acme/api'];
    const withQuery = search.searchObservations('alias', { projects }).map(row => row.title).sort();
    const filterOnly = search.searchObservations(undefined, { projects }).map(row => row.title).sort();
    expect(withQuery).toEqual(['FOLDER_KEY_RECORD', 'SLUG_KEY_RECORD']);
    expect(filterOnly).toEqual(['FOLDER_KEY_RECORD', 'SLUG_KEY_RECORD']);
  });

  it('matches user prompts under any of the projects', () => {
    const prompts = search.searchUserPrompts(undefined, { projects: ['api', 'acme/api'] })
      .map(row => row.prompt_text)
      .sort();
    expect(prompts).toEqual(['alias keyword prompt for FOLDER_KEY_RECORD', 'alias keyword prompt for SLUG_KEY_RECORD']);
  });

  it('matches by-ids lookups under any of the projects', () => {
    const ids = (store.db.prepare('SELECT id FROM observations').all() as Array<{ id: number }>).map(row => row.id);
    const titles = store.getObservationsByIds(ids, { projects: ['api', 'acme/api'] }).map(row => row.title).sort();
    expect(titles).toEqual(['FOLDER_KEY_RECORD', 'SLUG_KEY_RECORD']);
  });
});

describe('by-file search follows merged_into_project for summaries (gate P2-16)', () => {
  it('returns an adopted worktree summary for its repository', () => {
    const sessionDbId = store.createSDKSession('content-wt', 'repo/feature', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-wt');
    store.storeSummary('mem-wt', 'repo/feature', {
      request: 'ADOPTED_SUMMARY',
      investigated: 'investigated',
      learned: 'learned',
      completed: 'completed',
      next_steps: 'next',
      notes: null,
      files_read: [],
      files_edited: ['src/feature.ts'],
    }, 1);
    store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE memory_session_id = ?').run('repo', 'mem-wt');

    const { sessions } = search.findByFile('src/feature.ts', { project: 'repo' });
    expect(sessions.map(row => row.request)).toEqual(['ADOPTED_SUMMARY']);
  });
});

describe('projectReadKeys', () => {
  it('lists every stored spelling and the projects merged into the requested ones', () => {
    seedObservation('mem-case', 'API', 'CASE_VARIANT_RECORD');
    seedObservation('mem-merged', 'old-folder', 'MERGED_RECORD', 'acme/api');

    expect(projectReadKeys(store.db, ['api', 'acme/api']).sort()).toEqual(['API', 'acme/api', 'api', 'old-folder']);
    expect(projectReadKeys(store.db, ['never-seen'])).toEqual(['never-seen']);
    expect(projectReadKeys(store.db, [])).toEqual([]);
  });

  it('preserves spellings found only in session metadata or summaries without duplicating requested keys', () => {
    store.createSDKSession('content-metadata-only', 'Api', 'metadata-only prompt');
    seedSummary('mem-summary-case', 'aPI');

    expect(projectReadKeys(store.db, [' api ', 'API', 'api', '', '   ']).sort()).toEqual(['API', 'Api', 'aPI', 'api']);
  });

  it('includes a source project represented only by summaries merged into the requested key', () => {
    seedSummary('mem-summary-merged', 'old-summary-folder', 'acme/api');

    expect(projectReadKeys(store.db, ['acme/api']).sort()).toEqual(['acme/api', 'old-summary-folder']);
  });

  it('expands one merge hop without promoting deeper source projects', () => {
    seedObservation('mem-direct-source', 'repo', 'DIRECT_SOURCE', 'work');
    seedObservation('mem-adopted-source', 'repo/feature', 'ADOPTED_SOURCE', 'repo');
    seedObservation('mem-deeper-source', 'repo/feature/deeper', 'DEEPER_SOURCE', 'repo/feature');

    expect(projectReadKeys(store.db, ['work']).sort()).toEqual(['repo', 'work']);
  });
});
