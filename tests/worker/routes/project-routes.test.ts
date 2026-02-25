/**
 * Tests for ProjectRoutes handler logic
 *
 * Tests the route handler business logic directly using an in-memory SQLite
 * database with real migrations, following the same pattern as active-session-routes.test.ts.
 * We do NOT spin up Express — instead we call the DB functions directly,
 * verifying the queries and response shapes the handlers use.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import {
  getProjectRowCounts,
  renameProject,
  mergeProject,
  deleteProject,
} from '../../../src/services/sqlite/ProjectOperations.js';
import type { Database } from '../../../src/services/sqlite/sqlite-compat.js';
import type { ProjectRowCounts } from '../../../src/services/sqlite/ProjectOperations.js';

// ---------------------------------------------------------------------------
// Types matching the expected API response shapes
// ---------------------------------------------------------------------------

interface GetCountsResponse {
  counts: ProjectRowCounts;
}

interface RenameResponse {
  success: true;
  counts: ProjectRowCounts;
}

interface MergeResponse {
  success: true;
  counts: ProjectRowCounts;
}

interface DeleteResponse {
  success: true;
  counts: ProjectRowCounts;
}

// ---------------------------------------------------------------------------
// Handler logic extracted for testability
// (mirrors what ProjectRoutes endpoints do)
// ---------------------------------------------------------------------------

function handleGetCounts(db: Database, projectName: string): GetCountsResponse {
  const counts = getProjectRowCounts(db, projectName);
  return { counts };
}

function handleRename(
  db: Database,
  projectName: string,
  newName: string
): RenameResponse | { error: string; status: 409 | 404 } {
  try {
    const counts = renameProject(db, projectName, newName);
    return { success: true, counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists')) {
      return { error: message, status: 409 };
    }
    if (message.includes('not found')) {
      return { error: message, status: 404 };
    }
    throw error;
  }
}

function handleMerge(
  db: Database,
  projectName: string,
  targetProject: string
): MergeResponse | { error: string; status: 404 } {
  try {
    const counts = mergeProject(db, projectName, targetProject);
    return { success: true, counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return { error: message, status: 404 };
    }
    throw error;
  }
}

function handleDelete(
  db: Database,
  projectName: string
): DeleteResponse | { error: string; status: 404 } {
  try {
    const counts = deleteProject(db, projectName);
    return { success: true, counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return { error: message, status: 404 };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert test rows for a project across all 4 tables.
 * Temporarily disables FK enforcement during setup.
 */
function insertProjectData(
  db: Database,
  project: string,
  counts: {
    sdk_sessions?: number;
    observations?: number;
    session_summaries?: number;
    context_injections?: number;
  } = {}
): void {
  const sessionCount = counts.sdk_sessions ?? 2;
  const observationCount = counts.observations ?? 3;
  const summaryCount = counts.session_summaries ?? 2;
  const injectionCount = counts.context_injections ?? 1;

  const prefix = `${project}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  db.run('PRAGMA foreign_keys = OFF');

  try {
    for (let i = 0; i < sessionCount; i++) {
      db.prepare(`
        INSERT INTO sdk_sessions
          (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?, 'completed')
      `).run(
        `${prefix}-session-${String(i)}`,
        `${prefix}-mem-${String(i)}`,
        project,
        `prompt ${String(i)}`,
        nowIso,
        now + i
      );
    }

    for (let i = 0; i < observationCount; i++) {
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
        VALUES (?, ?, 'discovery', ?, ?, ?, ?)
      `).run(
        `${prefix}-obs-mem-${String(i)}`,
        project,
        `title ${String(i)}`,
        `narrative ${String(i)}`,
        nowIso,
        now + i
      );
    }

    for (let i = 0; i < summaryCount; i++) {
      db.prepare(`
        INSERT INTO session_summaries
          (memory_session_id, project, request, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        `${prefix}-sum-mem-${String(i)}`,
        project,
        `request ${String(i)}`,
        nowIso,
        now + i
      );
    }

    for (let i = 0; i < injectionCount; i++) {
      db.prepare(`
        INSERT INTO context_injections
          (session_id, project, observation_ids, total_read_tokens, injection_source, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, 'session_start', ?, ?)
      `).run(
        `${prefix}-inj-${String(i)}`,
        project,
        '[1,2]',
        100,
        nowIso,
        now + i
      );
    }
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectRoutes handler logic', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  // ─── GET /api/projects/:name/counts ──────────────────────────────────────

  describe('GET /api/projects/:name/counts', () => {
    it('returns correct counts for an existing project', () => {
      insertProjectData(db, 'my-project', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 4,
      });

      const result = handleGetCounts(db, 'my-project');

      expect(result.counts.sdk_sessions).toBe(2);
      expect(result.counts.observations).toBe(3);
      expect(result.counts.session_summaries).toBe(1);
      expect(result.counts.context_injections).toBe(4);
    });

    it('returns zeros for a non-existent project', () => {
      const result = handleGetCounts(db, 'does-not-exist');

      expect(result.counts.sdk_sessions).toBe(0);
      expect(result.counts.observations).toBe(0);
      expect(result.counts.session_summaries).toBe(0);
      expect(result.counts.context_injections).toBe(0);
    });

    it('returns counts object with all required fields', () => {
      insertProjectData(db, 'check-fields', {
        sdk_sessions: 1,
        observations: 1,
        session_summaries: 1,
        context_injections: 1,
      });

      const result = handleGetCounts(db, 'check-fields');

      expect(result).toHaveProperty('counts');
      expect(result.counts).toHaveProperty('sdk_sessions');
      expect(result.counts).toHaveProperty('observations');
      expect(result.counts).toHaveProperty('session_summaries');
      expect(result.counts).toHaveProperty('context_injections');
    });

    it('does not include counts from other projects', () => {
      insertProjectData(db, 'project-a', { sdk_sessions: 5 });
      insertProjectData(db, 'project-b', { sdk_sessions: 3 });

      const result = handleGetCounts(db, 'project-b');

      expect(result.counts.sdk_sessions).toBe(3);
    });
  });

  // ─── POST /api/projects/:name/rename ─────────────────────────────────────

  describe('POST /api/projects/:name/rename', () => {
    it('succeeds and returns updated counts', () => {
      insertProjectData(db, 'old-name', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 2,
      });

      const result = handleRename(db, 'old-name', 'new-name');

      expect(result).toHaveProperty('success', true);
      if ('success' in result) {
        expect(result.counts.sdk_sessions).toBe(2);
        expect(result.counts.observations).toBe(3);
        expect(result.counts.session_summaries).toBe(1);
        expect(result.counts.context_injections).toBe(2);
      }
    });

    it('old project name has zero rows after rename', () => {
      insertProjectData(db, 'rename-src', { sdk_sessions: 1 });

      handleRename(db, 'rename-src', 'rename-dst');

      const oldCounts = getProjectRowCounts(db, 'rename-src');
      expect(oldCounts.sdk_sessions).toBe(0);
    });

    it('returns 409-equivalent error if target project already exists', () => {
      insertProjectData(db, 'project-a', { sdk_sessions: 1 });
      insertProjectData(db, 'project-b', { sdk_sessions: 1 });

      const result = handleRename(db, 'project-a', 'project-b');

      expect(result).toHaveProperty('status', 409);
      if ('status' in result) {
        expect(result.error).toContain('already exists');
      }
    });

    it('returns 404-equivalent error if source project not found', () => {
      const result = handleRename(db, 'ghost-project', 'new-name');

      expect(result).toHaveProperty('status', 404);
      if ('status' in result) {
        expect(result.error).toContain('not found');
      }
    });

    it('returns success true in the response shape', () => {
      insertProjectData(db, 'src-proj', { sdk_sessions: 1 });

      const result = handleRename(db, 'src-proj', 'dst-proj');

      expect('success' in result && result.success).toBe(true);
    });
  });

  // ─── POST /api/projects/:name/merge ──────────────────────────────────────

  describe('POST /api/projects/:name/merge', () => {
    it('succeeds and returns counts of moved rows', () => {
      insertProjectData(db, 'source-proj', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 1,
      });
      insertProjectData(db, 'target-proj', {
        sdk_sessions: 1,
        observations: 1,
        session_summaries: 0,
        context_injections: 0,
      });

      const result = handleMerge(db, 'source-proj', 'target-proj');

      expect(result).toHaveProperty('success', true);
      if ('success' in result) {
        expect(result.counts.sdk_sessions).toBe(2);
        expect(result.counts.observations).toBe(3);
        expect(result.counts.session_summaries).toBe(1);
        expect(result.counts.context_injections).toBe(1);
      }
    });

    it('source project has zero rows after merge', () => {
      insertProjectData(db, 'from', { sdk_sessions: 2 });
      insertProjectData(db, 'into', { sdk_sessions: 1 });

      handleMerge(db, 'from', 'into');

      const fromCounts = getProjectRowCounts(db, 'from');
      expect(fromCounts.sdk_sessions).toBe(0);
    });

    it('returns 404-equivalent error if target project does not exist', () => {
      insertProjectData(db, 'source-only', { sdk_sessions: 1 });

      const result = handleMerge(db, 'source-only', 'nonexistent-target');

      expect(result).toHaveProperty('status', 404);
      if ('status' in result) {
        expect(result.error).toContain('not found');
      }
    });

    it('returns 404-equivalent error if source project does not exist', () => {
      insertProjectData(db, 'target-only', { sdk_sessions: 1 });

      const result = handleMerge(db, 'nonexistent-source', 'target-only');

      expect(result).toHaveProperty('status', 404);
      if ('status' in result) {
        expect(result.error).toContain('not found');
      }
    });

    it('target has combined row counts after merge', () => {
      insertProjectData(db, 'merge-src', { sdk_sessions: 3 });
      insertProjectData(db, 'merge-dst', { sdk_sessions: 2 });

      handleMerge(db, 'merge-src', 'merge-dst');

      const dstCounts = getProjectRowCounts(db, 'merge-dst');
      expect(dstCounts.sdk_sessions).toBe(5);
    });
  });

  // ─── DELETE /api/projects/:name ───────────────────────────────────────────

  describe('DELETE /api/projects/:name', () => {
    it('succeeds and returns counts of deleted rows', () => {
      insertProjectData(db, 'to-delete', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 2,
      });

      const result = handleDelete(db, 'to-delete');

      expect(result).toHaveProperty('success', true);
      if ('success' in result) {
        expect(result.counts.sdk_sessions).toBe(2);
        expect(result.counts.observations).toBe(3);
        expect(result.counts.session_summaries).toBe(1);
        expect(result.counts.context_injections).toBe(2);
      }
    });

    it('project has zero rows after delete', () => {
      insertProjectData(db, 'gone', { sdk_sessions: 2, observations: 1 });

      handleDelete(db, 'gone');

      const counts = getProjectRowCounts(db, 'gone');
      expect(counts.sdk_sessions).toBe(0);
      expect(counts.observations).toBe(0);
    });

    it('returns 404-equivalent error if project not found', () => {
      const result = handleDelete(db, 'phantom-project');

      expect(result).toHaveProperty('status', 404);
      if ('status' in result) {
        expect(result.error).toContain('not found');
      }
    });

    it('does not affect other projects when deleting one', () => {
      insertProjectData(db, 'keep-me', { sdk_sessions: 3, observations: 2 });
      insertProjectData(db, 'delete-me', { sdk_sessions: 1, observations: 1 });

      handleDelete(db, 'delete-me');

      const keepCounts = getProjectRowCounts(db, 'keep-me');
      expect(keepCounts.sdk_sessions).toBe(3);
      expect(keepCounts.observations).toBe(2);
    });

    it('returns success true in the response shape', () => {
      insertProjectData(db, 'del-proj', { sdk_sessions: 1 });

      const result = handleDelete(db, 'del-proj');

      expect('success' in result && result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// API_ENDPOINTS constant tests
// ---------------------------------------------------------------------------

describe('API_ENDPOINTS projects constant', () => {
  it('exports PROJECTS_BASE endpoint', async () => {
    const { API_ENDPOINTS } = await import('../../../src/ui/viewer/constants/api.js');
    expect(API_ENDPOINTS.PROJECTS_BASE).toBe('/api/projects');
  });
});

// ---------------------------------------------------------------------------
// ProjectRoutes class structure tests
// ---------------------------------------------------------------------------

describe('ProjectRoutes class', () => {
  it('can be imported', async () => {
    const { ProjectRoutes } = await import('../../../src/services/worker/http/routes/ProjectRoutes.js');
    expect(ProjectRoutes).toBeDefined();
  });

  it('is constructible with a DatabaseManager', async () => {
    const { ProjectRoutes } = await import('../../../src/services/worker/http/routes/ProjectRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const dbManager = new DatabaseManager();
    const routes = new ProjectRoutes(dbManager);
    expect(routes).toBeDefined();
  });

  it('has a setupRoutes method', async () => {
    const { ProjectRoutes } = await import('../../../src/services/worker/http/routes/ProjectRoutes.js');
    const { DatabaseManager } = await import('../../../src/services/worker/DatabaseManager.js');

    const dbManager = new DatabaseManager();
    const routes = new ProjectRoutes(dbManager);
    expect(typeof routes.setupRoutes).toBe('function');
  });
});
