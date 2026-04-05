/**
 * Branch deletion / orphan detection tests
 * Tests that observations on branches no longer in git are marked as discarded
 *
 * Sources:
 * - detectOrphanedBranches from src/utils/branch.ts
 * - Branch/status columns from migration (ALTER TABLE observations ADD COLUMN branch/status)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ClaudeMemDatabase } from '../src/services/sqlite/Database.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../src/services/sqlite/Sessions.js';
import { detectOrphanedBranches, getCurrentBranch } from '../src/utils/branch.js';
import type { Database } from 'bun:sqlite';

describe('detectOrphanedBranches', () => {
  let db: Database;
  let currentBranchName: string;

  beforeAll(() => {
    db = new ClaudeMemDatabase(':memory:').db;

    // Detect the actual current branch so we can seed it as an "existing" branch
    currentBranchName = getCurrentBranch(process.cwd()) || 'unknown-branch';

    // Create a session for FK constraint
    const sessionDbId = createSDKSession(db, 'content-orphan-test', 'test-project', 'test prompt');
    updateMemorySessionId(db, sessionDbId, 'sess-orphan');

    // Seed observations on various branches
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, branch, status, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('sess-orphan', 'test-project', 'discovery', 'On current branch', currentBranchName, 'active', new Date().toISOString(), now);
    insert.run('sess-orphan', 'test-project', 'discovery', 'On deleted branch', 'deleted-branch-xyz', 'active', new Date().toISOString(), now + 1);
    insert.run('sess-orphan', 'test-project', 'discovery', 'No branch', null, 'active', new Date().toISOString(), now + 2);
  });

  afterAll(() => {
    db.close();
  });

  it('detects and marks orphaned branches', () => {
    // Call with the actual cwd (which has real git branches)
    const result = detectOrphanedBranches(db, 'test-project', process.cwd());

    // 'deleted-branch-xyz' should be orphaned (not a real git branch)
    expect(result.orphanedBranches).toContain('deleted-branch-xyz');
    expect(result.updatedCount).toBeGreaterThanOrEqual(1);

    // Verify the observation was marked as discarded
    const obs = db.prepare('SELECT status FROM observations WHERE title = ?').get('On deleted branch') as any;
    expect(obs.status).toBe('discarded_by_llm');
  });

  it('does not mark observations from existing branches', () => {
    // Current branch (checked out with * prefix) should still be active
    const currentBranchObs = db.prepare('SELECT status FROM observations WHERE title = ?').get('On current branch') as any;
    expect(currentBranchObs.status).toBe('active');
  });

  it('does not mark NULL branch observations', () => {
    const nullObs = db.prepare('SELECT status FROM observations WHERE title = ?').get('No branch') as any;
    expect(nullObs.status).toBe('active');
  });

  it('handles non-git directory gracefully', () => {
    const result = detectOrphanedBranches(db, 'test-project', '/tmp');
    expect(result.orphanedBranches).toEqual([]);
    expect(result.updatedCount).toBe(0);
  });
});
