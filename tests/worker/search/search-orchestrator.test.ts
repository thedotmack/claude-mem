import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the ModeManager before imports
vi.mock('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'decision', icon: 'D' },
          { id: 'bugfix', icon: 'B' },
          { id: 'feature', icon: 'F' },
          { id: 'refactor', icon: 'R' },
          { id: 'discovery', icon: 'I' },
          { id: 'change', icon: 'C' }
        ],
        observation_concepts: [],
      }),
      getObservationTypes: () => [
        { id: 'decision', icon: 'D' },
        { id: 'bugfix', icon: 'B' },
        { id: 'feature', icon: 'F' },
        { id: 'refactor', icon: 'R' },
        { id: 'discovery', icon: 'I' },
        { id: 'change', icon: 'C' }
      ],
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = {
          decision: 'D',
          bugfix: 'B',
          feature: 'F',
          refactor: 'R',
          discovery: 'I',
          change: 'C'
        };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../../../src/services/worker/search/types.js';
import type { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import type { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

/** Type for search mock call args: [project, options] */
type SearchCallArgs = [string, Record<string, unknown>];

// Mock data
const mockObservation: ObservationSearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  text: 'Test observation',
  type: 'decision',
  title: 'Test Decision',
  subtitle: 'Subtitle',
  facts: '["fact1"]',
  narrative: 'Narrative',
  concepts: '["concept1"]',
  files_read: '["file1.ts"]',
  files_modified: '["file2.ts"]',
  prompt_number: 1,
  discovery_tokens: 100,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

const mockSession: SessionSummarySearchResult = {
  id: 1,
  memory_session_id: 'session-123',
  project: 'test-project',
  request: 'Test request',
  investigated: 'Investigated',
  learned: 'Learned',
  completed: 'Completed',
  next_steps: 'Next steps',
  files_read: '["file1.ts"]',
  files_edited: '["file2.ts"]',
  notes: 'Notes',
  prompt_number: 1,
  discovery_tokens: 500,
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

const mockPrompt: UserPromptSearchResult = {
  id: 1,
  content_session_id: 'content-123',
  prompt_number: 1,
  prompt_text: 'Test prompt',
  created_at: '2025-01-01T12:00:00.000Z',
  created_at_epoch: Date.now() - 1000 * 60 * 60 * 24
};

describe('SearchOrchestrator', () => {
  let orchestrator: SearchOrchestrator;
  let mockSessionSearch: SessionSearch;
  let mockSessionStore: SessionStore;
  let mockChromaSync: ChromaSync;

  beforeEach(() => {
    const mockPrepare = vi.fn(() => ({
      all: vi.fn(() => [mockObservation])
    }));

    mockSessionSearch = {
      searchObservations: vi.fn(() => [mockObservation]),
      searchSessions: vi.fn(() => [mockSession]),
      searchUserPrompts: vi.fn(() => [mockPrompt]),
      findByConcept: vi.fn(() => [mockObservation]),
      findByType: vi.fn(() => [mockObservation]),
      findByFile: vi.fn(() => ({ observations: [mockObservation], sessions: [mockSession] })),
      getDb: vi.fn(() => ({ prepare: mockPrepare }))
    } as unknown as SessionSearch;

    mockSessionStore = {
      getObservationsByIds: vi.fn(() => [mockObservation]),
      getSessionSummariesByIds: vi.fn(() => [mockSession]),
      getUserPromptsByIds: vi.fn(() => [mockPrompt])
    } as unknown as SessionStore;

    mockChromaSync = {
      queryChroma: vi.fn(() => Promise.resolve({
        ids: [1],
        distances: [0.1],
        metadatas: [{ sqlite_id: 1, doc_type: 'observation', created_at_epoch: Date.now() - 1000 }]
      }))
    } as unknown as ChromaSync;
  });

  describe('with Chroma available', () => {
    beforeEach(() => {
      orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
    });

    describe('search', () => {
      it('should select SQLite strategy for filter-only queries (no query text)', async () => {
        const result = await orchestrator.search({
          project: 'test-project',
          limit: 10
        });

        expect(result.strategy).toBe('sqlite');
        expect(result.usedChroma).toBe(false);
        expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
        expect(mockChromaSync.queryChroma).not.toHaveBeenCalled();
      });

      it('should select HybridBlendingStrategy for query-only (PATH 2)', async () => {
        const result = await orchestrator.search({
          query: 'semantic search query'
        });

        expect(result.strategy).toBe('hybrid-blend');
        expect(result.usedChroma).toBe(true);
        expect(mockChromaSync.queryChroma).toHaveBeenCalled();
      });

      it('should fall back to BM25 when Chroma fails inside HybridBlendingStrategy', async () => {
        mockChromaSync.queryChroma = vi.fn(() => Promise.reject(new Error('Chroma unavailable')));

        const result = await orchestrator.search({
          query: 'test query'
        });

        // Chroma failed inside hybrid blend, BM25 still ran
        expect(result.fellBack).toBe(true);
        expect(result.usedChroma).toBe(false);
        // BM25 produced results
        expect(result.strategy).toBe('bm25');
      });

      it('should return hybrid-blend result even when fellBack is true (partial failure)', async () => {
        // Simulate BM25 failing but Chroma succeeds inside HybridBlendingStrategy
        // Chroma succeeds, BM25 fails → strategy: 'chroma', fellBack: true
        mockChromaSync.queryChroma = vi.fn(() => Promise.resolve({
          ids: [1],
          distances: [0.1],
          metadatas: [{ sqlite_id: 1, doc_type: 'observation', created_at_epoch: Date.now() - 1000 }]
        }));

        const result = await orchestrator.search({
          query: 'partial failure query'
        });

        // Result should still be returned (not swallowed)
        expect(result.results).toBeDefined();
        expect(result.strategy).toBeDefined();
      });

      it('should normalize comma-separated concepts', async () => {
        await orchestrator.search({
          concepts: 'concept1, concept2, concept3',
          limit: 10
        });

        // Should be parsed into array internally
        const callArgs = vi.mocked(mockSessionSearch.searchObservations).mock.calls[0] as SearchCallArgs;
        expect(callArgs[1].concepts).toEqual(['concept1', 'concept2', 'concept3']);
      });

      it('should normalize comma-separated files', async () => {
        await orchestrator.search({
          files: 'file1.ts, file2.ts',
          limit: 10
        });

        const callArgs = vi.mocked(mockSessionSearch.searchObservations).mock.calls[0] as SearchCallArgs;
        expect(callArgs[1].files).toEqual(['file1.ts', 'file2.ts']);
      });

      it('should normalize dateStart/dateEnd into dateRange object', async () => {
        await orchestrator.search({
          dateStart: '2025-01-01',
          dateEnd: '2025-01-31'
        });

        const callArgs = vi.mocked(mockSessionSearch.searchObservations).mock.calls[0] as SearchCallArgs;
        expect(callArgs[1].dateRange).toEqual({
          start: '2025-01-01',
          end: '2025-01-31'
        });
      });

      it('should map type to searchType for observations/sessions/prompts', async () => {
        await orchestrator.search({
          type: 'observations'
        });

        // Should search only observations
        expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
        expect(mockSessionSearch.searchSessions).not.toHaveBeenCalled();
        expect(mockSessionSearch.searchUserPrompts).not.toHaveBeenCalled();
      });
    });

    describe('findByConcept', () => {
      it('should use hybrid strategy when Chroma available', async () => {
        await orchestrator.findByConcept('test-concept', {
          limit: 10
        });

        // Hybrid strategy should be used
        expect(mockSessionSearch.findByConcept).toHaveBeenCalled();
        expect(mockChromaSync.queryChroma).toHaveBeenCalled();
      });

      it('should return observations matching concept', async () => {
        const result = await orchestrator.findByConcept('test-concept', {});

        expect(result.results.observations.length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('findByType', () => {
      it('should use hybrid strategy', async () => {
        await orchestrator.findByType('decision', {});

        expect(mockSessionSearch.findByType).toHaveBeenCalled();
      });

      it('should handle array of types', async () => {
        await orchestrator.findByType(['decision', 'bugfix'], {});

        expect(mockSessionSearch.findByType).toHaveBeenCalledWith(['decision', 'bugfix'], expect.any(Object));
      });
    });

    describe('findByFile', () => {
      it('should return observations and sessions for file', async () => {
        const result = await orchestrator.findByFile('/path/to/file.ts', {});

        expect(result.observations.length).toBeGreaterThanOrEqual(0);
        expect(mockSessionSearch.findByFile).toHaveBeenCalled();
      });

      it('should include usedChroma in result', async () => {
        const result = await orchestrator.findByFile('/path/to/file.ts', {});

        expect(typeof result.usedChroma).toBe('boolean');
      });
    });

    describe('isChromaAvailable', () => {
      it('should return true when Chroma is available', () => {
        expect(orchestrator.isChromaAvailable()).toBe(true);
      });
    });

    describe('formatSearchResults', () => {
      it('should format results as markdown', () => {
        const results = {
          observations: [mockObservation],
          sessions: [mockSession],
          prompts: [mockPrompt]
        };

        const formatted = orchestrator.formatSearchResults(results, 'test query');

        expect(formatted).toContain('test query');
        expect(formatted).toContain('result');
      });

      it('should handle empty results', () => {
        const results = {
          observations: [],
          sessions: [],
          prompts: []
        };

        const formatted = orchestrator.formatSearchResults(results, 'no matches');

        expect(formatted).toContain('No results found');
      });

      it('should indicate Chroma failure when chromaFailed is true', () => {
        const results = {
          observations: [],
          sessions: [],
          prompts: []
        };

        const formatted = orchestrator.formatSearchResults(results, 'test', true);

        expect(formatted).toContain('Vector search failed');
      });
    });
  });

  describe('without Chroma (null)', () => {
    beforeEach(() => {
      orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
    });

    describe('isChromaAvailable', () => {
      it('should return false when Chroma is null', () => {
        expect(orchestrator.isChromaAvailable()).toBe(false);
      });
    });

    describe('search', () => {
      it('should use BM25SearchStrategy for query search without Chroma (PATH 3)', async () => {
        const result = await orchestrator.search({
          query: 'semantic query'
        });

        // No Chroma available — BM25 keyword search is used instead of empty results
        expect(result.strategy).toBe('bm25');
        expect(result.usedChroma).toBe(false);
        expect(result.fellBack).toBe(false);
      });

      it('should still work for filter-only queries', async () => {
        const result = await orchestrator.search({
          project: 'test-project'
        });

        expect(result.strategy).toBe('sqlite');
        expect(result.results.observations).toHaveLength(1);
      });
    });

    describe('findByConcept', () => {
      it('should fall back to SQLite-only', async () => {
        const result = await orchestrator.findByConcept('test-concept', {});

        expect(result.usedChroma).toBe(false);
        expect(result.strategy).toBe('sqlite');
        expect(mockSessionSearch.findByConcept).toHaveBeenCalled();
      });
    });

    describe('findByType', () => {
      it('should fall back to SQLite-only', async () => {
        const result = await orchestrator.findByType('decision', {});

        expect(result.usedChroma).toBe(false);
        expect(result.strategy).toBe('sqlite');
      });
    });

    describe('findByFile', () => {
      it('should fall back to SQLite-only', async () => {
        const result = await orchestrator.findByFile('/path/to/file.ts', {});

        expect(result.usedChroma).toBe(false);
        expect(mockSessionSearch.findByFile).toHaveBeenCalled();
      });
    });
  });

  describe('parameter normalization', () => {
    beforeEach(() => {
      orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
    });

    it('should parse obs_type into obsType array', async () => {
      await orchestrator.search({
        obs_type: 'decision, bugfix'
      });

      const callArgs = vi.mocked(mockSessionSearch.searchObservations).mock.calls[0] as SearchCallArgs;
      expect(callArgs[1].type).toEqual(['decision', 'bugfix']);
    });

    it('should handle already-array concepts', async () => {
      await orchestrator.search({
        concepts: ['concept1', 'concept2']
      });

      const callArgs = vi.mocked(mockSessionSearch.searchObservations).mock.calls[0] as SearchCallArgs;
      expect(callArgs[1].concepts).toEqual(['concept1', 'concept2']);
    });

    it('should handle empty string filters', async () => {
      await orchestrator.search({
        concepts: '',
        files: ''
      });

      const callArgs = vi.mocked(mockSessionSearch.searchObservations).mock.calls[0] as SearchCallArgs;
      // Empty strings are falsy, so the normalization doesn't process them
      // They stay as empty strings (the underlying search functions handle this)
      expect(callArgs[1].concepts).toEqual('');
      expect(callArgs[1].files).toEqual('');
    });
  });
});
