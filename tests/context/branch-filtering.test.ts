/**
 * Tests for branch-based observation filtering in context generation.
 *
 * Validates that queryObservations and queryObservationsMulti correctly
 * filter observations based on commit SHA visibility:
 * - null visibleCommitShas → no filtering (backward compatible)
 * - empty array → only pre-migration observations (commit_sha IS NULL)
 * - populated array → ancestors + pre-migration observations
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservations, queryObservationsMulti } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

describe('Branch-based observation filtering', () => {
  let store: SessionStore;

  // Minimal config that matches all observation types and concepts
  const config: ContextConfig = {
    totalObservationCount: 100,
    fullObservationCount: 5,
    sessionCount: 5,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: false,
    observationTypes: new Set(['discovery', 'feature', 'bugfix']),
    observationConcepts: new Set(['how-it-works']),
    fullObservationField: 'narrative',
    showLastSummary: false,
    showLastMessage: false,
  };

  beforeEach(() => {
    store = new SessionStore(':memory:');

    // Ensure branch columns exist (migration 24 may or may not run in SessionStore)
    try {
      store.db.run('ALTER TABLE observations ADD COLUMN branch TEXT');
    } catch { /* column may already exist from migrations */ }
    try {
      store.db.run('ALTER TABLE observations ADD COLUMN commit_sha TEXT');
    } catch { /* column may already exist from migrations */ }

    // Create a session for FK constraint using proper schema columns
    store.db.run(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES ('test-session', 'mem-session-1', 'test-project', 'test prompt', datetime('now'), ${Date.now()}, 'active')
    `);

    // Insert observations with different commit_sha values
    const insertObs = store.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, type, title, subtitle, narrative,
        facts, concepts, files_read, files_modified, discovery_tokens,
        created_at, created_at_epoch, branch, commit_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
    `);

    // Pre-migration observation (null commit_sha) — should always be visible
    insertObs.run(
      'mem-session-1', 'test-project', 'discovery',
      'Pre-migration obs', 'subtitle', 'narrative',
      '["fact1"]', '["how-it-works"]', '[]', '[]', 100,
      1000, null, null
    );

    // Observation on current branch (commit abc123)
    insertObs.run(
      'mem-session-1', 'test-project', 'discovery',
      'Current branch obs', 'subtitle', 'narrative',
      '["fact1"]', '["how-it-works"]', '[]', '[]', 200,
      2000, 'main', 'abc123'
    );

    // Observation on a sibling branch (commit def456)
    insertObs.run(
      'mem-session-1', 'test-project', 'discovery',
      'Sibling branch obs', 'subtitle', 'narrative',
      '["fact1"]', '["how-it-works"]', '[]', '[]', 300,
      3000, 'feature-x', 'def456'
    );

    // Observation on merged branch (commit ghi789)
    insertObs.run(
      'mem-session-1', 'test-project', 'discovery',
      'Merged branch obs', 'subtitle', 'narrative',
      '["fact1"]', '["how-it-works"]', '[]', '[]', 400,
      4000, 'feature-y', 'ghi789'
    );
  });

  afterEach(() => {
    store.close();
  });

  describe('queryObservations with visibleCommitShas', () => {
    it('should return all observations when visibleCommitShas is null (no git repo)', () => {
      const results = queryObservations(store, 'test-project', config, null);
      expect(results).toHaveLength(4);
    });

    it('should return all observations when visibleCommitShas is undefined (backward compatible)', () => {
      const results = queryObservations(store, 'test-project', config);
      expect(results).toHaveLength(4);
    });

    it('should return only pre-migration observations when visibleCommitShas is empty array', () => {
      const results = queryObservations(store, 'test-project', config, []);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Pre-migration obs');
    });

    it('should return pre-migration + ancestor observations when visibleCommitShas is populated', () => {
      // Only abc123 and ghi789 are "ancestors" of current HEAD
      const results = queryObservations(store, 'test-project', config, ['abc123', 'ghi789']);
      expect(results).toHaveLength(3); // pre-migration + abc123 + ghi789
      const titles = results.map(r => r.title);
      expect(titles).toContain('Pre-migration obs');
      expect(titles).toContain('Current branch obs');
      expect(titles).toContain('Merged branch obs');
      expect(titles).not.toContain('Sibling branch obs');
    });

    it('should exclude sibling branch observations', () => {
      // Only abc123 is an ancestor — def456 (sibling) and ghi789 (not ancestor) excluded
      const results = queryObservations(store, 'test-project', config, ['abc123']);
      expect(results).toHaveLength(2); // pre-migration + abc123
      const titles = results.map(r => r.title);
      expect(titles).toContain('Pre-migration obs');
      expect(titles).toContain('Current branch obs');
      expect(titles).not.toContain('Sibling branch obs');
      expect(titles).not.toContain('Merged branch obs');
    });
  });

  describe('queryObservationsMulti with visibleCommitShas', () => {
    beforeEach(() => {
      // Add a second project session for multi-project testing
      store.db.run(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES ('test-session-2', 'mem-session-2', 'test-project-2', 'test prompt 2', datetime('now'), ${Date.now()}, 'active')
      `);

      // Insert observation in second project
      store.db.prepare(`
        INSERT INTO observations (
          memory_session_id, project, type, title, subtitle, narrative,
          facts, concepts, files_read, files_modified, discovery_tokens,
          created_at, created_at_epoch, branch, commit_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
      `).run(
        'mem-session-2', 'test-project-2', 'discovery',
        'Other project obs', 'subtitle', 'narrative',
        '["fact1"]', '["how-it-works"]', '[]', '[]', 500,
        5000, 'main', 'abc123'
      );
    });

    it('should filter across multiple projects when visibleCommitShas is populated', () => {
      const results = queryObservationsMulti(
        store,
        ['test-project', 'test-project-2'],
        config,
        ['abc123']
      );
      // pre-migration (project 1) + abc123 (project 1) + abc123 (project 2)
      expect(results).toHaveLength(3);
      const titles = results.map(r => r.title);
      expect(titles).toContain('Pre-migration obs');
      expect(titles).toContain('Current branch obs');
      expect(titles).toContain('Other project obs');
      expect(titles).not.toContain('Sibling branch obs');
    });

    it('should return all observations from all projects when visibleCommitShas is null', () => {
      const results = queryObservationsMulti(
        store,
        ['test-project', 'test-project-2'],
        config,
        null
      );
      expect(results).toHaveLength(5); // 4 from project 1 + 1 from project 2
    });
  });
});
