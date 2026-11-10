import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { HybridSearchStrategy } from '../../../../src/services/worker/search/strategies/HybridSearchStrategy.js';
import type { StrategySearchOptions, ObservationSearchResult, SessionSummarySearchResult } from '../../../../src/services/worker/search/types.js';

function obs(id: number, daysAgo: number): ObservationSearchResult {
  return {
    id,
    memory_session_id: id === 3 ? 'session-456' : 'session-123',
    project: 'test-project',
    text: `Test observation ${id}`,
    type: ['decision', 'bugfix', 'feature'][id - 1],
    title: ['First Decision', 'Second Bugfix', 'Third Feature'][id - 1],
    subtitle: `Subtitle ${id}`,
    facts: JSON.stringify([`fact${id}`]),
    narrative: `Narrative ${id}`,
    concepts: JSON.stringify([`concept${id}`]),
    files_read: JSON.stringify([`file${id * 2 - 1}.ts`]),
    files_modified: JSON.stringify([`file${id * 2}.ts`]),
    prompt_number: id,
    discovery_tokens: 50 * (id + 1),
    created_at: `2025-01-0${id}T12:00:00.000Z`,
    created_at_epoch: Date.now() - 1000 * 60 * 60 * 24 * daysAgo
  };
}

const mockObservation1 = obs(1, 1);
const mockObservation2 = obs(2, 2);
const mockObservation3 = obs(3, 3);

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
      getUserPromptsByIds: mock(() => []),
      getProjectReadKeys: mock((projects: string[]) => projects)
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

    it('keeps exact file matches Chroma did not rank, after the ranked ones', async () => {
      // Chroma only reorders the metadata matches; it never drops one.
      mockChromaSync.queryChroma = mock(() => Promise.resolve({
        ids: [2],
        distances: [0.1],
        metadatas: []
      }));

      const result = await strategy.findByFile('/path/to/file.ts', { limit: 10 });

      expect(result.usedChroma).toBe(true);
      expect(result.observations.map(obs => obs.id)).toEqual([2, 1]);
    });

    it('ranks with the project scoping SQLite matched by: every stored spelling, and merged projects', async () => {
      // SQLite's file lookup compares project and merged_into_project
      // case-insensitively (#3531, #3641); an exact { project } filter in
      // Chroma left those rows out of the ranking.
      mockSessionStore.getProjectReadKeys = mock(() => ['my-project', 'My-Project']);

      await strategy.findByFile('/path/to/file.ts', { limit: 10, project: 'my-project' });

      const spellings = { $in: ['my-project', 'My-Project'] };
      expect(mockSessionStore.getProjectReadKeys).toHaveBeenCalledWith(['my-project']);
      expect(mockChromaSync.queryChroma).toHaveBeenCalledWith('/path/to/file.ts', expect.any(Number), {
        $and: [
          { doc_type: 'observation' },
          { $or: [{ project: spellings }, { merged_into_project: spellings }] },
        ],
      });
    });

    it('scopes the SQLite file lookup and the hydration by the same read keys as the ranking', async () => {
      // The file lookup decides which rows match; without `projects` it
      // returned every project's rows for a checkout reading several keys.
      mockSessionStore.getProjectReadKeys = mock(() => ['api', 'acme/api', 'api-old']);

      await strategy.findByFile('/path/to/file.ts', { limit: 10, projects: ['api', 'acme/api'] });

      const readKeys = ['api', 'acme/api', 'api-old'];
      expect(mockSessionStore.getProjectReadKeys).toHaveBeenCalledTimes(1);
      expect(mockSessionSearch.findByFile).toHaveBeenCalledWith('/path/to/file.ts', expect.objectContaining({ projects: readKeys }));
      expect(mockSessionStore.getObservationsByIds).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ projects: readKeys }));
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
