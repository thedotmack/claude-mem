import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SQLiteSearchStrategy } from '../../../../src/services/worker/search/strategies/SQLiteSearchStrategy.js';
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
  created_at_epoch: 1735732800000
};

const mockSession: SessionSummarySearchResult = {
  id: 1,
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
  created_at_epoch: 1735732800000
};

const mockPrompt: UserPromptSearchResult = {
  id: 1,
  content_session_id: 'content-session-123',
  prompt_number: 1,
  prompt_text: 'Test prompt text',
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: 1735732800000
};

describe('SQLiteSearchStrategy', () => {
  let strategy: SQLiteSearchStrategy;
  let mockSessionSearch: any;

  beforeEach(() => {
    mockSessionSearch = {
      searchObservations: mock(() => [mockObservation]),
      searchSessions: mock(() => [mockSession]),
      searchUserPrompts: mock(() => [mockPrompt]),
      findByFile: mock(() => ({ observations: [mockObservation], sessions: [mockSession] }))
    };
    strategy = new SQLiteSearchStrategy(mockSessionSearch);
  });

  describe('search', () => {
    it('should search all types by default', async () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(false);
      expect(result.strategy).toBe('sqlite');
      expect(result.results.observations).toHaveLength(1);
      expect(result.results.sessions).toHaveLength(1);
      expect(result.results.prompts).toHaveLength(1);
      expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
      expect(mockSessionSearch.searchSessions).toHaveBeenCalled();
      expect(mockSessionSearch.searchUserPrompts).toHaveBeenCalled();
    });

    it.each(['observations', 'sessions', 'prompts'] as const)('searches only %s', async searchType => {
      const result = await strategy.search({ searchType, limit: 10 });
      for (const [category, search] of [
        ['observations', mockSessionSearch.searchObservations],
        ['sessions', mockSessionSearch.searchSessions],
        ['prompts', mockSessionSearch.searchUserPrompts],
      ] as const) {
        const calls = category === searchType ? 1 : 0;
        expect(result.results[category]).toHaveLength(calls);
        expect(search).toHaveBeenCalledTimes(calls);
      }
    });

    it('should pass orderBy to search methods', async () => {
      const options: StrategySearchOptions = {
        orderBy: 'date_asc',
        limit: 10
      };

      await strategy.search(options);

      const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(callArgs[1].orderBy).toBe('date_asc');
    });

    it('should propagate search errors to the caller', async () => {
      mockSessionSearch.searchObservations = mock(() => {
        throw new Error('Database error');
      });

      const options: StrategySearchOptions = {
        limit: 10
      };

      await expect(strategy.search(options)).rejects.toThrow('Database error');
    });
  });

  describe('findByFile', () => {
    it('should pass filter options to findByFile', () => {
      const options: StrategySearchOptions = {
        limit: 25,
        project: 'file-project',
        dateRange: { end: '2025-12-31' },
        orderBy: 'date_desc'
      };

      strategy.findByFile('/src/index.ts', options);

      expect(mockSessionSearch.findByFile).toHaveBeenCalledWith('/src/index.ts', {
        limit: 25,
        project: 'file-project',
        dateRange: { end: '2025-12-31' },
        orderBy: 'date_desc'
      });
    });

    it('should pass platformSource to findByFile', () => {
      const options: StrategySearchOptions = {
        platformSource: 'cursor'
      };

      strategy.findByFile('/src/index.ts', options);

      expect(mockSessionSearch.findByFile).toHaveBeenCalledWith('/src/index.ts', expect.objectContaining({
        platformSource: 'cursor'
      }));
    });

  });
});
