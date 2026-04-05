/**
 * Observations branch-scoping tests
 * Tests storing and querying observations with the branch field
 *
 * Sources:
 * - Branch column added in migration (ALTER TABLE observations ADD COLUMN branch TEXT)
 * - Status column added in migration (ALTER TABLE observations ADD COLUMN status TEXT DEFAULT 'active')
 * - Branch filter utility from src/utils/branch-filter.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';

describe('observations with branch', () => {
  let db: Database;

  beforeAll(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterAll(() => {
    db.close();
  });

  // Helper to create a session with a memory_session_id for FK constraints
  function createSessionWithMemoryId(
    contentSessionId: string,
    memorySessionId: string,
    project: string = 'test-project',
    branch?: string | null
  ): string {
    const sessionDbId = createSDKSession(db, contentSessionId, project, 'test prompt', undefined, branch);
    updateMemorySessionId(db, sessionDbId, memorySessionId);
    return memorySessionId;
  }

  it('stores observation with branch field', () => {
    const memorySessionId = createSessionWithMemoryId(
      'content-branch-1',
      'mem-branch-1',
      'test-project',
      'feature/branch-a'
    );

    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, branch, status, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(memorySessionId, 'test-project', 'discovery', 'Test obs', 'feature/branch-a', 'active', new Date().toISOString(), Date.now());

    const obs = db.prepare('SELECT branch, status FROM observations WHERE memory_session_id = ?').get(memorySessionId) as any;
    expect(obs.branch).toBe('feature/branch-a');
    expect(obs.status).toBe('active');
  });

  it('stores observation with NULL branch', () => {
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, branch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('mem-branch-1', 'test-project', 'discovery', 'No branch obs', null, new Date().toISOString(), Date.now());

    const obs = db.prepare('SELECT branch FROM observations WHERE title = ?').get('No branch obs') as any;
    expect(obs.branch).toBeNull();
  });

  it('filters observations by branch including NULL', () => {
    // Insert observations on different branches
    const now = Date.now();
    db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, branch, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('mem-branch-1', 'test-project', 'discovery', 'On main', 'main', new Date().toISOString(), now + 1);
    db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, branch, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('mem-branch-1', 'test-project', 'discovery', 'On feature-x', 'feature-x', new Date().toISOString(), now + 2);

    // Filter for main branch (should include NULL and main, exclude feature-x)
    const results = db.prepare(`
      SELECT title FROM observations
      WHERE project = ? AND (branch IS NULL OR branch IN (?, ?))
      ORDER BY created_at_epoch DESC
    `).all('test-project', 'main', 'feature/branch-a') as any[];

    const titles = results.map((r: any) => r.title);
    expect(titles).toContain('On main');
    expect(titles).toContain('No branch obs');  // NULL branch included
    expect(titles).toContain('Test obs');  // feature/branch-a included
    expect(titles).not.toContain('On feature-x');  // different branch excluded
  });

  it('status defaults to active', () => {
    const obs = db.prepare('SELECT status FROM observations WHERE title = ?').get('On main') as any;
    expect(obs.status).toBe('active');
  });
});
