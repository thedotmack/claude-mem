import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ChromaSearchStrategy } from '../../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import type { StrategySearchOptions, ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../../../../src/services/worker/search/types.js';

// Mock observation data
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
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24 // 1 day ago
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
    const recentEpoch = Date.now() - 1000 * 60 * 60 * 24; // 1 day ago (within 90-day window)

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
      getUserPromptsByIds: mock(() => [mockPrompt])
    };

    strategy = new ChromaSearchStrategy(mockChromaSync, mockSessionStore);
  });

  describe('canHandle', () => {
    it('should return true when query text is present', () => {
      const options: StrategySearchOptions = {
        query: 'semantic search query'
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return false for filter-only (no query)', () => {
      const options: StrategySearchOptions = {
        project: 'test-project'
      };
      expect(strategy.canHandle(options)).toBe(false);
    });

    it('should return false when query is empty string', () => {
      const options: StrategySearchOptions = {
        query: ''
      };
      expect(strategy.canHandle(options)).toBe(false);
    });

    it('should return false when query is undefined', () => {
      const options: StrategySearchOptions = {};
      expect(strategy.canHandle(options)).toBe(false);
    });
  });

  describe('search', () => {
    it('should call Chroma with query text', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        limit: 10
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100, // CHROMA_BATCH_SIZE
        undefined // no where filter for 'all'
      );
    });

    it('should return usedChroma: true on success', async () => {
      const options: StrategySearchOptions = {
        query: 'test query'
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(true);
      expect(result.fellBack).toBe(false);
      expect(result.strategy).toBe('chroma');
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

    it('should filter by doc_type when searchType is observations', async () => {
      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      await strategy.search(options);

      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith(
        'test query',
        100,
        { doc_type: 'observation' }
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
        { doc_type: 'session_summary' }
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
        { doc_type: 'user_prompt' }
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
      expect(result.usedChroma).toBe(true); // Still used Chroma, just no results
    });

    it('should filter out old results (beyond 90-day window)', async () => {
      const oldEpoch = Date.now() - 1000 * 60 * 60 * 24 * 100; // 100 days ago

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

      // Old results should be filtered out
      expect(mockSessionStore.getObservationsByIds).not.toHaveBeenCalled();
    });

    it('should handle Chroma errors gracefully (returns usedChroma: false)', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma connection failed')));

      const options: StrategySearchOptions = {
        query: 'test query'
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
    });

    it('should handle SQLite hydration errors gracefully', async () => {
      mockSessionStore.getObservationsByIds = mock(() => {
        throw new Error('SQLite error');
      });

      const options: StrategySearchOptions = {
        query: 'test query',
        searchType: 'observations'
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(false); // Error occurred
      expect(result.results.observations).toHaveLength(0);
    });
  });

  describe('strategy name', () => {
    it('should have name "chroma"', () => {
      expect(strategy.name).toBe('chroma');
    });
  });
});
