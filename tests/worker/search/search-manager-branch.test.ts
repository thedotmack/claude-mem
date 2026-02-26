import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock setup (must precede SearchManager import) ---

const mockResolveVisibleCommitShas = mock(() => Promise.resolve(['sha1', 'sha2']));
const mockResolveAncestorCommits = mock(() => Promise.resolve([]));

const mockGetUniqueCommitShasForProject = mock(() => ['sha1', 'sha2', 'sha3']);
const mockGetObservationsByIds = mock(() => []);

mock.module('../../../src/services/integrations/git-ancestry.js', () => ({
  resolveVisibleCommitShas: mockResolveVisibleCommitShas,
  resolveAncestorCommits: mockResolveAncestorCommits,
}));

mock.module('../../../src/services/sqlite/observations/get.js', () => ({
  getUniqueCommitShasForProject: mockGetUniqueCommitShasForProject,
  getObservationsByIds: mockGetObservationsByIds,
}));

// Mock ModeManager (required by SearchOrchestrator)
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'decision', icon: 'D' },
          { id: 'bugfix', icon: 'B' },
        ],
        observation_concepts: [],
      }),
      getObservationTypes: () => [
        { id: 'decision', icon: 'D' },
        { id: 'bugfix', icon: 'B' },
      ],
      getTypeIcon: (type: string) => {
        const icons: Record<string, string> = { decision: 'D', bugfix: 'B' };
        return icons[type] || '?';
      },
      getWorkEmoji: () => 'W',
    }),
  },
}));

// Import SearchManager after mocks are in place
import { SearchManager } from '../../../src/services/worker/SearchManager.js';

// --- Helpers ---

function createMockSessionSearch() {
  return {
    searchObservations: mock(() => []),
    searchSessions: mock(() => []),
    searchUserPrompts: mock(() => []),
    findByConcept: mock(() => []),
    findByType: mock(() => []),
    findByFile: mock(() => ({ observations: [], sessions: [] })),
  };
}

function createMockSessionStore() {
  return {
    db: { fake: 'db-handle' },
    getObservationsByIds: mock(() => []),
    getSessionSummariesByIds: mock(() => []),
    getUserPromptsByIds: mock(() => []),
    getObservationById: mock(() => null),
    getTimelineAroundObservation: mock(() => ({ observations: [], sessions: [], prompts: [] })),
    getTimelineAroundTimestamp: mock(() => ({ observations: [], sessions: [], prompts: [] })),
  };
}

function createMockFormatter() {
  return {
    formatSearchTableHeader: mock(() => '| ID | Time | T | Title |'),
    formatObservationSearchRow: mock(() => ({ row: '| 1 | 12:00 | D | Test |', time: '12:00' })),
    formatSessionSearchRow: mock(() => ({ row: '| S1 | 12:00 | S | Session |', time: '12:00' })),
    formatUserPromptSearchRow: mock(() => ({ row: '| P1 | 12:00 | P | Prompt |', time: '12:00' })),
  };
}

function createMockTimelineService() {
  return {
    getTimelineItems: mock(() => []),
    formatTimeline: mock(() => ''),
  };
}

// --- Tests ---

describe('SearchManager branch filtering', () => {
  let searchManager: SearchManager;
  let mockSessionSearch: ReturnType<typeof createMockSessionSearch>;
  let mockSessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    // Reset all mocks
    mockResolveVisibleCommitShas.mockReset();
    mockResolveVisibleCommitShas.mockImplementation(() => Promise.resolve(['sha1', 'sha2']));

    mockGetUniqueCommitShasForProject.mockReset();
    mockGetUniqueCommitShasForProject.mockImplementation(() => ['sha1', 'sha2', 'sha3']);

    mockSessionSearch = createMockSessionSearch();
    mockSessionStore = createMockSessionStore();

    searchManager = new SearchManager(
      mockSessionSearch as any,
      mockSessionStore as any,
      null, // no chroma
      createMockFormatter() as any,
      createMockTimelineService() as any,
    );
  });

  describe('resolveBranchFilter via search()', () => {
    test('passes direct commit_sha array through to search options', async () => {
      await searchManager.search({
        commit_sha: ['sha1', 'sha2'],
        project: 'test-project',
      });

      // Direct commit_sha should be used without calling git ancestry
      expect(mockResolveVisibleCommitShas).not.toHaveBeenCalled();
      expect(mockGetUniqueCommitShasForProject).not.toHaveBeenCalled();

      // The resolved SHAs should be forwarded to the session search as options.commit_sha
      const searchCallArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(searchCallArgs[1].commit_sha).toEqual(['sha1', 'sha2']);
    });

    test('auto-resolves branch filter from cwd and project', async () => {
      mockGetUniqueCommitShasForProject.mockImplementation(() => ['sha1', 'sha2', 'sha3']);
      mockResolveVisibleCommitShas.mockImplementation(() => Promise.resolve(['sha1', 'sha2']));

      await searchManager.search({
        cwd: '/fake/repo',
        project: 'test-project',
      });

      // Should call getUniqueCommitShasForProject with the db and project
      expect(mockGetUniqueCommitShasForProject).toHaveBeenCalledWith(
        mockSessionStore.db,
        'test-project',
      );

      // Should call resolveVisibleCommitShas with the candidates and cwd
      expect(mockResolveVisibleCommitShas).toHaveBeenCalledWith(
        ['sha1', 'sha2', 'sha3'],
        '/fake/repo',
      );

      // The resolved visible SHAs should propagate to the search options
      const searchCallArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(searchCallArgs[1].commit_sha).toEqual(['sha1', 'sha2']);
    });

    test('returns undefined filter (no filtering) when resolveVisibleCommitShas throws', async () => {
      mockGetUniqueCommitShasForProject.mockImplementation(() => ['sha1']);
      mockResolveVisibleCommitShas.mockImplementation(() => {
        throw new Error('git not available');
      });

      // Should not throw - graceful fallback
      const result = await searchManager.search({
        cwd: '/fake/repo',
        project: 'test-project',
      });

      // Search should still succeed (no filter applied)
      expect(mockSessionSearch.searchObservations).toHaveBeenCalled();

      // The options should NOT have commit_sha set (undefined means no filter)
      const searchCallArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(searchCallArgs[1].commit_sha).toBeUndefined();
    });
  });

  describe('normalizeParams comma parsing for commit_sha', () => {
    test('splits comma-separated commit_sha string into array', async () => {
      await searchManager.search({
        commit_sha: 'sha1, sha2, sha3',
        project: 'test-project',
      });

      // After normalizeParams, the comma-separated string should become an array
      // and resolveBranchFilter should receive it as an array
      expect(mockResolveVisibleCommitShas).not.toHaveBeenCalled();

      // The parsed array should be forwarded to search options
      const searchCallArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(searchCallArgs[1].commit_sha).toEqual(['sha1', 'sha2', 'sha3']);
    });

    test('leaves single commit_sha string without commas as a single-element array', async () => {
      await searchManager.search({
        commit_sha: 'abc123',
        project: 'test-project',
      });

      // Single string without commas is not split by normalizeParams,
      // but resolveBranchFilter wraps it in an array
      const searchCallArgs = mockSessionSearch.searchObservations.mock.calls[0];
      expect(searchCallArgs[1].commit_sha).toEqual(['abc123']);
    });
  });

  describe('resolveBranchFilter via timeline()', () => {
    test('auto-resolves branch filter in timeline query mode', async () => {
      mockGetUniqueCommitShasForProject.mockImplementation(() => ['sha1', 'sha2']);
      mockResolveVisibleCommitShas.mockImplementation(() => Promise.resolve(['sha1']));

      // timeline() requires anchor or query. Since chroma is null, query mode will
      // return "no observations found" — but we can verify the mocks were called.
      await searchManager.timeline({
        query: 'test query',
        cwd: '/fake/repo',
        project: 'test-project',
      });

      expect(mockGetUniqueCommitShasForProject).toHaveBeenCalledWith(
        mockSessionStore.db,
        'test-project',
      );
      expect(mockResolveVisibleCommitShas).toHaveBeenCalledWith(
        ['sha1', 'sha2'],
        '/fake/repo',
      );
    });

    test('skips auto-resolution when no cwd is provided', async () => {
      // Override process.cwd for this test - timeline defaults to process.cwd()
      // when cwdParam is not provided. But without a project, resolveBranchFilter
      // requires BOTH cwd and project to auto-resolve.
      await searchManager.timeline({
        query: 'test query',
        // no cwd, no project
      });

      // Without project, resolveBranchFilter should not attempt auto-resolution
      expect(mockGetUniqueCommitShasForProject).not.toHaveBeenCalled();
      expect(mockResolveVisibleCommitShas).not.toHaveBeenCalled();
    });

    test('returns undefined filter when no candidate SHAs exist in database', async () => {
      mockGetUniqueCommitShasForProject.mockImplementation(() => []);

      await searchManager.timeline({
        query: 'test query',
        cwd: '/fake/repo',
        project: 'test-project',
      });

      // Should call getUniqueCommitShasForProject but NOT resolveVisibleCommitShas
      expect(mockGetUniqueCommitShasForProject).toHaveBeenCalled();
      expect(mockResolveVisibleCommitShas).not.toHaveBeenCalled();
    });
  });
});
