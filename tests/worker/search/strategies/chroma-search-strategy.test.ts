import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ChromaSearchStrategy } from '../../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import { parseSearchRecencyWindowMs } from '../../../../src/services/worker/search/types.js';
import type { StrategySearchOptions, ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../../../../src/services/worker/search/types.js';

const mockObservation: ObservationSearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  text: 'Test observation text',
  type: 'decision',
  title: 'Test Decision',
  subtitle: 'A test subtitle',
  facts: '["fact1", "fact2"]',
  narrative: 'Test narrative',
  concepts: '["concept1", "concept2"]',
  files_read: '["file1.ts"]',
  files_modified: '["file2.ts"]',
  prompt_number: 1,
  discovery_tokens: 100,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24 
};

const mockSession: SessionSummarySearchResult = {
  id: 2,
  memory_session_id: 'session-123',
  project: 'test-project',
  request: 'Test request',
  investigated: 'Test investigated',
  learned: 'Test learned',
  completed: 'Test completed',
  next_steps: 'Test next steps',
  files_read: '["file1.ts"]',
  files_edited: '["file2.ts"]',
  notes: 'Test notes',
  prompt_number: 1,
  discovery_tokens: 500,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

const mockPrompt: UserPromptSearchResult = {
  id: 3,
  content_session_id: 'content-session-123',
  prompt_number: 1,
  prompt_text: 'Test prompt text',
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

describe('ChromaSearchStrategy', () => {
  let strategy: ChromaSearchStrategy;
  let mockChromaSync: any;
  let mockSessionStore: any;

  beforeEach(() => {
    const recentEpoch = Date.now() - 1000 * 60 * 60 * 24; 

    mockChromaSync = {
      queryChroma: mock(() => Promise.resolve({
        ids: [1, 2, 3],
        distances: [0.1, 0.2, 0.3],
        metadatas: [
          { sqlite_id: 1, doc_type: 'observation', created_at_epoch: recentEpoch },
          { sqlite_id: 2, doc_type: 'session_summary', created_at_epoch: recentEpoch },
          { sqlite_id: 3, doc_type: 'user_prompt', created_at_epoch: recentEpoch }
        ]
      }))
    };

    mockSessionStore = {
      getObservationsByIds: mock(() => [mockObservation]),
      getSessionSummariesByIds: mock(() => [mockSession]),
      getUserPromptsByIds: mock(() => [mockPrompt]),
      getProjectReadKeys: mock((projects: string[]) => projects)
    };

    strategy = new ChromaSearchStrategy(mockChromaSync, mockSessionStore);
  });

  describe('search', () => {
    it('retains an explicit corpus budget larger than the interactive widening cap', async () => {
      const rows = Array.from({ length: 1700 }, (_, index) => ({ ...mockObservation, id: index + 1 }));
      mockChromaSync.queryChroma = mock((_query: string, limit: number) => Promise.resolve({
        ids: rows.slice(0, limit).map(row => row.id),
        distances: rows.slice(0, limit).map(() => 0.1),
        metadatas: rows.slice(0, limit).map(row => ({ doc_type: 'observation', created_at_epoch: row.created_at_epoch })),
      }));
      mockSessionStore.getObservationsByIds = mock((ids: number[]) => ids.map(id => rows[id - 1]));
      const result = await strategy.search({ query: 'semantic corpus', searchType: 'observations', limit: 1700 });
      expect(result.results.observations).toHaveLength(1700);
      expect(mockChromaSync.queryChroma).toHaveBeenCalledTimes(1);
    });

    it('should call Chroma with query text', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        limit: 10
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100, // CHROMA_BATCH_SIZE
        undefined,
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should return usedChroma: true on success', async () => {
      const options: StrategySearchOptions = {
        query: 'test query'
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(true);
      expect(result.strategy).toBe('chroma');
    });

    it('should preserve requested date ordering in SQLite hydration', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        orderBy: 'date_asc',
        limit: 10
      };

      await strategy.search(options);

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith([1], expect.objectContaining({
        orderBy: 'date_asc'
      }));
      expect(mockSessionStore.getSessionSummariesByIds).toHaveBeenCalledWith([2], expect.objectContaining({
        orderBy: 'date_asc'
      }));
      expect(mockSessionStore.getUserPromptsByIds).toHaveBeenCalledWith([3], expect.objectContaining({
        orderBy: 'date_asc'
      }));
    });

    it('should hydrate observations from SQLite', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      const result = await strategy.search(options);

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalled();
      expect(result.results.observations).toHaveLength(1);
    });

    it('should hydrate sessions from SQLite', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'sessions'
      };

      await strategy.search(options);

      expect(mockSessionStore.getSessionSummariesByIds).toHaveBeenCalled();
    });

    it('should hydrate prompts from SQLite', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'prompts'
      };

      await strategy.search(options);

      expect(mockSessionStore.getUserPromptsByIds).toHaveBeenCalled();
    });

    it('should pass platformSource through all SQLite hydration calls', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        platformSource: 'cursor',
        limit: 10
      };

      await strategy.search(options);

      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith([1], expect.objectContaining({
        platformSource: 'cursor'
      }));
      expect(mockSessionStore.getSessionSummariesByIds).toHaveBeenCalledWith([2], expect.objectContaining({
        platformSource: 'cursor'
      }));
      expect(mockSessionStore.getUserPromptsByIds).toHaveBeenCalledWith([3], expect.objectContaining({
        platformSource: 'cursor'
      }));
    });

    it('should filter by doc_type when searchType is observations', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { doc_type: 'observation' },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should filter by doc_type when searchType is sessions', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'sessions'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { doc_type: 'session_summary' },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should filter by doc_type when searchType is prompts', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'prompts'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { doc_type: 'user_prompt' },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should include project in Chroma where clause when specified', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        project: 'my-project'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { $or: [{ project: 'my-project' }, { merged_into_project: 'my-project' }] },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should scope the project to every key it reads, in Chroma and in the hydration (#3531, gate P2-5)', async () => {
      mockSessionStore.getProjectReadKeys = mock(() => ['my-project', 'My-Project', 'old-folder']);
      const options: StrategySearchOptions = {
        query: 'test query',
        project: 'my-project'
      };

      await strategy.search(options);

      const readKeys = ['my-project', 'My-Project', 'old-folder'];
      expect(mockSessionStore.getProjectReadKeys).toHaveBeenCalledWith(['my-project']);
      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { $or: [{ project: { $in: readKeys } }, { merged_into_project: { $in: readKeys } }] },
        expect.any(Object),
        expect.any(Function)
      );
      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith([1], expect.objectContaining({ projects: readKeys }));
    });

    it('should combine doc_type and project with $and when both specified', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations',
        project: 'my-project'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { $and: [{ doc_type: 'observation' }, { $or: [{ project: 'my-project' }, { merged_into_project: 'my-project' }] }] },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should include platformSource in Chroma where clause when specified', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        platformSource: 'cursor'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { platform_source: 'cursor' },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should combine doc_type, project, and platformSource with $and when specified', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations',
        project: 'my-project',
        platformSource: 'cursor'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { $and: [{ doc_type: 'observation' }, { $or: [{ project: 'my-project' }, { merged_into_project: 'my-project' }] }, { platform_source: 'cursor' }] },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('lists the scope rows for a filtered fallback once per search, across widened windows (#5091)', async () => {
      mockSessionStore.getSearchScopeRowIds = mock(() => [1, 4]);
      const listed: Array<number[] | null> = [];
      mockChromaSync.queryChroma = mock((_query: string, _limit: number, _where: unknown, progress: { exhausted?: boolean },
        rowIds: (maxIds: number) => number[] | null) => {
        // Every window falls back, so every window asks for the rows.
        listed.push(rowIds(5000));
        progress.exhausted = false;
        return Promise.resolve({ ids: [], distances: [], metadatas: [] });
      });

      await strategy.search({ query: 'test query', searchType: 'observations', project: 'my-project', platformSource: 'cursor' });

      expect(mockChromaSync.queryChroma.mock.calls.length).toBeGreaterThan(1);
      expect(listed.every(ids => ids?.join() === '1,4')).toBe(true);
      expect(mockSessionStore.getSearchScopeRowIds).toHaveBeenCalledTimes(1);
      expect(mockSessionStore.getSearchScopeRowIds).toHaveBeenCalledWith(
        { observations: true, sessions: false, prompts: false },
        expect.objectContaining({ project: 'my-project', projects: ['my-project'], platformSource: 'cursor' }),
        5000
      );
    });

    it('should not include project filter when project is not specified', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { doc_type: 'observation' },
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should return empty result when no query provided', async () => {
      const options: StrategySearchOptions = {
        query: undefined
      };

      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
      expect(mockChromaSync.queryChroma).not.toHaveBeenCalled();
    });

    it('should return empty result when Chroma returns no matches', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [],
        distances: [],
        metadatas: []
      }));

      const options: StrategySearchOptions = {
        query: 'no matches query'
      };

      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(0);
      expect(result.usedChroma).toBe(true); 
    });

    it('should filter out old results (beyond 90-day window)', async () => {
      const oldEpoch = Date.now() - 1000 * 60 * 60 * 24 * 100; 

      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [1],
        distances: [0.1],
        metadatas: [
          { sqlite_id: 1, doc_type: 'observation', created_at_epoch: oldEpoch }
        ]
      }));

      const options: StrategySearchOptions = {
        query: 'old data query'
      };

      const result = await strategy.search(options);

      expect(mockSessionStore.getObservationsByIds).not.toHaveBeenCalled();
    });

    it('should propagate Chroma errors (fail-fast, no silent fallback)', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma connection failed')));

      const options: StrategySearchOptions = {
        query: 'test query'
      };

      await expect(strategy.search(options)).rejects.toThrow('Chroma connection failed');
    });

    it('should propagate SQLite hydration errors (fail-fast)', async () => {
      mockSessionStore.getObservationsByIds = mock(() => {
        throw new Error('SQLite error');
      });

      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      await expect(strategy.search(options)).rejects.toThrow('SQLite error');
    });

    it('should correctly align IDs with metadatas when Chroma returns duplicate sqlite_ids (multiple docs per observation)', async () => {
      const recentEpoch = Date.now() - 1000 * 60 * 60 * 24; 

      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [100, 200],  // Deduplicated
        distances: [0.3, 0.4, 0.5, 0.6],  // Original 4 distances
        metadatas: [
          { sqlite_id: 100, doc_type: 'observation', created_at_epoch: recentEpoch },
          { sqlite_id: 100, doc_type: 'observation', created_at_epoch: recentEpoch },
          { sqlite_id: 100, doc_type: 'observation', created_at_epoch: recentEpoch },
          { sqlite_id: 200, doc_type: 'observation', created_at_epoch: recentEpoch }
        ]
      }));

      const mockObs100 = { ...mockObservation, id: 100 };
      const mockObs200 = { ...mockObservation, id: 200, title: 'Second observation' };
      mockSessionStore.getObservationsByIds = mock((ids: number[]) => {
        return ids.map(id => id === 100 ? mockObs100 : mockObs200);
      });

      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(true);
      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalled();

      const calledWith = mockSessionStore.getObservationsByIds.mock.calls[0][0];
      expect(calledWith).toContain(100);
      expect(calledWith).toContain(200);
      expect(calledWith.length).toBe(2); 
    });

    it('should handle misaligned arrays gracefully without undefined access', async () => {
      const recentEpoch = Date.now() - 1000 * 60 * 60 * 24;

      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [100],  // Only 1 ID after deduplication
        distances: [0.3, 0.4, 0.5],  // 3 distances
        metadatas: [
          { sqlite_id: 100, doc_type: 'observation', created_at_epoch: recentEpoch },
          { sqlite_id: 100, doc_type: 'observation', created_at_epoch: recentEpoch },
          { sqlite_id: 100, doc_type: 'observation', created_at_epoch: recentEpoch }
        ]  
      }));

      mockSessionStore.getObservationsByIds = mock(() => [mockObservation]);

      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(true);
      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalled();
      const calledWith = mockSessionStore.getObservationsByIds.mock.calls[0][0];
      expect(calledWith).toEqual([100]);
    });
  });

  // The implicit window date-less searches apply (#4770). filterByRecency is
  // a pure function over the aligned {ids, metadatas} arrays Chroma returns,
  // so these cases run fully offline against constructed arrays.
  describe('default recency window (#4770)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    interface Hit { id: number; docType: string; ageDays: number }

    function makeResults(hits: Hit[]) {
      const now = Date.now();
      return {
        ids: hits.map(hit => hit.id),
        metadatas: hits.map(hit => ({
          sqlite_id: hit.id,
          doc_type: hit.docType,
          created_at_epoch: now - hit.ageDays * DAY_MS
        }))
      };
    }

    function strategyWithWindow(defaultRecencyWindowMs?: number): ChromaSearchStrategy {
      const chromaSync: any = { queryChroma: mock(() => Promise.resolve({ ids: [], distances: [], metadatas: [] })) };
      const sessionStore: any = {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => []),
        getProjectReadKeys: mock((projects: string[]) => projects)
      };
      return defaultRecencyWindowMs === undefined
        ? new ChromaSearchStrategy(chromaSync, sessionStore)
        : new ChromaSearchStrategy(chromaSync, sessionStore, defaultRecencyWindowMs);
    }

    const survivingIds = (strategy: ChromaSearchStrategy, hits: Hit[], dateRange?: any, ignoreWindow?: boolean) => {
      const kept = (strategy as any).filterByRecency(makeResults(hits), dateRange, ignoreWindow ?? false);
      return kept.map((item: { id: number }) => item.id);
    };

    it('keeps the shipped 90-day window when no window is configured', () => {
      const strategy = strategyWithWindow();
      const kept = survivingIds(strategy, [
        { id: 1, docType: 'observation', ageDays: 1 },
        { id: 2, docType: 'observation', ageDays: 91 }
      ]);
      expect(kept).toEqual([1]);
    });

    it('drops the window entirely when configured with 0 days', () => {
      const strategy = strategyWithWindow(0);
      const kept = survivingIds(strategy, [
        { id: 1, docType: 'observation', ageDays: 1 },
        { id: 2, docType: 'observation', ageDays: 365 }
      ]);
      expect(kept).toEqual([1, 2]);
    });

    it('honors a custom window of N days', () => {
      const strategy = strategyWithWindow(30 * DAY_MS);
      const kept = survivingIds(strategy, [
        { id: 1, docType: 'observation', ageDays: 10 },
        { id: 2, docType: 'observation', ageDays: 31 }
      ]);
      expect(kept).toEqual([1]);
    });

    it('applies an explicit dateRange instead of the configured window', () => {
      const strategy = strategyWithWindow(30 * DAY_MS);
      const now = Date.now();
      const kept = survivingIds(
        strategy,
        [
          { id: 1, docType: 'observation', ageDays: 1 },
          { id: 2, docType: 'observation', ageDays: 200 }
        ],
        { start: now - 300 * DAY_MS, end: now }
      );
      // The 200-day-old hit fails the 30-day window but sits inside the
      // requested range, so the range — not the window — decided.
      expect(kept).toEqual([1, 2]);
    });

    it('still bypasses the window for corpus builds (ignoreDefaultRecencyWindow)', () => {
      const strategy = strategyWithWindow(30 * DAY_MS);
      const kept = survivingIds(
        strategy,
        [{ id: 1, docType: 'observation', ageDays: 365 }],
        undefined,
        true
      );
      expect(kept).toEqual([1]);
    });
  });

  describe('parseSearchRecencyWindowMs (#4770)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('keeps the 90-day default for an absent or empty value', () => {
      expect(parseSearchRecencyWindowMs(undefined)).toBe(90 * DAY_MS);
      expect(parseSearchRecencyWindowMs('')).toBe(90 * DAY_MS);
      expect(parseSearchRecencyWindowMs('  ')).toBe(90 * DAY_MS);
    });

    it('parses 0 as "window disabled"', () => {
      expect(parseSearchRecencyWindowMs('0')).toBe(0);
      expect(parseSearchRecencyWindowMs(' 0 ')).toBe(0);
    });

    it('parses a positive integer of days to milliseconds', () => {
      expect(parseSearchRecencyWindowMs('30')).toBe(30 * DAY_MS);
      expect(parseSearchRecencyWindowMs(' 365 ')).toBe(365 * DAY_MS);
    });

    it('rejects malformed values with null (caller keeps the default)', () => {
      expect(parseSearchRecencyWindowMs('abc')).toBe(null);
      expect(parseSearchRecencyWindowMs('1.5')).toBe(null);
      expect(parseSearchRecencyWindowMs('-3')).toBe(null);
      expect(parseSearchRecencyWindowMs('NaN')).toBe(null);
    });

    // settings.json is hand-editable JSON and SettingsDefaultsManager leaves
    // JSON numbers untouched, so a hand-written `0` arrives here as a real
    // number; these must parse like their string spelling, not throw.
    it('parses JSON-numeric values like their string spelling', () => {
      expect(parseSearchRecencyWindowMs(0)).toBe(0);
      expect(parseSearchRecencyWindowMs(30)).toBe(30 * DAY_MS);
      expect(parseSearchRecencyWindowMs(90)).toBe(90 * DAY_MS);
    });

    it('rejects malformed numeric values with null (caller keeps the default)', () => {
      expect(parseSearchRecencyWindowMs(-3)).toBe(null);
      expect(parseSearchRecencyWindowMs(1.5)).toBe(null);
    });

    it('rejects null and other non-string types with null (caller keeps the default)', () => {
      expect(parseSearchRecencyWindowMs(null)).toBe(null);
      expect(parseSearchRecencyWindowMs(false)).toBe(null);
      expect(parseSearchRecencyWindowMs({ days: 30 })).toBe(null);
      expect(parseSearchRecencyWindowMs(['30'])).toBe(null);
    });
  });
});
