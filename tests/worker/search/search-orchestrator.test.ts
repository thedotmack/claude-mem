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

describe('SearchOrchestrator Chroma zero fallback', () => {
  it('normalizes date_from/date_to filters into dateRange for SQLite search', async () => {
    const searchObservations = mock(() => [observation]);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
    );

    const result = await orchestrator.search({
      searchType: 'observations',
      date_from: '2025-01-01',
      date_to: '2025-01-31',
    });

    expect(searchObservations).toHaveBeenCalledWith(undefined, expect.objectContaining({
      dateRange: {
        start: '2025-01-01',
        end: '2025-01-31',
      },
    }));
    expect(result.usedChroma).toBe(false);
    expect(result.strategy).toBe('sqlite');
    expect(result.results.observations).toEqual([observation]);
  });

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

    expect(searchObservations).toHaveBeenCalledWith('legacy docs', expect.objectContaining({
      project: 'orchestrator-project',
    }));
    expect(result.usedChroma).toBe(false);
    expect(result.strategy).toBe('sqlite');
    expect(result.results.observations).toEqual([observation]);
  });

  it('keeps non-empty Chroma matches final', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [21],
      distances: [0.1],
      metadatas: [{ sqlite_id: 21, doc_type: 'observation', created_at_epoch: Date.now() }],
    }));
    const searchObservations = mock(() => [observation]);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {
        getObservationsByIds: mock(() => [observation]),
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
    expect(result.results.observations).toEqual([observation]);
  });
});

/**
 * Regression coverage for #4284: when chromaSync is null at construction time
 * (the common case on Windows when `cmd.exe /c uvx` argv quoting prevents
 * chroma-mcp from connecting, and any install where Chroma initialization
 * fails silently), `executeWithFallback` must run the SQLite/FTS5 strategy
 * for queries instead of returning a confident empty result. Before the
 * fix this branch returned `{observations:[], sessions:[], prompts:[]}`
 * for every query, so 497 observations in SQLite never surfaced.
 */
describe('SearchOrchestrator chromaSync=null fallback (#4284)', () => {
  it('runs SQLite strategy for a query when chromaSync is null and SQLite returns matches', async () => {
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions,
        searchUserPrompts,
      } as any,
      {} as any,
      null,
    );

    const result = await orchestrator.search({
      query: 'cursor sqlite fallback',
      searchType: 'observations',
      project: 'orchestrator-project',
      limit: 5,
    });

    expect(searchObservations).toHaveBeenCalledWith('cursor sqlite fallback', expect.objectContaining({
      project: 'orchestrator-project',
      limit: 5,
    }));
    expect(result.usedChroma).toBe(false);
    expect(result.strategy).toBe('sqlite');
    expect(result.results.observations).toEqual([observation]);
    expect(result.results.sessions).toEqual([]);
    expect(result.results.prompts).toEqual([]);
  });

  it('returns strategy=sqlite empty result (not the confident-empty bug) when SQLite has no matches', async () => {
    const searchObservations = mock(() => []);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
    );

    const result = await orchestrator.search({
      query: 'anything-not-in-the-database',
      searchType: 'observations',
      project: 'orchestrator-project',
      limit: 5,
    });

    expect(searchObservations).toHaveBeenCalledTimes(1);
    expect(result.usedChroma).toBe(false);
    expect(result.strategy).toBe('sqlite');
    expect(result.results.observations).toEqual([]);
    expect(result.results.sessions).toEqual([]);
    expect(result.results.prompts).toEqual([]);
  });

  it('does not call any chroma sync methods when chromaSync is null', async () => {
    // Mirrors the Windows install scenario: chromaSync is never wired up
    // because the chroma-mcp subprocess never connects.
    const searchObservations = mock(() => [observation]);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
    );

    await orchestrator.search({
      query: 'cursor sqlite fallback',
      searchType: 'observations',
      project: 'orchestrator-project',
      limit: 5,
    });

    // sqliteStrategy is the only collaborator touched.
    expect(searchObservations).toHaveBeenCalledTimes(1);
  });

  it('forwards query text to SQLite when chromaSync is null and searchType=all', async () => {
    const searchObservations = mock(() => [observation]);
    const searchSessions = mock(() => []);
    const searchUserPrompts = mock(() => []);
    const orchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions,
        searchUserPrompts,
      } as any,
      {} as any,
      null,
    );

    const result = await orchestrator.search({
      query: 'cursor sqlite fallback',
      searchType: 'all',
      project: 'orchestrator-project',
      limit: 5,
    });

    expect(searchObservations).toHaveBeenCalledWith('cursor sqlite fallback', expect.objectContaining({
      project: 'orchestrator-project',
    }));
    expect(searchSessions).toHaveBeenCalledWith('cursor sqlite fallback', expect.anything());
    expect(searchUserPrompts).toHaveBeenCalledWith('cursor sqlite fallback', expect.anything());
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


  it('does not narrow the SQLite supplement to a recency window when no dateRange is given', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [7],
      distances: [0.1],
      metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt', created_at_epoch: Date.now() }],
    }));
    const searchObservations = mock(() => []);
    const getUserPromptsByIds = mock(() => [userPrompt]);
    const orchestrator = buildOrchestrator({ queryChroma, searchObservations, getUserPromptsByIds });

    await orchestrator.search({
      query: 'テスト',
      searchType: 'all',
      limit: 5,
    });

    const supplementOptions = (searchObservations.mock.calls[0] as any[])[1];
    expect(supplementOptions.dateRange).toBeUndefined();
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