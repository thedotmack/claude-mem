/**
 * Tests for session project update on resume
 *
 * Validates that createSDKSession correctly updates the project field
 * when a session is re-initialized with a different working directory.
 *
 * Bug: INSERT OR IGNORE locked the project on first insert, never updating it.
 * Fix: Add conditional UPDATE after INSERT OR IGNORE when project is non-empty.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  createSDKSession,
  getSessionById,
} from '../../src/services/sqlite/Sessions.js';
import type { Database } from '../../src/services/sqlite/sqlite-compat.js';

describe('Session project update on resume', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  it('should keep same project when re-init with same project', () => {
    const contentSessionId = 'session-same-project';
    const project = 'cloud';

    const id1 = createSDKSession(db, contentSessionId, project, 'Prompt 1');
    const id2 = createSDKSession(db, contentSessionId, project, 'Prompt 2');

    expect(id1).toBe(id2);
    const session = getSessionById(db, id1);
    expect(session?.project).toBe('cloud');
  });

  it('should backfill project when session was created with empty project', () => {
    const contentSessionId = 'session-empty-then-real';

    // Race condition: PostToolUse hook creates session with empty project
    const id1 = createSDKSession(db, contentSessionId, '', 'Prompt 1');
    const sessionBefore = getSessionById(db, id1);
    // Empty or null initially
    expect(sessionBefore?.project === '' || sessionBefore?.project === null).toBe(true);

    // UserPromptSubmit hook re-inits with real project
    const id2 = createSDKSession(db, contentSessionId, 'cloud', 'Prompt 2');
    expect(id1).toBe(id2);
    const session = getSessionById(db, id2);
    expect(session?.project).toBe('cloud');
  });

  it('should update project when session is resumed from different directory', () => {
    const contentSessionId = 'session-project-change';

    // Session originally created in sr-renovate directory
    const id1 = createSDKSession(db, contentSessionId, 'sr-renovate', 'Prompt 1');
    const sessionBefore = getSessionById(db, id1);
    expect(sessionBefore?.project).toBe('sr-renovate');

    // User resumes session from cloud directory
    const id2 = createSDKSession(db, contentSessionId, 'cloud', 'Prompt 2');
    expect(id1).toBe(id2);
    const session = getSessionById(db, id2);
    expect(session?.project).toBe('cloud');
  });

  it('should not overwrite project when called with empty project', () => {
    const contentSessionId = 'session-no-empty-overwrite';

    // Session created with real project
    createSDKSession(db, contentSessionId, 'cloud', 'Prompt 1');

    // Observation/summarize handler calls with empty project
    createSDKSession(db, contentSessionId, '', '');
    const id = db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
      .get(contentSessionId) as { id: number };
    const session = getSessionById(db, id.id);
    expect(session?.project).toBe('cloud');
  });
});
