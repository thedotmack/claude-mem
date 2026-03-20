import type { DbAdapter } from './adapter.js';
import { Migration } from './Database.js';

// Re-export MigrationRunner for SessionStore migration extraction
export { MigrationRunner } from './migrations/runner.js';

/**
 * Initial schema migration - creates all core tables
 */
export const migration001: Migration = {
  version: 1,
  up: async (db: DbAdapter) => {
    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'compress',
        archive_path TEXT,
        archive_bytes INTEGER,
        archive_checksum TEXT,
        archived_at TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created ON sessions(project, created_at_epoch DESC)
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        document_id TEXT UNIQUE,
        keywords TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        project TEXT NOT NULL,
        archive_basename TEXT,
        origin TEXT NOT NULL DEFAULT 'transcript',
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_project_created ON memories(project, created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_document_id ON memories(document_id);
      CREATE INDEX IF NOT EXISTS idx_memories_origin ON memories(origin)
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS overviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        project TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'claude',
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_overviews_session ON overviews(session_id);
      CREATE INDEX IF NOT EXISTS idx_overviews_project ON overviews(project);
      CREATE INDEX IF NOT EXISTS idx_overviews_created_at ON overviews(created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_overviews_project_created ON overviews(project, created_at_epoch DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_overviews_project_latest ON overviews(project, created_at_epoch DESC)
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        message TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        project TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'system',
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_diagnostics_session ON diagnostics(session_id);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_project ON diagnostics(project);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_severity ON diagnostics(severity);
      CREATE INDEX IF NOT EXISTS idx_diagnostics_created ON diagnostics(created_at_epoch DESC)
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS transcript_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT,
        event_index INTEGER NOT NULL,
        event_type TEXT,
        raw_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        captured_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        UNIQUE(session_id, event_index)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_events_session ON transcript_events(session_id, event_index);
      CREATE INDEX IF NOT EXISTS idx_transcript_events_project ON transcript_events(project);
      CREATE INDEX IF NOT EXISTS idx_transcript_events_type ON transcript_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_transcript_events_captured ON transcript_events(captured_at_epoch DESC)
    `);
  },

  down: async (db: DbAdapter) => {
    await db.executeScript(`
      DROP TABLE IF EXISTS transcript_events;
      DROP TABLE IF EXISTS diagnostics;
      DROP TABLE IF EXISTS overviews;
      DROP TABLE IF EXISTS memories;
      DROP TABLE IF EXISTS sessions
    `);
  }
};

export const migration002: Migration = {
  version: 2,
  up: async (db: DbAdapter) => {
    await db.executeScript(`
      ALTER TABLE memories ADD COLUMN title TEXT;
      ALTER TABLE memories ADD COLUMN subtitle TEXT;
      ALTER TABLE memories ADD COLUMN facts TEXT;
      ALTER TABLE memories ADD COLUMN concepts TEXT;
      ALTER TABLE memories ADD COLUMN files_touched TEXT
    `);
    await db.executeScript(`
      CREATE INDEX IF NOT EXISTS idx_memories_title ON memories(title);
      CREATE INDEX IF NOT EXISTS idx_memories_concepts ON memories(concepts)
    `);
  }
};

export const migration003: Migration = {
  version: 3,
  up: async (db: DbAdapter) => {
    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS streaming_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT,
        project TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        updated_at TEXT,
        updated_at_epoch INTEGER,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_streaming_sessions_claude_id ON streaming_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_streaming_sessions_sdk_id ON streaming_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_streaming_sessions_project ON streaming_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_streaming_sessions_status ON streaming_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_streaming_sessions_started ON streaming_sessions(started_at_epoch DESC)
    `);
  },

  down: async (db: DbAdapter) => {
    await db.execute('DROP TABLE IF EXISTS streaming_sessions');
  }
};

export const migration004: Migration = {
  version: 4,
  up: async (db: DbAdapter) => {
    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS observation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_output TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        processed_at_epoch INTEGER,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_observation_queue_sdk_session ON observation_queue(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observation_queue_processed ON observation_queue(processed_at_epoch);
      CREATE INDEX IF NOT EXISTS idx_observation_queue_pending ON observation_queue(memory_session_id, processed_at_epoch)
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC)
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC)
    `);
  },

  down: async (db: DbAdapter) => {
    await db.executeScript(`
      DROP TABLE IF EXISTS session_summaries;
      DROP TABLE IF EXISTS observations;
      DROP TABLE IF EXISTS observation_queue;
      DROP TABLE IF EXISTS sdk_sessions
    `);
  }
};

export const migration005: Migration = {
  version: 5,
  up: async (db: DbAdapter) => {
    await db.execute('DROP TABLE IF EXISTS streaming_sessions');
    await db.execute('DROP TABLE IF EXISTS observation_queue');
  },

  down: async (db: DbAdapter) => {
    // Recreate tables for rollback (though they should never be used)
    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS streaming_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT,
        project TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        updated_at TEXT,
        updated_at_epoch INTEGER,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);

    await db.executeScript(`
      CREATE TABLE IF NOT EXISTS observation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_output TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        processed_at_epoch INTEGER,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);
  }
};

export const migration006: Migration = {
  version: 6,
  up: async (db: DbAdapter) => {
    // Probe FTS5 availability
    try {
      await db.execute('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
      await db.execute('DROP TABLE _fts5_probe');
    } catch {
      return;
    }

    await db.executeScript(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, subtitle, narrative, text, facts, concepts,
        content='observations', content_rowid='id'
      )
    `);

    await db.execute(`
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      SELECT id, title, subtitle, narrative, text, facts, concepts
      FROM observations
    `);

    await db.executeScript(`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END
    `);

    await db.executeScript(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
        request, investigated, learned, completed, next_steps, notes,
        content='session_summaries', content_rowid='id'
      )
    `);

    await db.execute(`
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      SELECT id, request, investigated, learned, completed, next_steps, notes
      FROM session_summaries
    `);

    await db.executeScript(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END
    `);
  },

  down: async (db: DbAdapter) => {
    await db.executeScript(`
      DROP TRIGGER IF EXISTS observations_au;
      DROP TRIGGER IF EXISTS observations_ad;
      DROP TRIGGER IF EXISTS observations_ai;
      DROP TABLE IF EXISTS observations_fts;
      DROP TRIGGER IF EXISTS session_summaries_au;
      DROP TRIGGER IF EXISTS session_summaries_ad;
      DROP TRIGGER IF EXISTS session_summaries_ai;
      DROP TABLE IF EXISTS session_summaries_fts
    `);
  }
};

export const migration007: Migration = {
  version: 7,
  up: async (db: DbAdapter) => {
    await db.execute('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
    await db.execute('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
  }
};

/**
 * All migrations in order
 */
export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007
];
