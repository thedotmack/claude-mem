import { Database } from 'better-sqlite3';
import { Migration } from './Database.js';

/**
 * Initial schema migration - creates all core tables
 */
export const migration001: Migration = {
  version: 1,
  up: (db: Database.Database) => {
    // Sessions table - core session tracking
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_sessions_project_created ON sessions(project, created_at_epoch DESC);
    `);

    // Memories table - compressed memory chunks
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_memories_origin ON memories(origin);
    `);

    // Overviews table - session summaries (one per project)
    db.exec(`
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_overviews_project_latest ON overviews(project, created_at_epoch DESC);
    `);

    // Diagnostics table - system health and debug info
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_diagnostics_created ON diagnostics(created_at_epoch DESC);
    `);

    // Transcript events table - raw conversation events
    db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_transcript_events_captured ON transcript_events(captured_at_epoch DESC);
    `);

    console.log('✅ Created all database tables successfully');
  },

  down: (db: Database.Database) => {
    db.exec(`
      DROP TABLE IF EXISTS transcript_events;
      DROP TABLE IF EXISTS diagnostics;
      DROP TABLE IF EXISTS overviews;
      DROP TABLE IF EXISTS memories;
      DROP TABLE IF EXISTS sessions;
    `);
  }
};

/**
 * Migration 002 - Add hierarchical memory fields (v2 format)
 */
export const migration002: Migration = {
  version: 2,
  up: (db: Database.Database) => {
    // Add new columns for hierarchical memory structure
    db.exec(`
      ALTER TABLE memories ADD COLUMN title TEXT;
      ALTER TABLE memories ADD COLUMN subtitle TEXT;
      ALTER TABLE memories ADD COLUMN facts TEXT;
      ALTER TABLE memories ADD COLUMN concepts TEXT;
      ALTER TABLE memories ADD COLUMN files_touched TEXT;
    `);

    // Create indexes for the new fields to improve search performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_title ON memories(title);
      CREATE INDEX IF NOT EXISTS idx_memories_concepts ON memories(concepts);
    `);

    console.log('✅ Added hierarchical memory fields to memories table');
  },

  down: (db: Database.Database) => {
    // Note: SQLite doesn't support DROP COLUMN in all versions
    // In production, we'd need to recreate the table without these columns
    // For now, we'll just log a warning
    console.log('⚠️  Warning: SQLite ALTER TABLE DROP COLUMN not fully supported');
    console.log('⚠️  To rollback, manually recreate the memories table');
  }
};

/**
 * All migrations in order
 */
export const migrations: Migration[] = [
  migration001,
  migration002
];