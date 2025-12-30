import { Database } from 'bun:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('Refactor Validation: SQL Updates', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Minimal schema for sdk_sessions based on SessionStore.ts migration004
    // Uses new column names: content_session_id and memory_session_id
    db.run(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        user_prompt TEXT,
        started_at TEXT,
        started_at_epoch INTEGER,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT DEFAULT 'active'
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('should update memory_session_id using direct SQL (replacing updateSDKSessionId)', () => {
    // Setup initial state: A session without a memory_session_id
    const contentId = 'content-session-123';
    const memoryId = 'memory-session-456';

    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run(contentId, 'test-project', '2025-01-01T00:00:00Z', 1735689600000);

    // Verify initial state
    const before = db.prepare('SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = ?').get(contentId) as any;
    expect(before.memory_session_id).toBeNull();

    // EXECUTE: The exact SQL statement from the refactor
    const stmt = db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?');
    stmt.run(memoryId, contentId);

    // VERIFY: The update happened
    const after = db.prepare('SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = ?').get(contentId) as any;
    expect(after.memory_session_id).toBe(memoryId);
  });
});
