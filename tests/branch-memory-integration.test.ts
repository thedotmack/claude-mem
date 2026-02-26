/**
 * Integration tests for the complete branch memory flow.
 *
 * Validates end-to-end: storing observations with branch/commitSha,
 * backward compatibility with pre-migration NULL values,
 * cross-branch deduplication prevention, commit SHA filtering,
 * and getUniqueCommitShasForProject correctness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../src/services/sqlite/Database.js';
import {
  storeObservation,
  getObservationsByIds,
  getUniqueCommitShasForProject,
} from '../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('Branch Memory Integration', () => {
  let db: Database;

  function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Test Subtitle',
      facts: ['fact1'],
      narrative: 'Test narrative',
      concepts: ['concept1'],
      files_read: ['/path/to/file.ts'],
      files_modified: [],
      ...overrides,
    };
  }

  function setupSession(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): string {
    const sessionId = createSDKSession(db, contentSessionId, project, 'test prompt');
    updateMemorySessionId(db, sessionId, memorySessionId);
    return memorySessionId;
  }

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;

    // Ensure branch columns exist (migration may or may not have run)
    try { db.run('ALTER TABLE observations ADD COLUMN branch TEXT'); } catch { /* already exists */ }
    try { db.run('ALTER TABLE observations ADD COLUMN commit_sha TEXT'); } catch { /* already exists */ }
  });

  afterEach(() => {
    db.close();
  });

  describe('Write path: storeObservation with branch and commitSha', () => {
    it('should persist branch and commit_sha columns when provided', () => {
      setupSession('content-1', 'mem-1');

      const result = storeObservation(
        db, 'mem-1', 'test-project',
        createObservationInput({ title: 'Branch obs' }),
        undefined, 0, undefined,
        'feature-branch', 'abc123def456'
      );

      // Query back directly to verify columns
      const row = db.prepare('SELECT branch, commit_sha FROM observations WHERE id = ?').get(result.id) as { branch: string | null; commit_sha: string | null };
      expect(row.branch).toBe('feature-branch');
      expect(row.commit_sha).toBe('abc123def456');
    });

    it('should persist NULL for branch and commit_sha when not provided', () => {
      setupSession('content-2', 'mem-2');

      const result = storeObservation(
        db, 'mem-2', 'test-project',
        createObservationInput({ title: 'No branch obs' })
      );

      const row = db.prepare('SELECT branch, commit_sha FROM observations WHERE id = ?').get(result.id) as { branch: string | null; commit_sha: string | null };
      expect(row.branch).toBeNull();
      expect(row.commit_sha).toBeNull();
    });

    it('should retrieve stored observation via getObservationsByIds with branch data intact', () => {
      setupSession('content-3', 'mem-3');

      const result = storeObservation(
        db, 'mem-3', 'test-project',
        createObservationInput({ title: 'Retrievable obs' }),
        undefined, 0, undefined,
        'main', 'sha999'
      );

      const obs = getObservationsByIds(db, [result.id]);
      expect(obs).toHaveLength(1);
      expect(obs[0].title).toBe('Retrievable obs');
      expect(obs[0].branch).toBe('main');
      expect(obs[0].commit_sha).toBe('sha999');
    });
  });

  describe('Backward compatibility: NULL branch/commitSha observations', () => {
    it('should always include NULL commit_sha observations in filtered queries', () => {
      setupSession('content-4', 'mem-4');

      // Pre-migration observation (no branch/commitSha)
      const preMigration = storeObservation(
        db, 'mem-4', 'test-project',
        createObservationInput({ title: 'Pre-migration' })
      );

      // Post-migration observation with commit SHA
      const postMigration = storeObservation(
        db, 'mem-4', 'test-project',
        createObservationInput({ title: 'Post-migration' }),
        undefined, 0, undefined,
        'main', 'sha-post'
      );

      // Filter by sha-post should include both pre-migration (NULL) and matching
      const results = getObservationsByIds(db, [preMigration.id, postMigration.id], {
        commit_sha: 'sha-post',
      });
      expect(results).toHaveLength(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Pre-migration');
      expect(titles).toContain('Post-migration');
    });

    it('should include NULL commit_sha observations even when no SHAs match', () => {
      setupSession('content-5', 'mem-5');

      const preMigration = storeObservation(
        db, 'mem-5', 'test-project',
        createObservationInput({ title: 'Legacy obs' })
      );

      const withSha = storeObservation(
        db, 'mem-5', 'test-project',
        createObservationInput({ title: 'Sha obs' }),
        undefined, 0, undefined,
        'main', 'sha-exists'
      );

      // Filter by nonexistent SHA — only pre-migration should appear
      const results = getObservationsByIds(db, [preMigration.id, withSha.id], {
        commit_sha: 'nonexistent-sha',
      });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Legacy obs');
    });
  });

  describe('Cross-branch dedup prevention', () => {
    it('should store both observations when title/narrative are identical but branch differs', () => {
      setupSession('content-6', 'mem-6');

      const sharedInput = createObservationInput({
        title: 'Identical Title',
        narrative: 'Identical narrative text',
      });

      const obs1 = storeObservation(
        db, 'mem-6', 'test-project',
        sharedInput,
        undefined, 0, undefined,
        'branch-a', 'sha-a'
      );

      const obs2 = storeObservation(
        db, 'mem-6', 'test-project',
        sharedInput,
        undefined, 0, undefined,
        'branch-b', 'sha-b'
      );

      // Both should be stored (different IDs) because branch is included in content hash
      expect(obs1.id).not.toBe(obs2.id);

      // Verify both exist in database
      const allObs = getObservationsByIds(db, [obs1.id, obs2.id]);
      expect(allObs).toHaveLength(2);
    });

    it('should still deduplicate identical observations on the same branch', () => {
      setupSession('content-7', 'mem-7');

      const sharedInput = createObservationInput({
        title: 'Same Branch Same Content',
        narrative: 'Same narrative',
      });

      const obs1 = storeObservation(
        db, 'mem-7', 'test-project',
        sharedInput,
        undefined, 0, undefined,
        'same-branch', 'sha-same'
      );

      const obs2 = storeObservation(
        db, 'mem-7', 'test-project',
        sharedInput,
        undefined, 0, undefined,
        'same-branch', 'sha-same'
      );

      // Dedup should kick in — same ID returned
      expect(obs1.id).toBe(obs2.id);
    });
  });

  describe('Commit SHA filter in getObservationsByIds', () => {
    let ids: number[];

    beforeEach(() => {
      setupSession('content-8', 'mem-8');
      ids = [];

      // Pre-migration (NULL commit_sha)
      const r1 = storeObservation(db, 'mem-8', 'test-project',
        createObservationInput({ title: 'Null SHA' }));
      ids.push(r1.id);

      // SHA alpha
      const r2 = storeObservation(db, 'mem-8', 'test-project',
        createObservationInput({ title: 'Alpha' }),
        undefined, 0, undefined, 'main', 'sha-alpha');
      ids.push(r2.id);

      // SHA beta
      const r3 = storeObservation(db, 'mem-8', 'test-project',
        createObservationInput({ title: 'Beta' }),
        undefined, 0, undefined, 'feature', 'sha-beta');
      ids.push(r3.id);

      // SHA gamma
      const r4 = storeObservation(db, 'mem-8', 'test-project',
        createObservationInput({ title: 'Gamma' }),
        undefined, 0, undefined, 'hotfix', 'sha-gamma');
      ids.push(r4.id);
    });

    it('should return all observations when no commit_sha filter', () => {
      const results = getObservationsByIds(db, ids);
      expect(results).toHaveLength(4);
    });

    it('should return matching + NULL for single commit_sha filter', () => {
      const results = getObservationsByIds(db, ids, { commit_sha: 'sha-alpha' });
      expect(results).toHaveLength(2);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Null SHA');
      expect(titles).toContain('Alpha');
    });

    it('should return matching + NULL for array commit_sha filter', () => {
      const results = getObservationsByIds(db, ids, { commit_sha: ['sha-alpha', 'sha-gamma'] });
      expect(results).toHaveLength(3);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Null SHA');
      expect(titles).toContain('Alpha');
      expect(titles).toContain('Gamma');
      expect(titles).not.toContain('Beta');
    });

    it('should exclude non-matching SHAs while keeping NULL', () => {
      const results = getObservationsByIds(db, ids, { commit_sha: 'no-match' });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Null SHA');
    });
  });

  describe('getUniqueCommitShasForProject', () => {
    it('should return distinct non-NULL commit SHAs for a project', () => {
      setupSession('content-9', 'mem-9');

      // Store observations with various SHAs
      storeObservation(db, 'mem-9', 'test-project',
        createObservationInput({ title: 'Obs 1' }),
        undefined, 0, undefined, 'main', 'sha-aaa');

      storeObservation(db, 'mem-9', 'test-project',
        createObservationInput({ title: 'Obs 2' }),
        undefined, 0, undefined, 'main', 'sha-bbb');

      // Duplicate SHA (different observation)
      storeObservation(db, 'mem-9', 'test-project',
        createObservationInput({ title: 'Obs 3' }),
        undefined, 0, undefined, 'main', 'sha-aaa');

      // NULL SHA (pre-migration)
      storeObservation(db, 'mem-9', 'test-project',
        createObservationInput({ title: 'Obs 4' }));

      const shas = getUniqueCommitShasForProject(db, 'test-project');
      expect(shas).toHaveLength(2);
      expect(shas).toContain('sha-aaa');
      expect(shas).toContain('sha-bbb');
    });

    it('should return empty array when no observations have commit SHAs', () => {
      setupSession('content-10', 'mem-10');

      storeObservation(db, 'mem-10', 'test-project',
        createObservationInput({ title: 'No SHA' }));

      const shas = getUniqueCommitShasForProject(db, 'test-project');
      expect(shas).toHaveLength(0);
    });

    it('should not return SHAs from other projects', () => {
      setupSession('content-11a', 'mem-11a', 'project-a');
      setupSession('content-11b', 'mem-11b', 'project-b');

      storeObservation(db, 'mem-11a', 'project-a',
        createObservationInput({ title: 'Proj A obs' }),
        undefined, 0, undefined, 'main', 'sha-proj-a');

      storeObservation(db, 'mem-11b', 'project-b',
        createObservationInput({ title: 'Proj B obs' }),
        undefined, 0, undefined, 'main', 'sha-proj-b');

      const shasA = getUniqueCommitShasForProject(db, 'project-a');
      expect(shasA).toHaveLength(1);
      expect(shasA).toContain('sha-proj-a');
      expect(shasA).not.toContain('sha-proj-b');

      const shasB = getUniqueCommitShasForProject(db, 'project-b');
      expect(shasB).toHaveLength(1);
      expect(shasB).toContain('sha-proj-b');
    });
  });
});
