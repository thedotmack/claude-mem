/**
 * Tests for Chroma branch metadata sync and filtering.
 *
 * Validates that:
 * - formatObservationDocs includes branch/commit_sha in metadata when present
 * - formatObservationDocs omits branch/commit_sha when null/undefined (backward compat)
 * - formatSummaryDocs includes branch/commit_sha in metadata when present
 * - formatSummaryDocs omits branch/commit_sha when null/undefined (backward compat)
 * - syncObservation correctly passes branch/commit_sha through to formatted documents
 * - buildWhereFilter generates correct filter with commit_sha array
 * - buildWhereFilter generates correct filter without commit_sha (backward compat)
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { ChromaSync } from '../src/services/sync/ChromaSync.js';
import { ChromaSearchStrategy } from '../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import { logger } from '../src/utils/logger.js';
import type { StrategySearchOptions } from '../src/services/worker/search/types.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('Chroma Branch Metadata Sync', () => {
  let sync: ChromaSync;

  beforeEach(() => {
    sync = new ChromaSync('test-project');
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  describe('formatObservationDocs with branch metadata', () => {
    const baseObservation = {
      id: 1,
      memory_session_id: 'session-abc',
      project: 'test-project',
      text: null,
      type: 'discovery',
      title: 'Test Observation',
      subtitle: null,
      facts: JSON.stringify(['fact1', 'fact2']),
      narrative: 'Test narrative content',
      concepts: JSON.stringify(['concept1']),
      files_read: JSON.stringify(['/path/to/file.ts']),
      files_modified: JSON.stringify([]),
      prompt_number: 1,
      discovery_tokens: 100,
      created_at: '2025-01-01T00:00:00.000Z',
      created_at_epoch: 1735689600,
    };

    it('should include branch and commit_sha in metadata when present', () => {
      const obs = {
        ...baseObservation,
        branch: 'feature-branch',
        commit_sha: 'abc123def456',
      };

      const docs = (sync as any).formatObservationDocs(obs);

      expect(docs.length).toBeGreaterThan(0);

      // Every document should have branch and commit_sha in metadata
      for (const doc of docs) {
        expect(doc.metadata.branch).toBe('feature-branch');
        expect(doc.metadata.commit_sha).toBe('abc123def456');
      }
    });

    it('should omit branch from metadata when null', () => {
      const obs = {
        ...baseObservation,
        branch: null,
        commit_sha: null,
      };

      const docs = (sync as any).formatObservationDocs(obs);

      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.metadata.branch).toBeUndefined();
        expect(doc.metadata.commit_sha).toBeUndefined();
      }
    });

    it('should omit branch from metadata when undefined', () => {
      // No branch or commit_sha fields at all (pre-migration observation)
      const obs = { ...baseObservation };

      const docs = (sync as any).formatObservationDocs(obs);

      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.metadata.branch).toBeUndefined();
        expect(doc.metadata.commit_sha).toBeUndefined();
      }
    });

    it('should include branch but omit commit_sha when only branch is set', () => {
      const obs = {
        ...baseObservation,
        branch: 'main',
        commit_sha: null,
      };

      const docs = (sync as any).formatObservationDocs(obs);

      for (const doc of docs) {
        expect(doc.metadata.branch).toBe('main');
        expect(doc.metadata.commit_sha).toBeUndefined();
      }
    });

    it('should preserve all other metadata fields alongside branch data', () => {
      const obs = {
        ...baseObservation,
        branch: 'feature-x',
        commit_sha: 'sha789',
      };

      const docs = (sync as any).formatObservationDocs(obs);
      const narrativeDoc = docs.find((d: any) => d.metadata.field_type === 'narrative');

      expect(narrativeDoc).toBeDefined();
      expect(narrativeDoc.metadata.sqlite_id).toBe(1);
      expect(narrativeDoc.metadata.doc_type).toBe('observation');
      expect(narrativeDoc.metadata.project).toBe('test-project');
      expect(narrativeDoc.metadata.type).toBe('discovery');
      expect(narrativeDoc.metadata.branch).toBe('feature-x');
      expect(narrativeDoc.metadata.commit_sha).toBe('sha789');
    });

    it('should propagate branch metadata to all document types (narrative, text, facts)', () => {
      const obs = {
        ...baseObservation,
        text: 'Legacy text field',
        branch: 'dev',
        commit_sha: 'sha456',
      };

      const docs = (sync as any).formatObservationDocs(obs);

      // Should have narrative, text, and 2 fact documents
      expect(docs.length).toBe(4);

      const fieldTypes = docs.map((d: any) => d.metadata.field_type);
      expect(fieldTypes).toContain('narrative');
      expect(fieldTypes).toContain('text');
      expect(fieldTypes).toContain('fact');

      // All should have branch metadata
      for (const doc of docs) {
        expect(doc.metadata.branch).toBe('dev');
        expect(doc.metadata.commit_sha).toBe('sha456');
      }
    });
  });

  describe('formatSummaryDocs with branch metadata', () => {
    const baseSummary = {
      id: 10,
      memory_session_id: 'session-xyz',
      project: 'test-project',
      request: 'Test request',
      investigated: 'Test investigated',
      learned: 'Test learned',
      completed: 'Test completed',
      next_steps: 'Test next steps',
      notes: 'Test notes',
      prompt_number: 5,
      discovery_tokens: 500,
      created_at: '2025-06-01T00:00:00.000Z',
      created_at_epoch: 1748736000,
    };

    it('should include branch and commit_sha in summary metadata when present', () => {
      const summary = {
        ...baseSummary,
        branch: 'release-v2',
        commit_sha: 'def789abc',
      };

      const docs = (sync as any).formatSummaryDocs(summary);

      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.metadata.branch).toBe('release-v2');
        expect(doc.metadata.commit_sha).toBe('def789abc');
      }
    });

    it('should omit branch/commit_sha from summary metadata when null', () => {
      const summary = {
        ...baseSummary,
        branch: null,
        commit_sha: null,
      };

      const docs = (sync as any).formatSummaryDocs(summary);

      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.metadata.branch).toBeUndefined();
        expect(doc.metadata.commit_sha).toBeUndefined();
      }
    });

    it('should omit branch/commit_sha from summary metadata when undefined', () => {
      const summary = { ...baseSummary };

      const docs = (sync as any).formatSummaryDocs(summary);

      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(doc.metadata.branch).toBeUndefined();
        expect(doc.metadata.commit_sha).toBeUndefined();
      }
    });

    it('should propagate branch metadata to all summary field documents', () => {
      const summary = {
        ...baseSummary,
        branch: 'hotfix',
        commit_sha: 'hotfix123',
      };

      const docs = (sync as any).formatSummaryDocs(summary);

      // Should have documents for: request, investigated, learned, completed, next_steps, notes
      expect(docs.length).toBe(6);

      const fieldTypes = docs.map((d: any) => d.metadata.field_type);
      expect(fieldTypes).toContain('request');
      expect(fieldTypes).toContain('investigated');
      expect(fieldTypes).toContain('learned');
      expect(fieldTypes).toContain('completed');
      expect(fieldTypes).toContain('next_steps');
      expect(fieldTypes).toContain('notes');

      for (const doc of docs) {
        expect(doc.metadata.branch).toBe('hotfix');
        expect(doc.metadata.commit_sha).toBe('hotfix123');
      }
    });
  });

  describe('syncObservation passes branch/commit_sha to formatters', () => {
    it('should construct StoredObservation with branch/commit_sha and format correctly', () => {
      // Test that syncObservation builds the StoredObservation correctly
      // by calling formatObservationDocs indirectly and verifying the output.
      // We mock addDocuments to capture what gets passed.
      const capturedDocs: any[] = [];
      (sync as any).addDocuments = mock(async (docs: any[]) => {
        capturedDocs.push(...docs);
      });

      const observation = {
        type: 'decision' as const,
        title: 'Branch-aware decision',
        subtitle: 'Testing sync',
        facts: ['fact-a'],
        narrative: 'Made a decision on branch',
        concepts: ['architecture'],
        files_read: ['/src/index.ts'],
        files_modified: ['/src/config.ts'],
      };

      // Call syncObservation with branch and commitSha
      sync.syncObservation(
        42, 'mem-session-1', 'test-project',
        observation, 3, 1700000000, 200,
        'feature/auth', 'commit-sha-xyz'
      );

      // Wait for the async call to complete
      return new Promise<void>(resolve => {
        setTimeout(() => {
          expect(capturedDocs.length).toBeGreaterThan(0);

          for (const doc of capturedDocs) {
            expect(doc.metadata.branch).toBe('feature/auth');
            expect(doc.metadata.commit_sha).toBe('commit-sha-xyz');
          }
          resolve();
        }, 50);
      });
    });

    it('should construct StoredObservation without branch/commit_sha for backward compat', () => {
      const capturedDocs: any[] = [];
      (sync as any).addDocuments = mock(async (docs: any[]) => {
        capturedDocs.push(...docs);
      });

      const observation = {
        type: 'discovery' as const,
        title: 'Legacy observation',
        subtitle: null,
        facts: [],
        narrative: 'No branch info available',
        concepts: [],
        files_read: [],
        files_modified: [],
      };

      // Call without branch/commitSha
      sync.syncObservation(
        43, 'mem-session-2', 'test-project',
        observation, 1, 1700000000, 0
      );

      return new Promise<void>(resolve => {
        setTimeout(() => {
          expect(capturedDocs.length).toBeGreaterThan(0);

          for (const doc of capturedDocs) {
            expect(doc.metadata.branch).toBeUndefined();
            expect(doc.metadata.commit_sha).toBeUndefined();
          }
          resolve();
        }, 50);
      });
    });
  });
});

describe('ChromaSearchStrategy buildWhereFilter with branch filtering', () => {
  let strategy: ChromaSearchStrategy;
  let mockChromaSync: any;
  let mockSessionStore: any;
  let logSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    const recentEpoch = Date.now() - 1000 * 60 * 60 * 24; // 1 day ago

    mockChromaSync = {
      queryChroma: mock(() => Promise.resolve({
        ids: [1],
        distances: [0.1],
        metadatas: [
          { sqlite_id: 1, doc_type: 'observation', created_at_epoch: recentEpoch }
        ]
      }))
    };

    mockSessionStore = {
      getObservationsByIds: mock(() => []),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => [])
    };

    strategy = new ChromaSearchStrategy(mockChromaSync, mockSessionStore);

    logSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    logSpies.forEach(spy => spy.mockRestore());
  });

  it('should generate $or filter with commit_sha $in when commit_sha string provided', async () => {
    const options: StrategySearchOptions = {
      query: 'test query',
      commit_sha: 'sha-abc',
    };

    await strategy.search(options);

    const whereArg = mockChromaSync.queryChroma.mock.calls[0][2];
    expect(whereArg).toEqual({
      $or: [
        { commit_sha: { $in: ['sha-abc'] } },
        { commit_sha: { $eq: '' } }
      ]
    });
  });

  it('should generate $or filter with commit_sha $in when commit_sha array provided', async () => {
    const options: StrategySearchOptions = {
      query: 'test query',
      commit_sha: ['sha-aaa', 'sha-bbb', 'sha-ccc'],
    };

    await strategy.search(options);

    const whereArg = mockChromaSync.queryChroma.mock.calls[0][2];
    expect(whereArg).toEqual({
      $or: [
        { commit_sha: { $in: ['sha-aaa', 'sha-bbb', 'sha-ccc'] } },
        { commit_sha: { $eq: '' } }
      ]
    });
  });

  it('should not include commit_sha filter when commit_sha not provided (backward compat)', async () => {
    const options: StrategySearchOptions = {
      query: 'test query',
    };

    await strategy.search(options);

    const whereArg = mockChromaSync.queryChroma.mock.calls[0][2];
    // No filter at all for 'all' searchType with no project/commit_sha
    expect(whereArg).toBeUndefined();
  });

  it('should combine doc_type, project, and commit_sha with $and when all specified', async () => {
    const options: StrategySearchOptions = {
      query: 'test query',
      searchType: 'observations',
      project: 'my-project',
      commit_sha: ['sha-1', 'sha-2'],
    };

    await strategy.search(options);

    const whereArg = mockChromaSync.queryChroma.mock.calls[0][2];
    expect(whereArg).toEqual({
      $and: [
        { doc_type: 'observation' },
        { project: 'my-project' },
        {
          $or: [
            { commit_sha: { $in: ['sha-1', 'sha-2'] } },
            { commit_sha: { $eq: '' } }
          ]
        }
      ]
    });
  });

  it('should combine project and commit_sha with $and without doc_type for searchType=all', async () => {
    const options: StrategySearchOptions = {
      query: 'test query',
      project: 'my-project',
      commit_sha: 'sha-only',
    };

    await strategy.search(options);

    const whereArg = mockChromaSync.queryChroma.mock.calls[0][2];
    expect(whereArg).toEqual({
      $and: [
        { project: 'my-project' },
        {
          $or: [
            { commit_sha: { $in: ['sha-only'] } },
            { commit_sha: { $eq: '' } }
          ]
        }
      ]
    });
  });

  it('should use single condition (no $and wrapper) when only commit_sha specified', async () => {
    const options: StrategySearchOptions = {
      query: 'test query',
      commit_sha: 'single-sha',
    };

    await strategy.search(options);

    const whereArg = mockChromaSync.queryChroma.mock.calls[0][2];
    // Only one condition, so no $and wrapper
    expect(whereArg).toEqual({
      $or: [
        { commit_sha: { $in: ['single-sha'] } },
        { commit_sha: { $eq: '' } }
      ]
    });
  });

  it('should use single condition when only doc_type specified (no branch filter)', async () => {
    const options: StrategySearchOptions = {
      query: 'test query',
      searchType: 'sessions',
    };

    await strategy.search(options);

    const whereArg = mockChromaSync.queryChroma.mock.calls[0][2];
    expect(whereArg).toEqual({ doc_type: 'session_summary' });
  });
});
