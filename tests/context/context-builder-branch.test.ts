/**
 * Tests for ContextBuilder branch resolution logic.
 *
 * Validates that generateContext() correctly orchestrates:
 * - Collecting candidate commit SHAs from projects via getUniqueCommitShasForProject
 * - Resolving visible SHAs via resolveVisibleCommitShas
 * - Passing resolved SHAs (or null) through to observation query functions
 * - Graceful fallback to null when git resolution fails
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock setup (must precede ContextBuilder import) ---

const mockResolveVisibleCommitShas = mock(() => Promise.resolve(['sha1', 'sha2']));

mock.module('../../src/services/integrations/git-ancestry.js', () => ({
  resolveVisibleCommitShas: mockResolveVisibleCommitShas,
}));

const mockGetUniqueCommitShasForProject = mock(() => ['sha1', 'sha2', 'sha3']);

mock.module('../../src/services/sqlite/observations/get.js', () => ({
  getUniqueCommitShasForProject: mockGetUniqueCommitShasForProject,
}));

// Track arguments passed to queryObservations/queryObservationsMulti
let capturedQueryObservationsArgs: any[] = [];
let capturedQueryObservationsMultiArgs: any[] = [];

const mockQueryObservations = mock((...args: any[]) => {
  capturedQueryObservationsArgs = args;
  return [];
});

const mockQueryObservationsMulti = mock((...args: any[]) => {
  capturedQueryObservationsMultiArgs = args;
  return [];
});

const mockQuerySummaries = mock(() => []);
const mockQuerySummariesMulti = mock(() => []);
const mockGetPriorSessionMessages = mock(() => ({ userMessage: '', assistantMessage: '' }));
const mockPrepareSummariesForTimeline = mock(() => []);
const mockBuildTimeline = mock(() => []);
const mockGetFullObservationIds = mock(() => new Set());

mock.module('../../src/services/context/ObservationCompiler.js', () => ({
  queryObservations: mockQueryObservations,
  queryObservationsMulti: mockQueryObservationsMulti,
  querySummaries: mockQuerySummaries,
  querySummariesMulti: mockQuerySummariesMulti,
  getPriorSessionMessages: mockGetPriorSessionMessages,
  prepareSummariesForTimeline: mockPrepareSummariesForTimeline,
  buildTimeline: mockBuildTimeline,
  getFullObservationIds: mockGetFullObservationIds,
}));

const mockLoadContextConfig = mock(() => ({
  totalObservationCount: 100,
  fullObservationCount: 5,
  sessionCount: 5,
  showReadTokens: false,
  showWorkTokens: false,
  showSavingsAmount: false,
  showSavingsPercent: false,
  observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['how-it-works']),
  fullObservationField: 'narrative',
  showLastSummary: false,
  showLastMessage: false,
}));

mock.module('../../src/services/context/ContextConfigLoader.js', () => ({
  loadContextConfig: mockLoadContextConfig,
}));

const mockGetProjectName = mock(() => 'test-project');

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: mockGetProjectName,
}));

// Mock SessionStore to avoid real database initialization
const mockDbClose = mock(() => {});
const mockDbHandle = { fake: 'db-handle' };

mock.module('../../src/services/sqlite/SessionStore.js', () => ({
  SessionStore: class MockSessionStore {
    db = mockDbHandle;
    close = mockDbClose;
  },
}));

// Mock rendering modules to avoid side effects
mock.module('../../src/services/context/TokenCalculator.js', () => ({
  calculateTokenEconomics: mock(() => ({
    totalObservations: 0,
    totalReadTokens: 0,
    totalDiscoveryTokens: 0,
    savings: 0,
    savingsPercent: 0,
  })),
}));

mock.module('../../src/services/context/sections/HeaderRenderer.js', () => ({
  renderHeader: mock(() => []),
}));

mock.module('../../src/services/context/sections/TimelineRenderer.js', () => ({
  renderTimeline: mock(() => []),
}));

mock.module('../../src/services/context/sections/SummaryRenderer.js', () => ({
  shouldShowSummary: mock(() => false),
  renderSummaryFields: mock(() => []),
}));

mock.module('../../src/services/context/sections/FooterRenderer.js', () => ({
  renderPreviouslySection: mock(() => []),
  renderFooter: mock(() => []),
}));

mock.module('../../src/services/context/formatters/MarkdownFormatter.js', () => ({
  renderMarkdownEmptyState: mock(() => 'empty'),
}));

mock.module('../../src/services/context/formatters/ColorFormatter.js', () => ({
  renderColorEmptyState: mock(() => 'empty-color'),
}));

// Import the module under test AFTER all mocks are in place
import { generateContext } from '../../src/services/context/ContextBuilder.js';

// --- Tests ---

describe('ContextBuilder branch resolution', () => {
  beforeEach(() => {
    capturedQueryObservationsArgs = [];
    capturedQueryObservationsMultiArgs = [];

    mockResolveVisibleCommitShas.mockReset();
    mockResolveVisibleCommitShas.mockImplementation(() => Promise.resolve(['sha1', 'sha2']));

    mockGetUniqueCommitShasForProject.mockReset();
    mockGetUniqueCommitShasForProject.mockImplementation(() => ['sha1', 'sha2', 'sha3']);

    mockQueryObservations.mockReset();
    mockQueryObservations.mockImplementation((...args: any[]) => {
      capturedQueryObservationsArgs = args;
      return [];
    });

    mockQueryObservationsMulti.mockReset();
    mockQueryObservationsMulti.mockImplementation((...args: any[]) => {
      capturedQueryObservationsMultiArgs = args;
      return [];
    });

    mockQuerySummaries.mockReset();
    mockQuerySummaries.mockImplementation(() => []);
    mockQuerySummariesMulti.mockReset();
    mockQuerySummariesMulti.mockImplementation(() => []);

    mockGetProjectName.mockReset();
    mockGetProjectName.mockImplementation(() => 'test-project');

    mockDbClose.mockReset();
  });

  test('generateContext passes visible commit SHAs to observation queries', async () => {
    mockGetUniqueCommitShasForProject.mockImplementation(() => ['sha1', 'sha2', 'sha3']);
    mockResolveVisibleCommitShas.mockImplementation(() => Promise.resolve(['sha1', 'sha2']));

    await generateContext({ cwd: '/fake/repo' });

    // queryObservations should receive the filtered visible SHAs as the 4th argument
    expect(capturedQueryObservationsArgs).toHaveLength(4);
    expect(capturedQueryObservationsArgs[3]).toEqual(['sha1', 'sha2']);
  });

  test('generateContext passes null when not in git repo', async () => {
    mockResolveVisibleCommitShas.mockImplementation(() => Promise.resolve(null));

    await generateContext({ cwd: '/fake/not-git' });

    // When resolveVisibleCommitShas returns null, queryObservations gets null
    expect(capturedQueryObservationsArgs).toHaveLength(4);
    expect(capturedQueryObservationsArgs[3]).toBeNull();
  });

  test('generateContext falls back to null on resolution error', async () => {
    mockResolveVisibleCommitShas.mockImplementation(() => {
      throw new Error('git not available');
    });

    // Should not throw — graceful fallback
    await generateContext({ cwd: '/fake/broken-git' });

    // On error, queryObservations receives null (show everything)
    expect(capturedQueryObservationsArgs).toHaveLength(4);
    expect(capturedQueryObservationsArgs[3]).toBeNull();
  });

  test('generateContext aggregates SHAs across multiple projects', async () => {
    // Return different SHAs for each project
    mockGetUniqueCommitShasForProject.mockImplementation((db: any, project: string) => {
      if (project === 'proj1') return ['sha-a', 'sha-b'];
      if (project === 'proj2') return ['sha-b', 'sha-c'];
      return [];
    });

    mockResolveVisibleCommitShas.mockImplementation((shas: string[]) => {
      return Promise.resolve(shas);
    });

    await generateContext({ cwd: '/fake/repo', projects: ['proj1', 'proj2'] });

    // resolveVisibleCommitShas should receive the union of both projects' SHAs
    const resolveCallArgs = mockResolveVisibleCommitShas.mock.calls[0];
    const candidateShas = resolveCallArgs[0] as string[];

    // The union of ['sha-a', 'sha-b'] and ['sha-b', 'sha-c'] is ['sha-a', 'sha-b', 'sha-c']
    // (via Set deduplication, order may vary)
    expect(candidateShas).toHaveLength(3);
    expect(candidateShas).toContain('sha-a');
    expect(candidateShas).toContain('sha-b');
    expect(candidateShas).toContain('sha-c');

    // With multiple projects, queryObservationsMulti should be called (not queryObservations)
    expect(capturedQueryObservationsMultiArgs).toHaveLength(4);
  });
});
