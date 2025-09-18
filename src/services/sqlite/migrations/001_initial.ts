import { Migration } from '../Database.js';

/**
 * Initial migration: Create all core tables for claude-mem SQLite index
 */
export const migration001: Migration = {
  version: 1,
  
  up: (db) => {
    // Create sessions table
    db.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        source TEXT DEFAULT 'compress',
        archive_path TEXT,
        archive_bytes INTEGER,
        archive_checksum TEXT,
        archived_at TEXT,
        metadata_json TEXT
      )
    `);

    // Create indexes for sessions
    db.exec(`
      CREATE INDEX sessions_project_created_at ON sessions (project, created_at_epoch DESC)
    `);
    db.exec(`
      CREATE INDEX sessions_source_created ON sessions (source, created_at_epoch DESC)
    `);

    // Create overviews table
    db.exec(`
      CREATE TABLE overviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        project TEXT NOT NULL,
        origin TEXT DEFAULT 'claude'
      )
    `);

    // Create index for overviews
    db.exec(`
      CREATE INDEX overviews_project_created_at ON overviews (project, created_at_epoch DESC)
    `);

    // Create memories table
    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        document_id TEXT,
        keywords TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        project TEXT NOT NULL,
        archive_basename TEXT,
        origin TEXT DEFAULT 'transcript'
      )
    `);

    // Create indexes for memories
    db.exec(`
      CREATE INDEX memories_project_created_at ON memories (project, created_at_epoch DESC)
    `);
    db.exec(`
      CREATE UNIQUE INDEX memories_document_id_unique ON memories (document_id) WHERE document_id IS NOT NULL
    `);

    // Create diagnostics table
    db.exec(`
      CREATE TABLE diagnostics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        message TEXT NOT NULL,
        severity TEXT DEFAULT 'warn',
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        project TEXT NOT NULL,
        origin TEXT DEFAULT 'compressor'
      )
    `);

    // Create index for diagnostics
    db.exec(`
      CREATE INDEX diagnostics_project_created_at ON diagnostics (project, created_at_epoch DESC)
    `);

    // Create archives table (for future archival workflows)
    db.exec(`
      CREATE TABLE archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        bytes INTEGER,
        checksum TEXT,
        stored_at TEXT NOT NULL,
        storage_status TEXT DEFAULT 'active'
      )
    `);

    // Create titles table (ready for conversation-titles.jsonl migration)
    db.exec(`
      CREATE TABLE titles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        project TEXT NOT NULL
      )
    `);

    console.log('✅ Created initial database schema with all tables and indexes');
  },

  down: (db) => {
    // Drop tables in reverse order to respect foreign key constraints
    const tables = ['titles', 'archives', 'diagnostics', 'memories', 'overviews', 'sessions'];
    
    for (const table of tables) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    
    console.log('🗑️ Dropped all tables from initial migration');
  }
};