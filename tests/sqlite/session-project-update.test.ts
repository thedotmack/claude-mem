/**
 * Tests for session project and userPrompt update semantics in createSDKSession.
 *
 * Validates that project uses "last non-empty wins" (updates on resume)
 * while userPrompt uses "first non-empty wins" (immutable after initial set).
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
    const id1 = createSDKSession(db, 'session-same-project', 'cloud', 'Prompt 1');
    const id2 = createSDKSession(db, 'session-same-project', 'cloud', 'Prompt 2');

    expect(id1).toBe(id2);
    expect(getSessionById(db, id1)?.project).toBe('cloud');
  });

  it('should backfill project when session was created with empty project', () => {
    const id1 = createSDKSession(db, 'session-empty-then-real', '', 'Prompt 1');
    expect(getSessionById(db, id1)?.project).toBeFalsy();

    const id2 = createSDKSession(db, 'session-empty-then-real', 'cloud', 'Prompt 2');
    expect(id1).toBe(id2);
    expect(getSessionById(db, id2)?.project).toBe('cloud');
  });

  it('should update project when session is resumed from different directory', () => {
    const id1 = createSDKSession(db, 'session-project-change', 'sr-renovate', 'Prompt 1');
    expect(getSessionById(db, id1)?.project).toBe('sr-renovate');

    const id2 = createSDKSession(db, 'session-project-change', 'cloud', 'Prompt 2');
    expect(id1).toBe(id2);
    expect(getSessionById(db, id2)?.project).toBe('cloud');
  });

  it('should preserve original userPrompt when session is resumed with new prompt', () => {
    const id = createSDKSession(db, 'session-prompt-preserved', 'cloud', 'Build feature X');
    expect(getSessionById(db, id)?.user_prompt).toBe('Build feature X');

    createSDKSession(db, 'session-prompt-preserved', 'other-project', 'Fix bug Y');
    const session = getSessionById(db, id);
    expect(session?.project).toBe('other-project');
    expect(session?.user_prompt).toBe('Build feature X');
  });

  it('should backfill userPrompt when session was created with empty prompt', () => {
    const id = createSDKSession(db, 'session-empty-prompt-backfill', 'cloud', '');
    expect(getSessionById(db, id)?.user_prompt).toBeFalsy();

    createSDKSession(db, 'session-empty-prompt-backfill', 'cloud', 'Build feature X');
    expect(getSessionById(db, id)?.user_prompt).toBe('Build feature X');
  });

  it('should not overwrite project when called with empty project', () => {
    const id = createSDKSession(db, 'session-no-empty-overwrite', 'cloud', 'Prompt 1');

    createSDKSession(db, 'session-no-empty-overwrite', '', '');
    expect(getSessionById(db, id)?.project).toBe('cloud');
  });
});
