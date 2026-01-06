import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { SQLiteSearchStrategy } from '../../../../src/services/worker/search/strategies/SQLiteSearchStrategy.js';
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
      findByConcept: mock(() => [mockObservation]),
      findByType: mock(() => [mockObservation]),
      findByFile: mock(() => ({ observations: [mockObservation], sessions: [mockSession] }))
    };
    strategy = new SQLiteSearchStrategy(mockSessionSearch);
  });

  describe('canHandle', () => {
    it('should return true when no query text (filter-only)', () => {
      const options: StrategySearchOptions = {
        project: 'test-project'
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return true when query is empty string', () => {
      const options: StrategySearchOptions = {
        query: '',
        project: 'test-project'
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return false when query text is present', () => {
      const options: StrategySearchOptions = {
        query: 'semantic search query'
      };
      expect(strategy.canHandle(options)).toBe(false);
    });

    it('should return true when strategyHint is sqlite (even with query)', () => {
      const options: StrategySearchOptions = {
        query: 'semantic search query',
        strategyHint: 'sqlite'
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return true for date range filter only', () => {
      const options: StrategySearchOptions = {
        dateRange: {
          start: '2025-01-01',
          end: '2025-01-31'
        }
      };
      expect(strategy.canHandle(options)).toBe(true);
    });
  });

  describe('search', () => {
    it('should search all types by default', async () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.search(options);

      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(false);
      expect(result.strategy).toBe('sqlite');
      expect(result.results.observations).toHaveLength(1);
      expect(result.results.sessions).toHaveLength(1);
      expect(result.results.prompts).toHaveLength(1);
      expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
      expect(mockSessionSearch.searchSessions).toHaveBeenCalled();
      expect(mockSessionSearch.searchUserPrompts).toHaveBeenCalled();
    });

    it('should search only observations when searchType is observations', async () => {
      const options: StrategySearchOptions = {
        searchType: 'observations',
        limit: 10
      };

      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(1);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
      expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
      expect(mockSessionSearch.searchSessions).not.toHaveBeenCalled();
      expect(mockSessionSearch.searchUserPrompts).not.toHaveBeenCalled();
    });

    it('should search only sessions when searchType is sessions', async () => {
      const options: StrategySearchOptions = {
        searchType: 'sessions',
        limit: 10
      };

      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(1);
      expect(result.results.prompts).toHaveLength(0);
    });

    it('should search only prompts when searchType is prompts', async () => {
      const options: StrategySearchOptions = {
        searchType: 'prompts',
        limit: 10
      };

      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(1);
    });

    it('should pass date range filter to search methods', async () => {
      const options: StrategySearchOptions = {
        dateRange: {
          start: '2025-01-01',
          end: '2025-01-31'
        },
        limit: 10
      };

      await strategy.search(options);

      const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(callArgs[1].dateRange).toEqual({
        start: '2025-01-01',
        end: '2025-01-31'
      });
    });

    it('should pass project filter to search methods', async () => {
      const options: StrategySearchOptions = {
        project: 'my-project',
        limit: 10
      };

      await strategy.search(options);

      const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(callArgs[1].project).toBe('my-project');
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

    it('should handle search errors gracefully', async () => {
      mockSessionSearch.searchObservations = mock(() => {
        throw new Error('Database error');
      });

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
      expect(result.usedChroma).toBe(false);
    });
  });

  describe('findByConcept', () => {
    it('should return matching observations (sync)', () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const results = strategy.findByConcept('test-concept', options);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(1);
      expect(mockSessionSearch.findByConcept).toHaveBeenCalledWith('test-concept', expect.any(Object));
    });

    it('should pass all filter options to findByConcept', () => {
      const options: StrategySearchOptions = {
        limit: 20,
        project: 'my-project',
        dateRange: { start: '2025-01-01' },
        orderBy: 'date_desc'
      };

      strategy.findByConcept('test-concept', options);

      expect(mockSessionSearch.findByConcept).toHaveBeenCalledWith('test-concept', {
        limit: 20,
        project: 'my-project',
        dateRange: { start: '2025-01-01' },
        orderBy: 'date_desc'
      });
    });

    it('should use default limit when not specified', () => {
      const options: StrategySearchOptions = {};

      strategy.findByConcept('test-concept', options);

      const callArgs = mockSessionSearch.findByConcept.mock.calls[0];
      expect(callArgs[1].limit).toBe(20); // SEARCH_CONSTANTS.DEFAULT_LIMIT
    });
  });

  describe('findByType', () => {
    it('should return typed observations (sync)', () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const results = strategy.findByType('decision', options);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('decision');
      expect(mockSessionSearch.findByType).toHaveBeenCalledWith('decision', expect.any(Object));
    });

    it('should handle array of types', () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      strategy.findByType(['decision', 'bugfix'], options);

      expect(mockSessionSearch.findByType).toHaveBeenCalledWith(['decision', 'bugfix'], expect.any(Object));
    });

    it('should pass filter options to findByType', () => {
      const options: StrategySearchOptions = {
        limit: 15,
        project: 'test-project',
        orderBy: 'date_asc'
      };

      strategy.findByType('feature', options);

      expect(mockSessionSearch.findByType).toHaveBeenCalledWith('feature', {
        limit: 15,
        project: 'test-project',
        orderBy: 'date_asc'
      });
    });
  });

  describe('findByFile', () => {
    it('should return observations and sessions for file path', () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = strategy.findByFile('/path/to/file.ts', options);

      expect(result.observations).toHaveLength(1);
      expect(result.sessions).toHaveLength(1);
      expect(mockSessionSearch.findByFile).toHaveBeenCalledWith('/path/to/file.ts', expect.any(Object));
    });

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
  });

  describe('strategy name', () => {
    it('should have name "sqlite"', () => {
      expect(strategy.name).toBe('sqlite');
    });
  });
});
