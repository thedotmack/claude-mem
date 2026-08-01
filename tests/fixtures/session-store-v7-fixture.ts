import { Database } from 'bun:sqlite';

// Replays the pre-13.12.0 v7 rebuild against session_summaries, producing the
// damaged state from issue #3446: discovery_tokens absent, schema_versions row
// 11 still stamped. Uses the same 14-column literal as SessionStore.ts:1101-1131.
export function replayV7RebuildOnSummaries(db: Database): void {
  db.run('BEGIN');
  db.run(`
    CREATE TABLE session_summaries_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
    )
  `);
  db.run(`
    INSERT INTO session_summaries_new
    SELECT id, memory_session_id, project, request, investigated, learned,
           completed, next_steps, files_read, files_edited, notes,
           prompt_number, created_at, created_at_epoch
    FROM session_summaries
  `);
  db.run('DROP TABLE session_summaries');
  db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');
  db.run(`CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id)`);
  db.run(`CREATE INDEX idx_session_summaries_project ON session_summaries(project)`);
  db.run(`CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)`);
  db.run('COMMIT');
}
