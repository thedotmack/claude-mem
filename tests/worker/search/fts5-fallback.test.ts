import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the ModeManager before imports
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [],
        observation_concepts: [],
      }),
      getObservationTypes: () => [],
      getTypeIcon: () => '?',
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import type { ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult } from '../../../src/services/worker/search/types.js';

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

describe('FTS5 Fallback - SearchOrchestrator', () => {
  let mockSessionSearch: any;
  let mockSessionStore: any;
  let mockChromaSync: any;

  beforeEach(() => {
    mockSessionSearch = {
      searchObservations: mock(() => [mockObservation]),
      searchSessions: mock(() => [mockSession]),
      searchUserPrompts: mock(() => [mockPrompt]),
      findByConcept: mock(() => [mockObservation]),
      findByType: mock(() => [mockObservation]),
      findByFile: mock(() => ({ observations: [mockObservation], sessions: [mockSession] }))
    };

    mockSessionStore = {
      getObservationsByIds: mock(() => [mockObservation]),
      getSessionSummariesByIds: mock(() => [mockSession]),
      getUserPromptsByIds: mock(() => [mockPrompt])
    };

    mockChromaSync = {
      queryChroma: mock(() => Promise.resolve({
        ids: [1],
        distances: [0.1],
        metadatas: [{ sqlite_id: 1, doc_type: 'observation', created_at_epoch: Date.now() - 1000 }]
      }))
    };
  });

  describe('FTS5 fallback when Chroma fails', () => {
    it('should fall back to FTS5 when Chroma throws an error', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma connection failed')));

      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      const result = await orchestrator.search({
        query: 'test query',
        project: 'test-project'
      });

      // Should have fallen back
      expect(result.fellBack).toBe(true);
      expect(result.usedChroma).toBe(false);
      expect(result.searchMethod).toBe('fts5-fallback');

      // Should have called SessionSearch with the query text (FTS5)
      expect(mockSessionSearch.searchObservations).toHaveBeenCalledWith(
        'test query',
        expect.any(Object)
      );
    });

    it('should maintain the same response shape on fallback', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma unavailable')));

      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      const result = await orchestrator.search({
        query: 'test query',
        project: 'test-project'
      });

      // Response shape should be identical to normal search
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('usedChroma');
      expect(result).toHaveProperty('fellBack');
      expect(result).toHaveProperty('strategy');
      expect(result).toHaveProperty('searchMethod');
      expect(result.results).toHaveProperty('observations');
      expect(result.results).toHaveProperty('sessions');
      expect(result.results).toHaveProperty('prompts');
    });

    it('should return FTS5 results (not empty) when Chroma fails', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Connection closed')));

      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      const result = await orchestrator.search({
        query: 'test query',
        project: 'test-project'
      });

      // Should have actual results from FTS5 fallback
      expect(result.results.observations.length).toBeGreaterThan(0);
    });

    it('should set searchMethod to "chroma" when Chroma succeeds', async () => {
      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      const result = await orchestrator.search({
        query: 'test query'
      });

      expect(result.searchMethod).toBe('chroma');
      expect(result.usedChroma).toBe(true);
      expect(result.fellBack).toBe(false);
    });
  });

  describe('FTS5 fallback when Chroma is null (not available)', () => {
    it('should use FTS5 when Chroma is null and query is present', async () => {
      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
      const result = await orchestrator.search({
        query: 'semantic query'
      });

      // Should fall back to FTS5 instead of returning empty results
      expect(result.fellBack).toBe(true);
      expect(result.searchMethod).toBe('fts5-fallback');
      expect(result.usedChroma).toBe(false);

      // Should have called SessionSearch with the query text
      expect(mockSessionSearch.searchObservations).toHaveBeenCalledWith(
        'semantic query',
        expect.any(Object)
      );
    });

    it('should return actual results from FTS5 when Chroma is null', async () => {
      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
      const result = await orchestrator.search({
        query: 'test search'
      });

      // Should have results from FTS5, not empty
      expect(result.results.observations.length).toBeGreaterThan(0);
      expect(result.results.sessions.length).toBeGreaterThan(0);
      expect(result.results.prompts.length).toBeGreaterThan(0);
    });

    it('should still work for filter-only queries without Chroma', async () => {
      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
      const result = await orchestrator.search({
        project: 'test-project'
      });

      expect(result.strategy).toBe('sqlite');
      expect(result.usedChroma).toBe(false);
      expect(result.fellBack).toBe(false);
    });
  });

  describe('searchMethod field in results', () => {
    it('should set searchMethod to "filter-only" for filter-only queries', async () => {
      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, null);
      const result = await orchestrator.search({
        project: 'test-project',
        limit: 10
      });

      expect(result.searchMethod).toBe('filter-only');
    });

    it('should set searchMethod to "fts5-fallback" when Chroma fails with query', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('MCP error -32000')));

      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      const result = await orchestrator.search({
        query: 'failing query'
      });

      expect(result.searchMethod).toBe('fts5-fallback');
    });

    it('should set searchMethod to "chroma" on successful Chroma search', async () => {
      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      const result = await orchestrator.search({
        query: 'successful query'
      });

      expect(result.searchMethod).toBe('chroma');
    });
  });

  describe('FTS5 fallback preserves search type filtering', () => {
    it('should search only observations when searchType is specified during fallback', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma down')));

      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      const result = await orchestrator.search({
        query: 'test query',
        type: 'observations'
      });

      expect(result.fellBack).toBe(true);
      expect(mockSessionSearch.searchObservations).toHaveBeenCalled();
      expect(mockSessionSearch.searchSessions).not.toHaveBeenCalled();
      expect(mockSessionSearch.searchUserPrompts).not.toHaveBeenCalled();
    });

    it('should preserve project filter during FTS5 fallback', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma down')));

      const orchestrator = new SearchOrchestrator(mockSessionSearch, mockSessionStore, mockChromaSync);
      await orchestrator.search({
        query: 'test query',
        project: 'my-project'
      });

      const callArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(callArgs[1].project).toBe('my-project');
    });
  });
});
