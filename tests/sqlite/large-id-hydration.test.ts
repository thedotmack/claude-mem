import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('large native SQLite ID hydration', () => {
  let store: SessionStore;
  let ids: Record<'observations' | 'summaries' | 'prompts', number[]>;
  let overLimitIds: number[];
  const epoch = Date.UTC(2026, 0, 1);

  beforeEach(() => {
    store = new SessionStore(':memory:');
    ids = { observations: [], summaries: [], prompts: [] };
    for (let index = 0; index < 4; index++) {
      const project = index === 2 ? 'elsewhere' : 'app';
      const platform = index === 3 ? 'codex' : 'claude';
      const content = `content-${index}`;
      const session = store.createSDKSession(content, project, 'ask', undefined, platform);
      const memory = store.ensureMemorySessionIdRegistered(session, `memory-${index}`);
      ids.observations.push(store.storeObservation(memory, project, {
        type: 'discovery', title: `Observation ${index}`, subtitle: null, narrative: `Evidence ${index}`,
        facts: [], concepts: ['test-concept'], files_read: ['src/app.ts'], files_modified: [],
      }, 1, 0, epoch + index).id);
      ids.summaries.push(store.storeSummary(memory, project, {
        request: `Summary ${index}`, investigated: '', learned: '', completed: '', next_steps: '', notes: null,
      }, 1, 0, epoch + index).id);
      ids.prompts.push(store.saveUserPrompt(content, 1, `Prompt ${index}`, session, undefined, undefined, epoch + index));
    }
    const option = (store.db.query('PRAGMA compile_options').all() as Array<{ compile_options: string }>)
      .find(row => row.compile_options.startsWith('MAX_VARIABLE_NUMBER='))!;
    const maxVariables = Number(option.compile_options.split('=')[1]);
    // Exercise the SQLite build's real limit, without needing a large history
    // fixture. Missing candidate IDs must be ignored just as in a smaller read.
    overLimitIds = Array.from({ length: maxVariables + 1 }, (_, index) => 10000 + index);
  });

  afterEach(() => store.close());

  for (const kind of ['observations', 'summaries', 'prompts'] as const) {
    function hydrate(ids: number[], options: { limit?: number; project?: string; platformSource?: string; orderBy?: 'date_asc' | 'date_desc' | 'relevance' } = {}) {
      if (kind === 'observations') return store.getObservationsByIds(ids, options);
      if (kind === 'summaries') return store.getSessionSummariesByIds(ids, options);
      return store.getUserPromptsByIds(ids, options);
    }

    it(`hydrates ${kind} beyond the host-parameter limit with filters and one final limit`, () => {
      const requested = [...ids[kind], ...overLimitIds];
      const selected = hydrate(requested, { project: 'APP', platformSource: 'Claude Code', limit: 1 });
      expect(selected.map(row => row.id)).toEqual([ids[kind][1]]);
      expect(hydrate(requested, { project: 'app', platformSource: 'claude', orderBy: 'date_asc' }).map(row => row.id))
        .toEqual(ids[kind].slice(0, 2));
    });

    it(`preserves ${kind} relevance order and the empty-input behavior`, () => {
      const requested = [ids[kind][1], ids[kind][0], ids[kind][3], ...overLimitIds];
      expect(hydrate(requested, { project: 'app', platformSource: 'claude', orderBy: 'relevance', limit: 2 }).map(row => row.id))
        .toEqual([ids[kind][1], ids[kind][0]]);
      expect(hydrate([])).toEqual([]);
    });
  }
});
