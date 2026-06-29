import { describe, it, expect, mock } from 'bun:test';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';

const observation = {
  id: 21,
  memory_session_id: 'cursor-memory',
  project: 'orchestrator-project',
  text: null,
  type: 'discovery',
  title: 'cursor sqlite fallback',
  subtitle: null,
  facts: '[]',
  narrative: 'fallback through sqlite strategy',
  concepts: '[]',
  files_read: '[]',
  files_modified: '[]',
  prompt_number: 1,
  discovery_tokens: 0,
  created_at: '2025-01-01T00:00:00.000Z',
  created_at_epoch: 1735689600000,
};

describe('SearchOrchestrator platform-scoped Chroma zero fallback', () => {
  it('falls back to SQLiteStrategy when platform-scoped Chroma search returns no rows', async () => {
    const queryChroma = mock(() => Promise.resolve({ ids: [], distances: [], metadatas: [] }));
    const searchObservations = mock(() => [observation]);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
    );

    const result = await orchestrator.search({
      query: 'legacy docs',
      searchType: 'observations',
      project: 'orchestrator-project',
      platform_source: 'Cursor',
      limit: 5,
    });

    expect(queryChroma).toHaveBeenCalledWith(
      'legacy docs',
      100,
      { $and: [{ doc_type: 'observation' }, { project: 'orchestrator-project' }, { platform_source: 'cursor' }] },
    );
    expect(searchObservations).toHaveBeenCalledWith('legacy docs', expect.objectContaining({
      project: 'orchestrator-project',
      platformSource: 'cursor',
    }));
    expect(result.usedChroma).toBe(false);
    expect(result.strategy).toBe('sqlite');
    expect(result.results.observations).toEqual([observation]);
  });

  it('keeps unscoped Chroma zero matches final', async () => {
    const queryChroma = mock(() => Promise.resolve({ ids: [], distances: [], metadatas: [] }));
    const searchObservations = mock(() => [observation]);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
      } as any,
      { queryChroma } as any,
    );

    const result = await orchestrator.search({
      query: 'legacy docs',
      searchType: 'observations',
      project: 'orchestrator-project',
      limit: 5,
    });

    expect(searchObservations).not.toHaveBeenCalled();
    expect(result.usedChroma).toBe(true);
    expect(result.strategy).toBe('chroma');
    expect(result.results.observations).toHaveLength(0);
  });
});
