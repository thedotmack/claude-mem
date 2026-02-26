/**
 * Tests for commit_sha filtering in getObservationsByIds
 *
 * Validates that the branch ancestry filter works correctly:
 * - Single commit_sha string
 * - Array of commit_sha values
 * - Backward compatibility with NULL commit_sha (pre-migration observations)
 * - No filtering when commit_sha is not provided
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { getObservationsByIds } from '../../src/services/sqlite/observations/get.js';
import {
  storeObservation,
} from '../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

describe('getObservationsByIds commit_sha filtering', () => {
  let db: Database;
  let obsIds: number[];

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

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;

    // Ensure branch columns exist
    try { db.run('ALTER TABLE observations ADD COLUMN branch TEXT'); } catch { /* already exists */ }
    try { db.run('ALTER TABLE observations ADD COLUMN commit_sha TEXT'); } catch { /* already exists */ }

    // Create session
    const sessionId = createSDKSession(db, 'content-1', 'test-project', 'test');
    updateMemorySessionId(db, sessionId, 'mem-1');

    obsIds = [];

    // Observation 1: no commit_sha (pre-migration)
    const r1 = storeObservation(db, 'mem-1', 'test-project', createObservationInput({ title: 'Pre-migration' }));
    obsIds.push(r1.id);

    // Observation 2: commit sha abc123
    const r2 = storeObservation(db, 'mem-1', 'test-project', createObservationInput({ title: 'Branch A', commit_sha: 'abc123' }));
    obsIds.push(r2.id);
    // Set commit_sha directly since storeObservation may not handle it
    db.run('UPDATE observations SET commit_sha = ? WHERE id = ?', ['abc123', r2.id]);

    // Observation 3: commit sha def456
    const r3 = storeObservation(db, 'mem-1', 'test-project', createObservationInput({ title: 'Branch B', commit_sha: 'def456' }));
    obsIds.push(r3.id);
    db.run('UPDATE observations SET commit_sha = ? WHERE id = ?', ['def456', r3.id]);

    // Observation 4: commit sha ghi789
    const r4 = storeObservation(db, 'mem-1', 'test-project', createObservationInput({ title: 'Branch C', commit_sha: 'ghi789' }));
    obsIds.push(r4.id);
    db.run('UPDATE observations SET commit_sha = ? WHERE id = ?', ['ghi789', r4.id]);
  });

  afterEach(() => {
    db.close();
  });

  it('should return all observations when commit_sha is not provided', () => {
    const results = getObservationsByIds(db, obsIds);
    expect(results).toHaveLength(4);
  });

  it('should filter by single commit_sha string (includes pre-migration)', () => {
    const results = getObservationsByIds(db, obsIds, { commit_sha: 'abc123' });
    expect(results).toHaveLength(2);
    const titles = results.map(r => r.title);
    expect(titles).toContain('Pre-migration');
    expect(titles).toContain('Branch A');
    expect(titles).not.toContain('Branch B');
    expect(titles).not.toContain('Branch C');
  });

  it('should filter by array of commit_sha values', () => {
    const results = getObservationsByIds(db, obsIds, { commit_sha: ['abc123', 'ghi789'] });
    expect(results).toHaveLength(3);
    const titles = results.map(r => r.title);
    expect(titles).toContain('Pre-migration');
    expect(titles).toContain('Branch A');
    expect(titles).toContain('Branch C');
    expect(titles).not.toContain('Branch B');
  });

  it('should return only pre-migration observations for non-matching commit_sha', () => {
    const results = getObservationsByIds(db, obsIds, { commit_sha: 'nonexistent' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Pre-migration');
  });

  it('should combine commit_sha filter with project filter', () => {
    const results = getObservationsByIds(db, obsIds, {
      commit_sha: 'abc123',
      project: 'test-project'
    });
    expect(results).toHaveLength(2);
    const titles = results.map(r => r.title);
    expect(titles).toContain('Pre-migration');
    expect(titles).toContain('Branch A');
  });

  it('should return empty for non-matching project with commit_sha filter', () => {
    const results = getObservationsByIds(db, obsIds, {
      commit_sha: 'abc123',
      project: 'nonexistent-project'
    });
    expect(results).toHaveLength(0);
  });
});
