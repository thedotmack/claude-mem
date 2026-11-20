import { describe, expect, it, mock } from 'bun:test';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';

const bugfixObservation = {
  id: 42,
  memory_session_id: 'session-bugfix',
  project: 'corpus-project',
  text: null,
  type: 'bugfix' as const,
  title: 'Preserve corpus observation filters',
  subtitle: null,
  facts: '[]',
  narrative: 'The corpus search keeps the selected observation type.',
  concepts: '[]',
  files_read: '[]',
  files_modified: '[]',
  prompt_number: 1,
  discovery_tokens: 0,
  created_at: '2025-01-01T00:00:00.000Z',
  created_at_epoch: 1735689600000,
};

const featureObservation = {
  ...bugfixObservation,
  id: 43,
  memory_session_id: 'session-feature',
  type: 'feature' as const,
  title: 'Unrelated feature observation',
};

describe('CorpusBuilder observation type filters', () => {
  it('passes types through the search layer before phase-two hydration', async () => {
    const searchObservations = mock((_query: string | undefined, options: { type?: string[] }) => {
      // Model the default search page: without the observation-type filter the
      // requested bugfix is beyond the page and is never available to hydrate.
      return options.type?.includes('bugfix') ? [bugfixObservation] : [featureObservation];
    });
    const searchOrchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
    );
    const getObservationsByIds = mock((ids: number[], options: { type?: string[] }) => {
      const rows = ids.includes(bugfixObservation.id) ? [bugfixObservation] : [];
      return options.type?.includes('bugfix') ? rows : [];
    });
    const write = mock(() => undefined);
    const builder = new CorpusBuilder(
      { getObservationsByIds } as any,
      searchOrchestrator,
      { write } as any,
    );

    const corpus = await builder.build('bugfixes', 'Bugfix observations', {
      types: ['bugfix'],
    });

    expect(searchObservations).toHaveBeenCalledWith(undefined, expect.objectContaining({
      type: ['bugfix'],
    }));
    expect(getObservationsByIds).toHaveBeenCalledWith([bugfixObservation.id], expect.objectContaining({
      type: ['bugfix'],
    }));
    expect(corpus.observations).toHaveLength(1);
    expect(corpus.observations[0]?.id).toBe(bugfixObservation.id);
    expect(write).toHaveBeenCalledWith(corpus);
  });
});

// A corpus is defined by its stored filter. Without dates, the implicit 90-day window that
// interactive Chroma search applies would silently drop everything older than 90 days on each
// rebuild, so an ageing corpus would trip the shrink guard and need force to refresh.
describe('CorpusBuilder recency window', () => {
  it('keeps Chroma matches older than 90 days when the filter has no date range', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const recent = { ...bugfixObservation, id: 51, created_at_epoch: Date.now() - dayMs };
    const old = { ...bugfixObservation, id: 52, created_at_epoch: Date.now() - 200 * dayMs };
    const rowsById = new Map([[recent.id, recent], [old.id, old]]);
    const getObservationsByIds = mock((ids: number[]) => ids.map(id => rowsById.get(id)).filter(Boolean));
    const queryChroma = mock(() => Promise.resolve({
      ids: [recent.id, old.id],
      distances: [0.1, 0.2],
      metadatas: [
        { sqlite_id: recent.id, doc_type: 'observation', created_at_epoch: recent.created_at_epoch },
        { sqlite_id: old.id, doc_type: 'observation', created_at_epoch: old.created_at_epoch },
      ],
    }));
    const sessionStore = {
      getObservationsByIds,
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
    };
    const searchOrchestrator = new SearchOrchestrator(
      { searchObservations: mock(() => []), searchSessions: mock(() => []), searchUserPrompts: mock(() => []) } as any,
      sessionStore as any,
      { queryChroma } as any,
    );
    const builder = new CorpusBuilder(sessionStore as any, searchOrchestrator, { write: mock(() => undefined) } as any);

    const corpus = await builder.build('everything-about-corpora', '', { query: 'corpus filters' });

    expect(corpus.observations.map(o => o.id).sort()).toEqual([recent.id, old.id]);
  });
});
