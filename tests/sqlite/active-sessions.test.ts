/**
 * Active session management tests
 * Tests getActiveSessions, closeSessionById, and closeStaleSessionsOlderThan
 * using an in-memory database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import {
  getActiveSessions,
  closeSessionById,
  closeStaleSessionsOlderThan,
} from '../../src/services/sqlite/Sessions.js';
import type { Database } from '../../src/services/sqlite/sqlite-compat.js';

describe('Active Session Management', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  // ─── getActiveSessions ────────────────────────────────────────────────────

  describe('getActiveSessions', () => {
    it('returns empty array when no sessions exist', () => {
      const result = getActiveSessions(db);
      expect(result).toEqual([]);
    });

    it('returns empty array when no sessions are active', () => {
      const sessionId = createSDKSession(db, 'session-completed', 'project-a', 'prompt-a');
      closeSessionById(db, sessionId);

      const result = getActiveSessions(db);
      expect(result).toEqual([]);
    });

    it('returns only active sessions excluding completed ones', () => {
      const activeId = createSDKSession(db, 'session-active', 'project-a', 'active prompt');
      const completedId = createSDKSession(db, 'session-done', 'project-a', 'done prompt');
      closeSessionById(db, completedId);

      const result = getActiveSessions(db);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(activeId);
      expect(result[0].content_session_id).toBe('session-active');
    });

    it('returns all required fields on ActiveSessionRow', () => {
      const sessionId = createSDKSession(db, 'session-fields', 'my-project', 'my prompt');

      const result = getActiveSessions(db);

      expect(result).toHaveLength(1);
      const row = result[0];
      expect(typeof row.id).toBe('number');
      expect(row.id).toBe(sessionId);
      expect(row.content_session_id).toBe('session-fields');
      expect(row.project).toBe('my-project');
      expect(row.user_prompt).toBe('my prompt');
      expect(typeof row.started_at_epoch).toBe('number');
      expect(row.started_at_epoch).toBeGreaterThan(0);
    });

    it('returns multiple active sessions ordered by started_at_epoch DESC', () => {
      // Create sessions with slightly different times by manually inserting
      const now = Date.now();
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('older-session', 'project', 'prompt', new Date(now - 5000).toISOString(), now - 5000);

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('newer-session', 'project', 'prompt', new Date(now).toISOString(), now);

      const result = getActiveSessions(db);

      expect(result).toHaveLength(2);
      expect(result[0].content_session_id).toBe('newer-session');
      expect(result[1].content_session_id).toBe('older-session');
    });
  });

  // ─── closeSessionById ─────────────────────────────────────────────────────

  describe('closeSessionById', () => {
    it('closes an active session and returns true', () => {
      const sessionId = createSDKSession(db, 'session-to-close', 'project', 'prompt');

      const result = closeSessionById(db, sessionId);

      expect(result).toBe(true);
    });

    it('sets status to completed after closing', () => {
      const sessionId = createSDKSession(db, 'session-status-check', 'project', 'prompt');
      closeSessionById(db, sessionId);

      const row = db.prepare('SELECT status FROM sdk_sessions WHERE id = ?').get(sessionId) as { status: string };
      expect(row.status).toBe('completed');
    });

    it('sets completed_at (ISO string) after closing', () => {
      const sessionId = createSDKSession(db, 'session-completed-at', 'project', 'prompt');
      closeSessionById(db, sessionId);

      const row = db.prepare('SELECT completed_at FROM sdk_sessions WHERE id = ?').get(sessionId) as { completed_at: string };
      expect(row.completed_at).not.toBeNull();
      // ISO 8601 format check
      expect(() => new Date(row.completed_at)).not.toThrow();
      expect(new Date(row.completed_at).getTime()).toBeGreaterThan(0);
    });

    it('sets completed_at_epoch (epoch ms) after closing', () => {
      const beforeClose = Date.now();
      const sessionId = createSDKSession(db, 'session-epoch', 'project', 'prompt');
      closeSessionById(db, sessionId);
      const afterClose = Date.now();

      const row = db.prepare('SELECT completed_at_epoch FROM sdk_sessions WHERE id = ?').get(sessionId) as { completed_at_epoch: number };
      expect(row.completed_at_epoch).toBeGreaterThanOrEqual(beforeClose);
      expect(row.completed_at_epoch).toBeLessThanOrEqual(afterClose);
    });

    it('removes the session from getActiveSessions after closing', () => {
      const sessionId = createSDKSession(db, 'session-removed', 'project', 'prompt');
      expect(getActiveSessions(db)).toHaveLength(1);

      closeSessionById(db, sessionId);

      expect(getActiveSessions(db)).toHaveLength(0);
    });

    it('returns false for a non-existent session ID', () => {
      const result = closeSessionById(db, 99999);
      expect(result).toBe(false);
    });

    it('returns false when session is already completed', () => {
      const sessionId = createSDKSession(db, 'session-already-done', 'project', 'prompt');
      closeSessionById(db, sessionId);

      // Second close attempt should return false
      const result = closeSessionById(db, sessionId);
      expect(result).toBe(false);
    });

    it('does not affect other active sessions', () => {
      const keepId = createSDKSession(db, 'session-keep', 'project', 'keep');
      const closeMe = createSDKSession(db, 'session-close-me', 'project', 'close');

      closeSessionById(db, closeMe);

      const active = getActiveSessions(db);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(keepId);
    });
  });

  // ─── closeStaleSessionsOlderThan ─────────────────────────────────────────

  describe('closeStaleSessionsOlderThan', () => {
    it('returns 0 when no sessions exist', () => {
      const result = closeStaleSessionsOlderThan(db, Date.now());
      expect(result).toBe(0);
    });

    it('returns 0 when no active sessions match the threshold', () => {
      const now = Date.now();
      // Session started NOW — not older than threshold
      createSDKSession(db, 'fresh-session', 'project', 'prompt');

      const result = closeStaleSessionsOlderThan(db, now - 10000);
      expect(result).toBe(0);
    });

    it('closes sessions older than the threshold and returns count', () => {
      const now = Date.now();
      const oldEpoch = now - 60_000; // 60 seconds ago

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('stale-session-1', 'project', 'old prompt', new Date(oldEpoch).toISOString(), oldEpoch);

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('stale-session-2', 'project', 'old prompt 2', new Date(oldEpoch).toISOString(), oldEpoch);

      // Threshold is 30 seconds ago — both sessions are older
      const result = closeStaleSessionsOlderThan(db, now - 30_000);

      expect(result).toBe(2);
    });

    it('does not close sessions newer than the threshold', () => {
      const now = Date.now();
      const oldEpoch = now - 60_000;

      // One old session
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('stale-one', 'project', 'old', new Date(oldEpoch).toISOString(), oldEpoch);

      // One fresh session (started just now via createSDKSession)
      createSDKSession(db, 'fresh-one', 'project', 'fresh');

      // Threshold: 30 seconds ago — only the old one should close
      const result = closeStaleSessionsOlderThan(db, now - 30_000);

      expect(result).toBe(1);
      expect(getActiveSessions(db)).toHaveLength(1);
      expect(getActiveSessions(db)[0].content_session_id).toBe('fresh-one');
    });

    it('does not close already-completed sessions', () => {
      const now = Date.now();
      const oldEpoch = now - 60_000;

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'completed')
      `).run('already-completed', 'project', 'old done', new Date(oldEpoch).toISOString(), oldEpoch);

      const result = closeStaleSessionsOlderThan(db, now);
      expect(result).toBe(0);
    });

    it('sets completed_at and completed_at_epoch on closed stale sessions', () => {
      const now = Date.now();
      const oldEpoch = now - 60_000;

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('stale-timestamps', 'project', 'stale', new Date(oldEpoch).toISOString(), oldEpoch);

      closeStaleSessionsOlderThan(db, now);

      const row = db.prepare('SELECT status, completed_at, completed_at_epoch FROM sdk_sessions WHERE content_session_id = ?')
        .get('stale-timestamps') as { status: string; completed_at: string; completed_at_epoch: number };

      expect(row.status).toBe('completed');
      expect(row.completed_at).not.toBeNull();
      expect(row.completed_at_epoch).toBeGreaterThan(0);
    });
  });
});
