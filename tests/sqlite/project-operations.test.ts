/**
 * Project operations tests (rename, merge, delete, row count preview)
 * Tests all 4 tables: sdk_sessions, observations, session_summaries, context_injections
 * Uses in-memory database with ClaudeMemDatabase.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  getProjectRowCounts,
  renameProject,
  mergeProject,
  deleteProject,
} from '../../src/services/sqlite/ProjectOperations.js';
import type { Database } from '../../src/services/sqlite/sqlite-compat.js';

// ─── Test data helpers ────────────────────────────────────────────────────────

/**
 * Insert test rows for a project across all 4 tables.
 *
 * The observations and session_summaries tables have FK constraints on
 * memory_session_id referencing sdk_sessions(memory_session_id). This helper
 * temporarily disables FK enforcement during setup so we can insert arbitrary
 * test data without coupling the row counts to session topology.
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

  // Use a unique prefix to avoid collisions when multiple projects are inserted
  const prefix = `${project}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Temporarily disable FK checks so we can insert arbitrary test fixtures
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

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('ProjectOperations', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  // ─── getProjectRowCounts ──────────────────────────────────────────────────

  describe('getProjectRowCounts', () => {
    it('returns correct counts for a project with data in all tables', () => {
      insertProjectData(db, 'my-project', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 4,
      });

      const counts = getProjectRowCounts(db, 'my-project');

      expect(counts.sdk_sessions).toBe(2);
      expect(counts.observations).toBe(3);
      expect(counts.session_summaries).toBe(1);
      expect(counts.context_injections).toBe(4);
    });

    it('returns zeros for a non-existent project', () => {
      const counts = getProjectRowCounts(db, 'does-not-exist');

      expect(counts.sdk_sessions).toBe(0);
      expect(counts.observations).toBe(0);
      expect(counts.session_summaries).toBe(0);
      expect(counts.context_injections).toBe(0);
    });

    it('returns correct counts when project has data in some tables but not all', () => {
      insertProjectData(db, 'partial-project', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 2,
      });

      const counts = getProjectRowCounts(db, 'partial-project');

      expect(counts.sdk_sessions).toBe(1);
      expect(counts.observations).toBe(0);
      expect(counts.session_summaries).toBe(0);
      expect(counts.context_injections).toBe(2);
    });

    it('does not count rows from other projects', () => {
      insertProjectData(db, 'project-a', {
        sdk_sessions: 3,
        observations: 5,
        session_summaries: 2,
        context_injections: 1,
      });
      insertProjectData(db, 'project-b', {
        sdk_sessions: 1,
        observations: 2,
        session_summaries: 1,
        context_injections: 0,
      });

      const counts = getProjectRowCounts(db, 'project-a');

      expect(counts.sdk_sessions).toBe(3);
      expect(counts.observations).toBe(5);
      expect(counts.session_summaries).toBe(2);
      expect(counts.context_injections).toBe(1);
    });
  });

  // ─── renameProject ────────────────────────────────────────────────────────

  describe('renameProject', () => {
    it('renames a project across all 4 tables', () => {
      insertProjectData(db, 'old-name', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 2,
      });

      renameProject(db, 'old-name', 'new-name');

      const oldCounts = getProjectRowCounts(db, 'old-name');
      const newCounts = getProjectRowCounts(db, 'new-name');

      expect(oldCounts.sdk_sessions).toBe(0);
      expect(oldCounts.observations).toBe(0);
      expect(oldCounts.session_summaries).toBe(0);
      expect(oldCounts.context_injections).toBe(0);

      expect(newCounts.sdk_sessions).toBe(2);
      expect(newCounts.observations).toBe(3);
      expect(newCounts.session_summaries).toBe(1);
      expect(newCounts.context_injections).toBe(2);
    });

    it('returns the counts of updated rows per table', () => {
      insertProjectData(db, 'source', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 2,
      });

      const result = renameProject(db, 'source', 'dest');

      expect(result.sdk_sessions).toBe(2);
      expect(result.observations).toBe(3);
      expect(result.session_summaries).toBe(1);
      expect(result.context_injections).toBe(2);
    });

    it('throws if target name already exists', () => {
      insertProjectData(db, 'project-a', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });
      insertProjectData(db, 'project-b', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });

      expect(() => renameProject(db, 'project-a', 'project-b')).toThrow(
        'Target project already exists: project-b'
      );
    });

    it('throws if source project does not exist', () => {
      expect(() => renameProject(db, 'ghost', 'new-name')).toThrow(
        'Source project not found: ghost'
      );
    });

    it('after rename, old name has zero rows and new name has original counts', () => {
      insertProjectData(db, 'rename-me', {
        sdk_sessions: 4,
        observations: 6,
        session_summaries: 3,
        context_injections: 1,
      });

      renameProject(db, 'rename-me', 'renamed');

      expect(getProjectRowCounts(db, 'rename-me')).toEqual({
        sdk_sessions: 0,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });
      expect(getProjectRowCounts(db, 'renamed')).toEqual({
        sdk_sessions: 4,
        observations: 6,
        session_summaries: 3,
        context_injections: 1,
      });
    });

    it('renames correctly when some tables have zero rows for the project', () => {
      insertProjectData(db, 'sparse-project', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });

      const result = renameProject(db, 'sparse-project', 'sparse-new');

      expect(result.sdk_sessions).toBe(1);
      expect(result.observations).toBe(0);
      expect(result.session_summaries).toBe(0);
      expect(result.context_injections).toBe(0);
    });

    it('throws if renaming to the same name', () => {
      insertProjectData(db, 'same-name', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });

      expect(() => renameProject(db, 'same-name', 'same-name')).toThrow(
        'New name must be different from the current name'
      );
    });
  });

  // ─── mergeProject ─────────────────────────────────────────────────────────

  describe('mergeProject', () => {
    it('merges source into target across all 4 tables', () => {
      insertProjectData(db, 'source-proj', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 1,
      });
      insertProjectData(db, 'target-proj', {
        sdk_sessions: 1,
        observations: 2,
        session_summaries: 1,
        context_injections: 0,
      });

      mergeProject(db, 'source-proj', 'target-proj');

      const sourceCounts = getProjectRowCounts(db, 'source-proj');
      const targetCounts = getProjectRowCounts(db, 'target-proj');

      expect(sourceCounts.sdk_sessions).toBe(0);
      expect(sourceCounts.observations).toBe(0);
      expect(sourceCounts.session_summaries).toBe(0);
      expect(sourceCounts.context_injections).toBe(0);

      expect(targetCounts.sdk_sessions).toBe(3); // 2 + 1
      expect(targetCounts.observations).toBe(5); // 3 + 2
      expect(targetCounts.session_summaries).toBe(2); // 1 + 1
      expect(targetCounts.context_injections).toBe(1); // 1 + 0
    });

    it('returns counts of updated rows per table', () => {
      insertProjectData(db, 'src', {
        sdk_sessions: 2,
        observations: 4,
        session_summaries: 1,
        context_injections: 3,
      });
      insertProjectData(db, 'tgt', {
        sdk_sessions: 1,
        observations: 1,
        session_summaries: 0,
        context_injections: 0,
      });

      const result = mergeProject(db, 'src', 'tgt');

      expect(result.sdk_sessions).toBe(2);
      expect(result.observations).toBe(4);
      expect(result.session_summaries).toBe(1);
      expect(result.context_injections).toBe(3);
    });

    it('throws if target project does not exist', () => {
      insertProjectData(db, 'source-only', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });

      expect(() => mergeProject(db, 'source-only', 'nonexistent-target')).toThrow(
        'Target project not found: nonexistent-target'
      );
    });

    it('throws if source project does not exist', () => {
      insertProjectData(db, 'target-only', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });

      expect(() => mergeProject(db, 'nonexistent-source', 'target-only')).toThrow(
        'Source project not found: nonexistent-source'
      );
    });

    it('throws if merging a project into itself', () => {
      insertProjectData(db, 'self-merge', {
        sdk_sessions: 1,
        observations: 1,
        session_summaries: 0,
        context_injections: 0,
      });

      expect(() => mergeProject(db, 'self-merge', 'self-merge')).toThrow(
        'Cannot merge a project into itself'
      );
    });

    it('after merge, source has zero rows and target has combined counts', () => {
      insertProjectData(db, 'from', {
        sdk_sessions: 3,
        observations: 5,
        session_summaries: 2,
        context_injections: 1,
      });
      insertProjectData(db, 'into', {
        sdk_sessions: 1,
        observations: 1,
        session_summaries: 1,
        context_injections: 1,
      });

      mergeProject(db, 'from', 'into');

      expect(getProjectRowCounts(db, 'from')).toEqual({
        sdk_sessions: 0,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });
      expect(getProjectRowCounts(db, 'into')).toEqual({
        sdk_sessions: 4,
        observations: 6,
        session_summaries: 3,
        context_injections: 2,
      });
    });
  });

  // ─── deleteProject ────────────────────────────────────────────────────────

  describe('deleteProject', () => {
    it('deletes from all 4 tables', () => {
      insertProjectData(db, 'to-delete', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 2,
      });

      deleteProject(db, 'to-delete');

      const counts = getProjectRowCounts(db, 'to-delete');

      expect(counts.sdk_sessions).toBe(0);
      expect(counts.observations).toBe(0);
      expect(counts.session_summaries).toBe(0);
      expect(counts.context_injections).toBe(0);
    });

    it('returns counts of deleted rows per table', () => {
      insertProjectData(db, 'del-proj', {
        sdk_sessions: 2,
        observations: 5,
        session_summaries: 3,
        context_injections: 1,
      });

      const result = deleteProject(db, 'del-proj');

      expect(result.sdk_sessions).toBe(2);
      expect(result.observations).toBe(5);
      expect(result.session_summaries).toBe(3);
      expect(result.context_injections).toBe(1);
    });

    it('after delete, project has zero rows in all tables', () => {
      insertProjectData(db, 'gone', {
        sdk_sessions: 1,
        observations: 2,
        session_summaries: 1,
        context_injections: 1,
      });

      deleteProject(db, 'gone');

      expect(getProjectRowCounts(db, 'gone')).toEqual({
        sdk_sessions: 0,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });
    });

    it('throws if project does not exist', () => {
      expect(() => deleteProject(db, 'phantom')).toThrow('Project not found: phantom');
    });

    it('does not affect rows from other projects', () => {
      insertProjectData(db, 'keep-me', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 1,
      });
      insertProjectData(db, 'delete-me', {
        sdk_sessions: 1,
        observations: 2,
        session_summaries: 1,
        context_injections: 0,
      });

      deleteProject(db, 'delete-me');

      const keepCounts = getProjectRowCounts(db, 'keep-me');
      expect(keepCounts.sdk_sessions).toBe(2);
      expect(keepCounts.observations).toBe(3);
      expect(keepCounts.session_summaries).toBe(1);
      expect(keepCounts.context_injections).toBe(1);
    });
  });

  // ─── Transaction atomicity ───────────────────────────────────────────────

  describe('transaction atomicity', () => {
    it('renameProject leaves data unchanged if target project already exists', () => {
      insertProjectData(db, 'atomic-src', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 1,
      });
      insertProjectData(db, 'atomic-tgt', {
        sdk_sessions: 1,
        observations: 0,
        session_summaries: 0,
        context_injections: 0,
      });

      // This should throw because target already exists
      expect(() => renameProject(db, 'atomic-src', 'atomic-tgt')).toThrow();

      // Source data must remain intact
      expect(getProjectRowCounts(db, 'atomic-src')).toEqual({
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 1,
      });
    });

    it('deleteProject leaves data unchanged when project does not exist', () => {
      insertProjectData(db, 'safe-project', {
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 1,
      });

      // Deleting a non-existent project should throw
      expect(() => deleteProject(db, 'nonexistent')).toThrow();

      // Existing project data must remain intact
      expect(getProjectRowCounts(db, 'safe-project')).toEqual({
        sdk_sessions: 2,
        observations: 3,
        session_summaries: 1,
        context_injections: 1,
      });
    });

    it('mergeProject leaves both projects unchanged if source does not exist', () => {
      insertProjectData(db, 'real-target', {
        sdk_sessions: 3,
        observations: 4,
        session_summaries: 2,
        context_injections: 2,
      });

      expect(() => mergeProject(db, 'fake-source', 'real-target')).toThrow();

      // Target data must remain intact
      expect(getProjectRowCounts(db, 'real-target')).toEqual({
        sdk_sessions: 3,
        observations: 4,
        session_summaries: 2,
        context_injections: 2,
      });
    });
  });
});
