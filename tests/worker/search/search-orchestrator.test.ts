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
      { $and: [{ doc_type: 'observation' }, { $or: [{ project: 'orchestrator-project' }, { merged_into_project: 'orchestrator-project' }] }, { platform_source: 'cursor' }] },
    );
    expect(searchObservations).toHaveBeenCalledWith('legacy docs', expect.objectContaining({
      project: 'orchestrator-project',
      platformSource: 'cursor',
    }));
    expect(result.usedChroma).toBe(false);
    expect(result.strategy).toBe('sqlite');
    expect(result.results.observations).toEqual([observation]);
  });

  it('falls back to SQLiteStrategy when unscoped Chroma search returns no rows', async () => {
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

    expect(searchObservations).toHaveBeenCalled();
    expect(result.usedChroma).toBe(false);
    expect(result.strategy).toBe('sqlite');
    expect(result.results.observations).toEqual([observation]);
  });
});

describe('SearchOrchestrator per-category SQLite supplement', () => {
  const userPrompt = {
    id: 7,
    content_session_id: 'session-7',
    prompt_number: 1,
    prompt_text: 'テストを実行して',
    created_at: '2025-01-01T00:00:00.000Z',
    created_at_epoch: Date.now(),
  };

  function buildOrchestrator(mocks: {
    searchObservations?: ReturnType<typeof mock>;
    searchSessions?: ReturnType<typeof mock>;
    searchUserPrompts?: ReturnType<typeof mock>;
    queryChroma: ReturnType<typeof mock>;
    getUserPromptsByIds?: ReturnType<typeof mock>;
    getObservationsByIds?: ReturnType<typeof mock>;
  }) {
    return new SearchOrchestrator(
      {
        searchObservations: mocks.searchObservations ?? mock(() => []),
        searchSessions: mocks.searchSessions ?? mock(() => []),
        searchUserPrompts: mocks.searchUserPrompts ?? mock(() => []),
      } as any,
      {
        getObservationsByIds: mocks.getObservationsByIds ?? mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mocks.getUserPromptsByIds ?? mock(() => []),
      } as any,
      { queryChroma: mocks.queryChroma } as any,
    );
  }

  it('supplements empty observations from SQLite FTS when Chroma only returns prompts (CJK query)', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [7],
      distances: [0.1],
      metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt', created_at_epoch: Date.now() }],
    }));
    const searchObservations = mock(() => [observation]);
    const getUserPromptsByIds = mock(() => [userPrompt]);
    const orchestrator = buildOrchestrator({ queryChroma, searchObservations, getUserPromptsByIds });

    const result = await orchestrator.search({
      query: 'テスト',
      searchType: 'all',
      limit: 5,
    });

    expect(searchObservations).toHaveBeenCalledWith('テスト', expect.objectContaining({ limit: 5 }));
    expect(result.usedChroma).toBe(true);
    expect(result.strategy).toBe('hybrid');
    expect(result.results.observations).toEqual([observation]);
    expect(result.results.prompts).toEqual([userPrompt]);
  });

  it('keeps pure Chroma result untouched when every requested category has matches', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [7],
      distances: [0.1],
      metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt', created_at_epoch: Date.now() }],
    }));
    const searchUserPrompts = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);
    const orchestrator = buildOrchestrator({ queryChroma, searchUserPrompts, getUserPromptsByIds });

    const result = await orchestrator.search({
      query: 'テスト',
      searchType: 'prompts',
      limit: 5,
    });

    expect(searchUserPrompts).not.toHaveBeenCalled();
    expect(result.usedChroma).toBe(true);
    expect(result.strategy).toBe('chroma');
    expect(result.results.prompts).toEqual([userPrompt]);
  });

  it('does not supplement categories that were not requested', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [7],
      distances: [0.1],
      metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt', created_at_epoch: Date.now() }],
    }));
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);
    const orchestrator = buildOrchestrator({ queryChroma, searchObservations, searchSessions, getUserPromptsByIds });

    const result = await orchestrator.search({
      query: 'テスト',
      searchType: 'prompts',
      limit: 5,
    });

    expect(searchObservations).not.toHaveBeenCalled();
    expect(searchSessions).not.toHaveBeenCalled();
    expect(result.results.observations).toHaveLength(0);
  });

  it('keeps chroma strategy when supplement also finds nothing', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [7],
      distances: [0.1],
      metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt', created_at_epoch: Date.now() }],
    }));
    const searchObservations = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);
    const orchestrator = buildOrchestrator({ queryChroma, searchObservations, getUserPromptsByIds });

    const result = await orchestrator.search({
      query: 'テスト',
      searchType: 'all',
      limit: 5,
    });

    expect(searchObservations).toHaveBeenCalled();
    expect(result.usedChroma).toBe(true);
    expect(result.strategy).toBe('chroma');
    expect(result.results.prompts).toEqual([userPrompt]);
    expect(result.results.observations).toHaveLength(0);
  });

  it('applies the default 90-day recency window to supplement queries when no dateRange is given', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [7],
      distances: [0.1],
      metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt', created_at_epoch: Date.now() }],
    }));
    const searchObservations = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);
    const orchestrator = buildOrchestrator({ queryChroma, searchObservations, getUserPromptsByIds });

    const before = Date.now();
    await orchestrator.search({
      query: 'テスト',
      searchType: 'all',
      limit: 5,
    });
    const after = Date.now();

    expect(searchObservations).toHaveBeenCalledWith('テスト', expect.objectContaining({
      dateRange: expect.objectContaining({ start: expect.any(Number) }),
    }));
    const passedStart = (searchObservations.mock.calls[0] as any[])[1].dateRange.start;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(passedStart).toBeGreaterThanOrEqual(before - ninetyDaysMs);
    expect(passedStart).toBeLessThanOrEqual(after - ninetyDaysMs);
  });

  it('preserves an explicit dateRange in supplement queries', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [7],
      distances: [0.1],
      metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt', created_at_epoch: Date.now() }],
    }));
    const searchObservations = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);
    const orchestrator = buildOrchestrator({ queryChroma, searchObservations, getUserPromptsByIds });

    const dateRange = { start: 123, end: 456 };
    await orchestrator.search({
      query: 'テスト',
      searchType: 'all',
      limit: 5,
      dateRange,
    });

    expect(searchObservations).toHaveBeenCalledWith('テスト', expect.objectContaining({
      dateRange,
    }));
  });
});
