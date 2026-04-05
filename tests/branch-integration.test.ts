/**
 * Branch-scoped observations integration tests
 * Tests the full branch-scoped flow: filtering, merged visibility, legacy (NULL) inclusion
 *
 * Sources:
 * - buildBranchFilter from src/utils/branch-filter.ts
 * - getCurrentBranch from src/utils/branch.ts
 * - Branch/status columns from migration (ALTER TABLE observations ADD COLUMN branch/status)
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ClaudeMemDatabase } from '../src/services/sqlite/Database.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../src/services/sqlite/Sessions.js';
import { buildBranchFilter } from '../src/utils/branch-filter.js';
import { getCurrentBranch } from '../src/utils/branch.js';
import type { Database } from 'bun:sqlite';

describe('branch-scoped observations integration', () => {
  let db: Database;

  beforeAll(() => {
    db = new ClaudeMemDatabase(':memory:').db;

    // Create a session for FK constraint
    const sessionDbId = createSDKSession(db, 'content-integration', 'proj', 'test prompt');
    updateMemorySessionId(db, sessionDbId, 's1');

    // Seed observations across branches
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, branch, status, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('s1', 'proj', 'discovery', 'Branch A obs', 'branch-a', 'active', new Date().toISOString(), now);
    insert.run('s1', 'proj', 'discovery', 'Branch B obs', 'branch-b', 'active', new Date().toISOString(), now + 1);
    insert.run('s1', 'proj', 'discovery', 'Main obs', 'main', 'active', new Date().toISOString(), now + 2);
    insert.run('s1', 'proj', 'discovery', 'Legacy obs', null, 'active', new Date().toISOString(), now + 3);
    insert.run('s1', 'proj', 'discovery', 'Discarded obs', 'branch-a', 'discarded_by_llm', new Date().toISOString(), now + 4);
  });

  afterAll(() => {
    db.close();
  });

  it('branch-a sees own observations and legacy (NULL)', () => {
    const bf = buildBranchFilter(['branch-a']);
    const results = db.prepare(`SELECT title FROM observations WHERE project = ? ${bf.sql} AND status = 'active' ORDER BY created_at_epoch`).all('proj', ...bf.params) as any[];
    const titles = results.map((r: any) => r.title);
    expect(titles).toContain('Branch A obs');
    expect(titles).toContain('Legacy obs');
    expect(titles).not.toContain('Branch B obs');
    expect(titles).not.toContain('Main obs');
  });

  it('branch-b sees own observations and legacy (NULL)', () => {
    const bf = buildBranchFilter(['branch-b']);
    const results = db.prepare(`SELECT title FROM observations WHERE project = ? ${bf.sql} AND status = 'active' ORDER BY created_at_epoch`).all('proj', ...bf.params) as any[];
    const titles = results.map((r: any) => r.title);
    expect(titles).toContain('Branch B obs');
    expect(titles).toContain('Legacy obs');
    expect(titles).not.toContain('Branch A obs');
  });

  it('merged branches see combined observations', () => {
    const bf = buildBranchFilter(['main', 'branch-a']);
    const results = db.prepare(`SELECT title FROM observations WHERE project = ? ${bf.sql} AND status = 'active' ORDER BY created_at_epoch`).all('proj', ...bf.params) as any[];
    const titles = results.map((r: any) => r.title);
    expect(titles).toContain('Branch A obs');
    expect(titles).toContain('Main obs');
    expect(titles).toContain('Legacy obs');
    expect(titles).not.toContain('Branch B obs');
  });

  it('no branch filter returns all active observations', () => {
    const bf = buildBranchFilter(null);
    const results = db.prepare(`SELECT title FROM observations WHERE project = ? ${bf.sql} AND status = 'active' ORDER BY created_at_epoch`).all('proj', ...bf.params) as any[];
    expect(results.length).toBe(4); // all active (excludes the discarded one)
  });

  it('discarded observations are excluded by status filter', () => {
    const bf = buildBranchFilter(['branch-a']);
    const results = db.prepare(`SELECT title FROM observations WHERE project = ? ${bf.sql} AND status = 'active' ORDER BY created_at_epoch`).all('proj', ...bf.params) as any[];
    expect(results.map((r: any) => r.title)).not.toContain('Discarded obs');
  });

  it('getCurrentBranch works in real git repo', () => {
    const branch = getCurrentBranch(process.cwd());
    expect(branch).toBeTruthy();
    expect(typeof branch).toBe('string');
  });
});
