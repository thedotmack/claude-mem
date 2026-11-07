import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../src/services/worker/PaginationHelper.js';
import { rowInProject } from '../../src/ui/viewer/utils/sessions';

// Selecting a project in the viewer header requests `?project=X`, which the
// worker answers with rows captured in X *or* merged into X (worktree adoption,
// `claude-mem project merge`). The viewer's client-side scope filter must keep
// the merged rows instead of dropping everything whose own project differs.
describe('viewer project scope keeps rows merged into the selected project', () => {
  let store: SessionStore;
  let helper: PaginationHelper;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    helper = new PaginationHelper({ getSessionStore: () => store } as any);
    const sessionDbId = store.createSDKSession('content-wt', 'app/feature-wt', 'hello');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-wt');
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, merged_into_project, type, title, created_at, created_at_epoch)
      VALUES ('mem-wt', 'app/feature-wt', 'app', 'discovery', 'worktree obs', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, merged_into_project, request, created_at, created_at_epoch)
      VALUES ('mem-wt', 'app/feature-wt', 'app', 'worktree summary', '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();
  });

  afterEach(() => store.close());

  it('keeps merged observations and summaries returned for ?project=app', () => {
    const observations = helper.getObservations(0, 20, 'app').items;
    const summaries = helper.getSummaries(0, 20, 'app').items;
    expect(observations).toHaveLength(1);
    expect(summaries).toHaveLength(1);

    expect(observations.filter(row => rowInProject(row, 'app')).map(row => row.title)).toEqual(['worktree obs']);
    expect(summaries.filter(row => rowInProject(row, 'app')).map(row => row.request)).toEqual(['worktree summary']);
  });

  it('still matches rows by their own project and excludes other projects', () => {
    expect(rowInProject({ project: 'app/feature-wt', merged_into_project: 'app' }, 'app/feature-wt')).toBe(true);
    expect(rowInProject({ project: 'app', merged_into_project: null }, 'app')).toBe(true);
    expect(rowInProject({ project: 'other', merged_into_project: null }, 'app')).toBe(false);
    // `project merge app/feature-wt App` keeps the destination's case; the worker matches it NOCASE.
    expect(rowInProject({ project: 'app/feature-wt', merged_into_project: 'App' }, 'app')).toBe(true);
    // SQLite NOCASE folds ASCII only, so non-ASCII case differences stay separate projects.
    expect(rowInProject({ project: 'école', merged_into_project: null }, 'École')).toBe(false);
  });
});
