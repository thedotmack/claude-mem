import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

/**
 * The rows ChromaSync's narrowed filtered fallback restricts chroma to (#5091).
 * A row missing from this list but kept by the get*ByIds hydration would drop
 * a search result without any error, so the scope must match the hydration's.
 */
describe('SessionStore.getSearchScopeRowIds', () => {
  let store: SessionStore;
  let sessionCount = 0;

  const OBSERVATIONS = { observations: true, sessions: false, prompts: false };
  const SUMMARIES = { observations: false, sessions: true, prompts: false };
  const PROMPTS = { observations: false, sessions: false, prompts: true };
  const ALL = { observations: true, sessions: true, prompts: true };

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function openSession(project: string, platformSource?: string) {
    sessionCount += 1;
    const contentSessionId = `content-${sessionCount}`;
    const memorySessionId = `memory-${sessionCount}`;
    const sdkSessionId = store.createSDKSession(contentSessionId, project, 'prompt', undefined, platformSource);
    store.ensureMemorySessionIdRegistered(sdkSessionId, memorySessionId);
    return { contentSessionId, memorySessionId, sdkSessionId };
  }

  function seedObservation(project: string, platformSource?: string): number {
    const { memorySessionId } = openSession(project, platformSource);
    return store.storeObservations(memorySessionId, project, [{
      type: 'discovery',
      title: 'observation',
      subtitle: null,
      facts: [],
      narrative: 'narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
    }], null, 1, 0, 1_700_000_000_000).observationIds[0];
  }

  function seedSummary(project: string, platformSource?: string): number {
    const { memorySessionId } = openSession(project, platformSource);
    return store.importSessionSummary({
      memory_session_id: memorySessionId,
      project,
      request: 'request',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      created_at_epoch: 1_700_000_000_000,
    }).id;
  }

  function seedPrompt(project: string, platformSource?: string): number {
    const { contentSessionId, sdkSessionId } = openSession(project, platformSource);
    return store.saveUserPrompt(contentSessionId, 1, 'prompt text', sdkSessionId);
  }

  const sorted = (ids: number[] | null) => ids === null ? null : [...ids].sort((a, b) => a - b);

  it('lists a project\'s observations, including rows merged into it, and no other project\'s', () => {
    const own = seedObservation('small');
    const merged = seedObservation('small/worktree');
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run('small', merged);
    seedObservation('big');

    expect(sorted(store.getSearchScopeRowIds(OBSERVATIONS, { project: 'small' }, 10))).toEqual([own, merged]);
  });

  it('lists session summaries with the merged-project scope of summary hydration', () => {
    const own = seedSummary('small');
    const merged = seedSummary('small/worktree');
    store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE id = ?').run('small', merged);
    seedSummary('big');

    expect(sorted(store.getSearchScopeRowIds(SUMMARIES, { project: 'small' }, 10))).toEqual([own, merged]);
  });

  it('lists prompts by their session\'s project, as prompt hydration does', () => {
    const own = seedPrompt('small');
    seedPrompt('big');

    expect(store.getSearchScopeRowIds(PROMPTS, { project: 'small' }, 10)).toEqual([own]);
  });

  it('narrows by platform, reading an unset platform as claude', () => {
    const claude = seedObservation('p');
    const antigravity = seedObservation('p', 'antigravity-cli');
    seedObservation('p', 'codex');

    expect(store.getSearchScopeRowIds(OBSERVATIONS, { project: 'p', platformSource: 'antigravity-cli' }, 10)).toEqual([antigravity]);
    expect(store.getSearchScopeRowIds(OBSERVATIONS, { project: 'p', platformSource: 'claude' }, 10)).toEqual([claude]);
  });

  it('never leaves out a row the hydration keeps for the same scope', () => {
    for (const project of ['p', 'P', 'p/worktree', 'q']) {
      for (const platformSource of [undefined, 'codex', 'antigravity-cli']) {
        seedObservation(project, platformSource);
        seedSummary(project, platformSource);
        seedPrompt(project, platformSource);
      }
    }
    store.db.prepare(`UPDATE observations SET merged_into_project = 'p' WHERE project = 'p/worktree'`).run();
    store.db.prepare(`UPDATE session_summaries SET merged_into_project = 'p' WHERE project = 'p/worktree'`).run();
    const everyId = (table: string) =>
      (store.db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: number }>).map(row => row.id);

    const scopes = [
      { project: 'p' },
      { projects: ['p', 'P'] },
      { project: 'p', platformSource: 'codex' },
      { platformSource: 'antigravity-cli' },
    ];
    // One category at a time: the tables share ids, so a row missing from one
    // category's list could hide behind another category's row with its id.
    const categories = [
      { only: OBSERVATIONS, kept: (scope: object) => store.getObservationsByIds(everyId('observations'), scope) },
      { only: SUMMARIES, kept: (scope: object) => store.getSessionSummariesByIds(everyId('session_summaries'), scope) },
      { only: PROMPTS, kept: (scope: object) => store.getUserPromptsByIds(everyId('user_prompts'), scope) },
    ];
    for (const scope of scopes) {
      for (const category of categories) {
        const listed = new Set(store.getSearchScopeRowIds(category.only, scope, 1000));
        const kept = category.kept(scope).map(row => row.id);

        expect(kept.length).toBeGreaterThan(0);
        expect(kept.filter(id => !listed.has(id))).toEqual([]);
      }
    }
    // The categories of one search share a single list.
    const union = store.getSearchScopeRowIds(ALL, { project: 'p' }, 1000);
    for (const category of categories) {
      const own = store.getSearchScopeRowIds(category.only, { project: 'p' }, 1000) ?? [];
      expect(own.filter(id => !union?.includes(id))).toEqual([]);
    }
  });

  it('gives up once more than maxIds rows match', () => {
    const ids = [seedObservation('p'), seedObservation('p'), seedObservation('p')];

    expect(store.getSearchScopeRowIds(OBSERVATIONS, { project: 'p' }, 2)).toBeNull();
    expect(sorted(store.getSearchScopeRowIds(OBSERVATIONS, { project: 'p' }, 3))).toEqual(ids);
  });

  it('returns an empty list when no row is in scope', () => {
    seedObservation('p');

    expect(store.getSearchScopeRowIds(OBSERVATIONS, { project: 'nobody' }, 10)).toEqual([]);
  });

  it('finalizes every statement it prepares, including when the row cap stops it early', () => {
    for (let i = 0; i < 3; i++) seedObservation('p');
    const prepare = store.db.prepare.bind(store.db);
    const finalized: boolean[] = [];
    (store.db as any).prepare = (sql: string) => {
      const statement = prepare(sql);
      const index = finalized.push(false) - 1;
      const finalize = statement.finalize.bind(statement);
      statement.finalize = () => { finalized[index] = true; finalize(); };
      return statement;
    };

    expect(store.getSearchScopeRowIds(ALL, { project: 'p' }, 10)).not.toBeNull();
    expect(store.getSearchScopeRowIds(OBSERVATIONS, { project: 'p' }, 2)).toBeNull();

    expect(finalized.length).toBe(4);
    expect(finalized.every(Boolean)).toBe(true);
  });
});
