import { describe, expect, it, mock } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

function makeManager(overrides: {
  chromaSync?: any;
  sessionStore?: any;
  sessionSearch?: any;
} = {}): { manager: SearchManager; chromaSync: any; sessionStore: any; sessionSearch: any } {
  const sessionSearch = overrides.sessionSearch ?? {
    searchObservations: mock(() => []),
    searchSessions: mock(() => []),
    searchUserPrompts: mock(() => []),
  };
  const sessionStore = overrides.sessionStore ?? {
    getObservationsByIds: mock(() => []),
    getSessionSummariesByIds: mock(() => []),
    getUserPromptsByIds: mock(() => []),
  };
  const chromaSync = overrides.chromaSync ?? {
    queryChroma: mock(async () => ({
      ids: [11, 12, 13, 14, 15, 16],
      distances: [0.01, 0.02, 0.03, 0.04, 0.05, 0.06],
      metadatas: Array.from({ length: 6 }, () => ({ doc_type: 'observation', created_at_epoch: Date.now() })),
    })),
  };
  return {
    manager: new SearchManager(sessionSearch, sessionStore, chromaSync, {} as any, {} as any),
    chromaSync,
    sessionStore,
    sessionSearch,
  };
}

describe('SearchManager semantic hydration limits', () => {
  it('uses a wider Chroma candidate window while hydrating only the requested public limit', async () => {
    const sessionStore = {
      getObservationsByIds: mock((ids: number[], options: { limit?: number }) => ids.slice(0, options.limit ?? ids.length).map(id => ({
        id,
        title: `obs-${id}`,
        narrative: `Narrative ${id}`,
        created_at: '2026-01-01T00:00:00Z',
        created_at_epoch: Date.now(),
        project: 'request-project',
      }))),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
    };
    const { manager, chromaSync } = makeManager({ sessionStore });

    const result = await manager.search({
      query: 'find recent work on this topic with enough words',
      type: 'observations',
      project: 'request-project',
      limit: '5',
      format: 'json',
      semanticLimit: '1000',
      orderBy: 'relevance',
    });

    expect(chromaSync.queryChroma).toHaveBeenCalledWith(
      'find recent work on this topic with enough words',
      100,
      expect.any(Object),
    );
    expect(sessionStore.getObservationsByIds).toHaveBeenCalledWith(
      [11, 12, 13, 14, 15, 16],
      expect.objectContaining({ project: 'request-project', limit: 5, orderBy: 'relevance' }),
    );
    expect(result.observations.map((obs: any) => obs.id)).toEqual([11, 12, 13, 14, 15]);
  });

  it('lets route-local recovery hydrate a bounded internal window', async () => {
    const { manager, chromaSync, sessionStore } = makeManager({
      chromaSync: {
        queryChroma: mock(async () => ({
          ids: [11],
          distances: [0.01],
          metadatas: [{ doc_type: 'observation', created_at_epoch: Date.now() }],
        })),
      },
    });

    await manager.search({
      query: 'find recent work on this topic with enough words',
      type: 'observations',
      project: 'request-project',
      limit: '5',
      orderBy: 'relevance',
    }, undefined, { semanticHydrationLimit: 250 });

    expect(chromaSync.queryChroma).toHaveBeenCalledWith(
      'find recent work on this topic with enough words',
      100,
      expect.any(Object),
    );
    expect(sessionStore.getObservationsByIds).toHaveBeenCalledWith(
      [11],
      expect.objectContaining({ project: 'request-project', limit: 100, orderBy: 'relevance' }),
    );
  });

  it('keeps the requested limit on FTS fallback when the internal semantic window is wider', async () => {
    const searchObservations = mock(() => []);
    const { manager } = makeManager({
      sessionSearch: {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      },
      chromaSync: {
        queryChroma: mock(async () => {
          throw new Error('chroma unavailable');
        }),
      },
    });

    await manager.search({
      query: 'find recent work on this topic with enough words',
      type: 'observations',
      project: 'request-project',
      limit: '5',
      orderBy: 'relevance',
    }, undefined, { semanticHydrationLimit: 100 });

    expect(searchObservations).toHaveBeenCalledWith(
      'find recent work on this topic with enough words',
      expect.objectContaining({ project: 'request-project', limit: '5', orderBy: 'relevance' }),
    );
  });
});
