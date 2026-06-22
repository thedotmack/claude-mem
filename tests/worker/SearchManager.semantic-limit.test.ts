import { describe, expect, it, mock } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { SEARCH_CONSTANTS } from '../../src/services/worker/search/types.js';

describe('SearchManager semanticLimit handling', () => {
  it('keeps public semantic observation JSON responses on the requested limit while ignoring public semanticLimit args', async () => {
    const sessionSearch = {
      searchObservations: mock(() => []),
      searchSessions: mock(() => []),
      searchUserPrompts: mock(() => []),
    } as any;
    const sessionStore = {
      getObservationsByIds: mock(() => []),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
    } as any;
    const chromaSync = {
      queryChroma: mock(async () => ({
        ids: [11, 12, 13, 14, 15, 16],
        distances: [0.01, 0.02, 0.03, 0.04, 0.05, 0.06],
        metadatas: Array.from({ length: 6 }, () => ({ doc_type: 'observation', created_at_epoch: Date.now() })),
      })),
    } as any;
    sessionStore.getObservationsByIds = mock(() => (
      [11, 12, 13, 14, 15, 16].map(id => ({
        id,
        title: `obs-${id}`,
        narrative: `Narrative ${id}`,
        created_at: '2026-01-01T00:00:00Z',
        created_at_epoch: Date.now(),
        project: 'request-project',
      }))
    ));

    const manager = new SearchManager(
      sessionSearch,
      sessionStore,
      chromaSync,
      {} as any,
      {} as any
    );

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
      expect.any(Object)
    );
    expect(sessionStore.getObservationsByIds).toHaveBeenCalledWith(
      [11, 12, 13, 14, 15, 16],
      expect.objectContaining({ project: 'request-project', limit: 100, orderBy: 'relevance' })
    );
    expect(result.observations.map((obs: any) => obs.id)).toEqual([11, 12, 13, 14, 15]);
    expect(result.totalResults).toBe(6);
  });

  it('retains a bounded semantic candidate window so later recent hits survive recency filtering', async () => {
    const sessionSearch = {
      searchObservations: mock(() => []),
      searchSessions: mock(() => []),
      searchUserPrompts: mock(() => []),
    } as any;
    const sessionStore = {
      getObservationsByIds: mock(() => []),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
    } as any;
    const baseIds = [11, 12, 13, 14, 15, 16];
    const staleEpoch = Date.now() - (SEARCH_CONSTANTS.RECENCY_WINDOW_MS + 60_000);
    const recentEpoch = Date.now();
    const chromaSync = {
      queryChroma: mock(async (_query: string, limit: number) => ({
        ids: baseIds.slice(0, limit),
        distances: baseIds.slice(0, limit).map((_, index) => index / 100),
        metadatas: [
          { doc_type: 'observation', created_at_epoch: staleEpoch },
          { doc_type: 'observation', created_at_epoch: staleEpoch },
          { doc_type: 'observation', created_at_epoch: staleEpoch },
          { doc_type: 'observation', created_at_epoch: staleEpoch },
          { doc_type: 'observation', created_at_epoch: staleEpoch },
          { doc_type: 'observation', created_at_epoch: recentEpoch },
        ].slice(0, limit),
      })),
    } as any;
    sessionStore.getObservationsByIds = mock((ids: number[]) => ids.map(id => ({
      id,
      title: `obs-${id}`,
      narrative: `Narrative ${id}`,
      created_at: '2026-01-01T00:00:00Z',
      created_at_epoch: recentEpoch,
      project: 'request-project',
    })));

    const manager = new SearchManager(
      sessionSearch,
      sessionStore,
      chromaSync,
      {} as any,
      {} as any
    );

    const result = await manager.search({
      query: 'find recent work on this topic with enough words',
      type: 'observations',
      project: 'request-project',
      limit: '5',
      format: 'json',
      orderBy: 'relevance',
    });

    expect(chromaSync.queryChroma).toHaveBeenCalledWith(
      'find recent work on this topic with enough words',
      100,
      expect.any(Object)
    );
    expect(sessionStore.getObservationsByIds).toHaveBeenCalledWith(
      [16],
      expect.objectContaining({ project: 'request-project', limit: 100, orderBy: 'relevance' })
    );
    expect(result.observations.map((obs: any) => obs.id)).toEqual([16]);
  });

  it('uses the internal semantic hydration override only for route-local recovery work', async () => {
    const sessionSearch = {
      searchObservations: mock(() => []),
      searchSessions: mock(() => []),
      searchUserPrompts: mock(() => []),
    } as any;
    const sessionStore = {
      getObservationsByIds: mock(() => []),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
    } as any;
    const chromaSync = {
      queryChroma: mock(async () => ({
        ids: [11],
        distances: [0.01],
        metadatas: [{ doc_type: 'observation', created_at_epoch: Date.now() }],
      })),
    } as any;

    const manager = new SearchManager(
      sessionSearch,
      sessionStore,
      chromaSync,
      {} as any,
      {} as any
    );

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
      expect.any(Object)
    );
    expect(sessionStore.getObservationsByIds).toHaveBeenCalledWith(
      [11],
      expect.objectContaining({ project: 'request-project', limit: 100, orderBy: 'relevance' })
    );
  });

  it('keeps the requested limit on the FTS fallback path even when the internal semantic window is wider', async () => {
    const searchObservations = mock(() => []);
    const sessionSearch = {
      searchObservations,
      searchSessions: mock(() => []),
      searchUserPrompts: mock(() => []),
    } as any;
    const sessionStore = {
      getObservationsByIds: mock(() => []),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
    } as any;
    const chromaSync = {
      queryChroma: mock(async () => {
        throw new Error('chroma unavailable');
      }),
    } as any;

    const manager = new SearchManager(
      sessionSearch,
      sessionStore,
      chromaSync,
      {} as any,
      {} as any
    );

    await manager.search({
      query: 'find recent work on this topic with enough words',
      type: 'observations',
      project: 'request-project',
      limit: '5',
      orderBy: 'relevance',
    }, undefined, { semanticHydrationLimit: 100 });

    expect(searchObservations).toHaveBeenCalledWith(
      'find recent work on this topic with enough words',
      expect.objectContaining({ project: 'request-project', limit: '5', orderBy: 'relevance' })
    );
  });
});
