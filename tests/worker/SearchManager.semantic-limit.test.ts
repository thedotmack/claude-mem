import { describe, expect, it, mock } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

describe('SearchManager semanticLimit handling', () => {
  it('uses semanticLimit for Chroma hydration without widening the user-facing route limit contract', async () => {
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
      semanticLimit: '100',
      orderBy: 'relevance',
    });

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

  it('keeps the requested limit on the FTS fallback path even when semanticLimit is wider', async () => {
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
      semanticLimit: '100',
      orderBy: 'relevance',
    });

    expect(searchObservations).toHaveBeenCalledWith(
      'find recent work on this topic with enough words',
      expect.objectContaining({ project: 'request-project', limit: '5', orderBy: 'relevance' })
    );
  });
});
