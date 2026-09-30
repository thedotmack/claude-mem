import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { HybridSearchStrategy } from '../../../../src/services/worker/search/strategies/HybridSearchStrategy.js';
import type { StrategySearchOptions, ObservationSearchResult, SessionSummarySearchResult } from '../../../../src/services/worker/search/types.js';

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
        const allObs = [mockObservation1, mockObservation2, mockObservation3];
        return allObs.filter(obs => ids.includes(obs.id));
      }),
      getSessionSummariesByIds: mock(() => [mockSession]),
      getUserPromptsByIds: mock(() => [])
    };

    mockSessionSearch = {
      findByFile: mock(() => ({
        observations: [mockObservation1, mockObservation2],
        sessions: [mockSession]
      }))
    };

    strategy = new HybridSearchStrategy(mockChromaSync, mockSessionStore, mockSessionSearch);
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
      const options: StrategySearchOptions = {
        limit: 10
      };

      const result = await strategy.findByFile('/path/to/file.ts', options);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].id).toBe(1);
    });

    it('should preserve platformSource through by-file metadata search and hydration', async () => {
      const options: StrategySearchOptions = {
        limit: 10,
        platformSource: 'cursor'
      };

      await strategy.findByFile('/path/to/file.ts', options);

      expect(mockSessionSearch.findByFile).toHaveBeenCalledWith('/path/to/file.ts', expect.objectContaining({
        platformSource: 'cursor'
      }));
      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
        platformSource: 'cursor'
      }));
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

      expect(result.observations[0].id).toBe(2);
      expect(result.usedChroma).toBe(true);
    });

    it('falls back to scoped SQLite file observation matches when platform-scoped Chroma ranks zero ids', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [],
        distances: [],
        metadatas: []
      }));

      const result = await strategy.findByFile('/path/to/file.ts', {
        limit: 10,
        platformSource: 'cursor'
      });

      expect(mockSessionStore.getObservationsByIds).not.toHaveBeenCalled();
      expect(result.usedChroma).toBe(false);
      expect(result.observations.map(obs => obs.id)).toEqual([1, 2]);
      expect(result.sessions).toEqual([mockSession]);
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

    it('should propagate Chroma error (fail-fast, no silent fallback)', async () => {
      mockChromaSync.queryChroma = mock(() => Promise.reject(new Error('Chroma down')));

      const options: StrategySearchOptions = {
        limit: 10
      };

      await expect(
        strategy.findByFile('/path/to/file.ts', options)
      ).rejects.toThrow('Chroma down');
    });
  });
});
