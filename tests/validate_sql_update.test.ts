import { Database } from 'bun:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('Refactor Validation: SQL Updates', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Minimal schema for sdk_sessions based on SessionStore.ts migration004
    db.run(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claude_session_id TEXT UNIQUE NOT NULL,
        sdk_session_id TEXT UNIQUE,
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

  it('should update sdk_session_id using direct SQL (replacing updateSDKSessionId)', () => {
    // Setup initial state: A session without an sdk_session_id
    const claudeId = 'claude-session-123';
    const syntheticId = 'sdk-session-456';
    
    db.prepare(`
      INSERT INTO sdk_sessions (claude_session_id, project, started_at, started_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run(claudeId, 'test-project', '2025-01-01T00:00:00Z', 1735689600000);

    // Verify initial state
    const before = db.prepare('SELECT sdk_session_id FROM sdk_sessions WHERE claude_session_id = ?').get(claudeId) as any;
    expect(before.sdk_session_id).toBeNull();

    // EXECUTE: The exact SQL statement from the refactor in import-xml-observations.ts
    // Original code: db['db'].prepare('UPDATE sdk_sessions SET sdk_session_id = ? WHERE claude_session_id = ?').run(syntheticSdkSessionId, sessionMeta.sessionId);
    
    const stmt = db.prepare('UPDATE sdk_sessions SET sdk_session_id = ? WHERE claude_session_id = ?');
    stmt.run(syntheticId, claudeId);

    // VERIFY: The update happened
    const after = db.prepare('SELECT sdk_session_id FROM sdk_sessions WHERE claude_session_id = ?').get(claudeId) as any;
    expect(after.sdk_session_id).toBe(syntheticId);
  });
});
