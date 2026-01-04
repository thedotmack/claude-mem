import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { HybridSearchStrategy } from '../../../../src/services/worker/search/strategies/HybridSearchStrategy.js';
import type { StrategySearchOptions, ObservationSearchResult, SessionSummarySearchResult } from '../../../../src/services/worker/search/types.js';

// Mock observation data
const mockObservation1: ObservationSearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  text: 'Test observation 1',
  type: 'decision',
  title: 'First Decision',
  subtitle: 'Subtitle 1',
  facts: '["fact1"]',
  narrative: 'Narrative 1',
  concepts: '["concept1"]',
  files_read: '["file1.ts"]',
  files_modified: '["file2.ts"]',
  prompt_number: 1,
  discovery_tokens: 100,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

const mockObservation2: ObservationSearchResult = {
  id: 2,
  memory_session_id: 'session-123',
  project: 'test-project',
  text: 'Test observation 2',
  type: 'bugfix',
  title: 'Second Bugfix',
  subtitle: 'Subtitle 2',
  facts: '["fact2"]',
  narrative: 'Narrative 2',
  concepts: '["concept2"]',
  files_read: '["file3.ts"]',
  files_modified: '["file4.ts"]',
  prompt_number: 2,
  discovery_tokens: 150,
  created_at: '2025-01-02T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24 * 2
};

const mockObservation3: ObservationSearchResult = {
  id: 3,
  memory_session_id: 'session-456',
  project: 'test-project',
  text: 'Test observation 3',
  type: 'feature',
  title: 'Third Feature',
  subtitle: 'Subtitle 3',
  facts: '["fact3"]',
  narrative: 'Narrative 3',
  concepts: '["concept3"]',
  files_read: '["file5.ts"]',
  files_modified: '["file6.ts"]',
  prompt_number: 3,
  discovery_tokens: 200,
  created_at: '2025-01-03T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24 * 3
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
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

describe('HybridSearchStrategy', () => {
  let strategy: HybridSearchStrategy;
  let mockChromaSync: any;
  let mockSessionStore: any;
  let mockSessionSearch: any;

  beforeEach(() => {
    mockChromaSync = {
      queryChroma: mock(() => Promise.resolve({
        ids: [2, 1, 3], // Chroma returns in semantic relevance order
        distances: [0.1, 0.2, 0.3],
        metadatas: []
      }))
    };

    mockSessionStore = {
      getObservationsByIds: mock((ids: number[]) => {
        // Return in the order we stored them (not Chroma order)
        const allObs = [mockObservation1, mockObservation2, mockObservation3];
        return allObs.filter(obs => ids.includes(obs.id));
      }),
      getSessionSummariesByIds: mock(() => [mockSession]),
      getUserPromptsByIds: mock(() => [])
    };

    mockSessionSearch = {
      findByConcept: mock(() => [mockObservation1, mockObservation2, mockObservation3]),
      findByType: mock(() => [mockObservation1, mockObservation2]),
      findByFile: mock(() => ({
        observations: [mockObservation1, mockObservation2],
        sessions: [mockSession]
      }))
    };

    strategy = new HybridSearchStrategy(mockChromaSync, mockSessionStore, mockSessionSearch);
  });

  describe('canHandle', () => {
    it('should return true when concepts filter is present', () => {
      const options: StrategySearchOptions = {
        concepts: ['test-concept']
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return true when files filter is present', () => {
      const options: StrategySearchOptions = {
        files: ['/path/to/file.ts']
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return true when type and query are present', () => {
      const options: StrategySearchOptions = {
        type: 'decision',
        query: 'semantic query'
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return true when strategyHint is hybrid', () => {
      const options: StrategySearchOptions = {
        strategyHint: 'hybrid'
      };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('should return false for query-only (no filters)', () => {
      const options: StrategySearchOptions = {
        query: 'semantic query'
      };
      expect(strategy.canHandle(options)).toBe(false);
    });

    it('should return false for filter-only without Chroma', () => {
      // Create strategy without Chroma
      const strategyNoChroma = new HybridSearchStrategy(null as any, mockSessionStore, mockSessionSearch);

      const options: StrategySearchOptions = {
        concepts: ['test-concept']
      };
      expect(strategyNoChroma.canHandle(options)).toBe(false);
    });
  });

  describe('search', () => {
    it('should return empty result for generic hybrid search without query', async () => {
      const options: StrategySearchOptions = {
        concepts: ['test-concept']
      };

      const result = await strategy.search(options);

      expect(result.results.observations).toHaveLength(0);
      expect(result.strategy).toBe('hybrid');
    });

    it('should return empty result for generic hybrid search (use specific methods)', async () => {
      const options: StrategySearchOptions = {
        query: 'test query'
      };

      const result = await strategy.search(options);

      // Generic search returns empty - use findByConcept/findByType/findByFile instead
      expect(result.results.observations).toHaveLength(0);
    });
  });

  describe('findByConcept', () => {
    it('should combine metadata + semantic results', async () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByConcept('test-concept', options);

      expect(mockSessionSearch.findByConcept).toHaveBeenCalledWith('test-concept', expect.any(Object));
      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith('test-concept', expect.any(Number));
      expect(result.usedChroma).toBe(true);
      expect(result.fellBack).toBe(false);
      expect(result.strategy).toBe('hybrid');
    });

    it('should preserve semantic ranking order from Chroma', async () => {
      // Chroma returns: [2, 1, 3] (obs 2 is most relevant)
      // SQLite returns: [1, 2, 3] (by date or however)
      // Result should be in Chroma order: [2, 1, 3]

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByConcept('test-concept', options);

      expect(result.results.observations.length).toBeGreaterThan(0);
      // The first result should be id=2 (Chroma's top result)
      expect(result.results.observations[0].id).toBe(2);
    });

    it('should only include observations that match both metadata and Chroma', async () => {
      // Metadata returns ids [1, 2, 3]
      // Chroma returns ids [2, 4, 5] (4 and 5 don't exist in metadata results)
      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [2, 4, 5],
        distances: [0.1, 0.2, 0.3],
        metadatas: []
      }));

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByConcept('test-concept', options);

      // Only id=2 should be in both sets
      expect(result.results.observations).toHaveLength(1);
      expect(result.results.observations[0].id).toBe(2);
    });

    it('should return empty when no metadata matches', async () => {
      mockSessionSearch.findByConcept = mock(() => []);

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByConcept('nonexistent-concept', options);

      expect(result.results.observations).toHaveLength(0);
      expect(mockChromaSync.queryChroma).not.toHaveBeenCalled(); // Should short-circuit
    });

    it('should fall back to metadata-only on Chroma error', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma failed')));

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByConcept('test-concept', options);

      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(true);
      expect(result.results.observations).toHaveLength(3); // All metadata results
    });
  });

  describe('findByType', () => {
    it('should find observations by type with semantic ranking', async () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByType('decision', options);

      expect(mockSessionSearch.findByType).toHaveBeenCalledWith('decision', expect.any(Object));
      expect(mockChromaSync.queryChroma).toHaveBeenCalled();
      expect(result.usedChroma).toBe(true);
    });

    it('should handle array of types', async () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      await strategy.findByType(['decision', 'bugfix'], options);

      expect(mockSessionSearch.findByType).toHaveBeenCalledWith(['decision', 'bugfix'], expect.any(Object));
      // Chroma query should use joined type string
      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith('decision, bugfix', expect.any(Number));
    });

    it('should preserve Chroma ranking order for types', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [2, 1], // Chroma order
        distances: [0.1, 0.2],
        metadatas: []
      }));

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByType('decision', options);

      expect(result.results.observations[0].id).toBe(2);
    });

    it('should fall back on Chroma error', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma unavailable')));

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByType('bugfix', options);

      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(true);
      expect(result.results.observations.length).toBeGreaterThan(0);
    });

    it('should return empty when no metadata matches', async () => {
      mockSessionSearch.findByType = mock(() => []);

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByType('nonexistent', options);

      expect(result.results.observations).toHaveLength(0);
    });
  });

  describe('findByFile', () => {
    it('should find observations and sessions by file path', async () => {
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByFile('/path/to/file.ts', options);

      expect(mockSessionSearch.findByFile).toHaveBeenCalledWith('/path/to/file.ts', expect.any(Object));
      expect(result.observations.length).toBeGreaterThanOrEqual(0);
      expect(result.sessions).toHaveLength(1);
    });

    it('should return sessions without semantic ranking', async () => {
      // Sessions are already summarized, no need for semantic ranking
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByFile('/path/to/file.ts', options);

      // Sessions should come directly from metadata search
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe(1);
    });

    it('should apply semantic ranking only to observations', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [2, 1], // Chroma ranking for observations
        distances: [0.1, 0.2],
        metadatas: []
      }));

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByFile('/path/to/file.ts', options);

      // Observations should be in Chroma order
      expect(result.observations[0].id).toBe(2);
      expect(result.usedChroma).toBe(true);
    });

    it('should return usedChroma: false when no observations to rank', async () => {
      mockSessionSearch.findByFile = mock(() => ({
        observations: [],
        sessions: [mockSession]
      }));

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByFile('/path/to/file.ts', options);

      expect(result.usedChroma).toBe(false);
      expect(result.sessions).toHaveLength(1);
    });

    it('should fall back on Chroma error', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma down')));

      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByFile('/path/to/file.ts', options);

      expect(result.usedChroma).toBe(false);
      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.sessions).toHaveLength(1);
    });
  });

  describe('strategy name', () => {
    it('should have name "hybrid"', () => {
      expect(strategy.name).toBe('hybrid');
    });
  });
});
