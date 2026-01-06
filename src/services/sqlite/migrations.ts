import { Database } from 'bun:sqlite';
import { Migration } from './Database.js';

// Re-export MigrationRunner for SessionStore migration extraction
export { MigrationRunner } from './migrations/runner.js';

/**
 * Initial schema migration - creates all core tables
 */
export const migration001: Migration = {
  version: 1,
  up: (db: Database) => {
    // Sessions table - core session tracking
    db.run(`
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
    db.run(`
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
    db.run(`
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
    db.run(`
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
    db.run(`
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

  down: (db: Database) => {
    db.run(`
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
  up: (db: Database) => {
    // Add new columns for hierarchical memory structure
    db.run(`
      ALTER TABLE memories ADD COLUMN title TEXT;
      ALTER TABLE memories ADD COLUMN subtitle TEXT;
      ALTER TABLE memories ADD COLUMN facts TEXT;
      ALTER TABLE memories ADD COLUMN concepts TEXT;
      ALTER TABLE memories ADD COLUMN files_touched TEXT;
    `);

    // Create indexes for the new fields to improve search performance
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_title ON memories(title);
      CREATE INDEX IF NOT EXISTS idx_memories_concepts ON memories(concepts);
    `);

    console.log('✅ Added hierarchical memory fields to memories table');
  },

  down: (_db: Database) => {
    // Note: SQLite doesn't support DROP COLUMN in all versions
    // In production, we'd need to recreate the table without these columns
    // For now, we'll just log a warning
    console.log('⚠️  Warning: SQLite ALTER TABLE DROP COLUMN not fully supported');
    console.log('⚠️  To rollback, manually recreate the memories table');
  }
};

/**
 * Migration 003 - Add streaming_sessions table for real-time session tracking
 */
export const migration003: Migration = {
  version: 3,
  up: (db: Database) => {
    // Streaming sessions table - tracks active SDK compression sessions
    db.run(`
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
      CREATE INDEX IF NOT EXISTS idx_streaming_sessions_started ON streaming_sessions(started_at_epoch DESC);
    `);

    console.log('✅ Created streaming_sessions table for real-time session tracking');
  },

  down: (db: Database) => {
    db.run(`
      DROP TABLE IF EXISTS streaming_sessions;
    `);
  }
};

/**
 * Migration 004 - Add SDK agent architecture tables
 * Implements the refactor plan for hook-driven memory with SDK agent synthesis
 */
export const migration004: Migration = {
  version: 4,
  up: (db: Database) => {
    // SDK sessions table - tracks SDK streaming sessions
    db.run(`
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
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);
    `);

    // Observation queue table - tracks pending observations for SDK processing
    db.run(`
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
      CREATE INDEX IF NOT EXISTS idx_observation_queue_pending ON observation_queue(memory_session_id, processed_at_epoch);
    `);

    // Observations table - stores extracted observations (what SDK decides is important)
    db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
    `);

    // Session summaries table - stores structured session summaries
    db.run(`
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
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    console.log('✅ Created SDK agent architecture tables');
  },

  down: (db: Database) => {
    db.run(`
      DROP TABLE IF EXISTS session_summaries;
      DROP TABLE IF EXISTS observations;
      DROP TABLE IF EXISTS observation_queue;
      DROP TABLE IF EXISTS sdk_sessions;
    `);
  }
};

/**
 * Migration 005 - Remove orphaned tables
 * Drops streaming_sessions (superseded by sdk_sessions)
 * Drops observation_queue (superseded by Unix socket communication)
 */
export const migration005: Migration = {
  version: 5,
  up: (db: Database) => {
    // Drop streaming_sessions - superseded by sdk_sessions in migration004
    // This table was from v2 architecture and is no longer used
    db.run(`DROP TABLE IF EXISTS streaming_sessions`);

    // Drop observation_queue - superseded by Unix socket communication
    // Worker now uses sockets instead of database polling for observations
    db.run(`DROP TABLE IF EXISTS observation_queue`);

    console.log('✅ Dropped orphaned tables: streaming_sessions, observation_queue');
  },

  down: (db: Database) => {
    // Recreate tables if needed (though they should never be used)
    db.run(`
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

    db.run(`
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

    console.log('⚠️  Recreated streaming_sessions and observation_queue (for rollback only)');
  }
};

/**
 * Migration 006 - Add FTS5 full-text search tables
 * Creates virtual tables for fast text search on observations and session_summaries
 */
export const migration006: Migration = {
  version: 6,
  up: (db: Database) => {
    // FTS5 virtual table for observations
    // Note: This assumes the hierarchical fields (title, subtitle, etc.) already exist
    // from the inline migrations in SessionStore constructor
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title,
        subtitle,
        narrative,
        text,
        facts,
        concepts,
        content='observations',
        content_rowid='id'
      );
    `);

    // Populate FTS table with existing data
    db.run(`
      INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
      SELECT id, title, subtitle, narrative, text, facts, concepts
      FROM observations;
    `);

    // Triggers to keep observations_fts in sync
    db.run(`
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
      END;
    `);

    // FTS5 virtual table for session_summaries
    db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
        request,
        investigated,
        learned,
        completed,
        next_steps,
        notes,
        content='session_summaries',
        content_rowid='id'
      );
    `);

    // Populate FTS table with existing data
    db.run(`
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      SELECT id, request, investigated, learned, completed, next_steps, notes
      FROM session_summaries;
    `);

    // Triggers to keep session_summaries_fts in sync
    db.run(`
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
      END;
    `);

    console.log('✅ Created FTS5 virtual tables and triggers for full-text search');
  },

  down: (db: Database) => {
    db.run(`
      DROP TRIGGER IF EXISTS observations_au;
      DROP TRIGGER IF EXISTS observations_ad;
      DROP TRIGGER IF EXISTS observations_ai;
      DROP TABLE IF EXISTS observations_fts;

      DROP TRIGGER IF EXISTS session_summaries_au;
      DROP TRIGGER IF EXISTS session_summaries_ad;
      DROP TRIGGER IF EXISTS session_summaries_ai;
      DROP TABLE IF EXISTS session_summaries_fts;
    `);
  }
};

/**
 * Migration 007 - Add discovery_tokens column for ROI metrics
 * Tracks token cost of discovering/creating each observation and summary
 */
export const migration007: Migration = {
  version: 7,
  up: (db: Database) => {
    // Add discovery_tokens to observations table
    db.run(`ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0`);

    // Add discovery_tokens to session_summaries table
    db.run(`ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0`);

    console.log('✅ Added discovery_tokens columns for ROI tracking');
  },

  down: (db: Database) => {
    // Note: SQLite doesn't support DROP COLUMN in all versions
    // In production, would need to recreate tables without these columns
    console.log('⚠️  Warning: SQLite ALTER TABLE DROP COLUMN not fully supported');
    console.log('⚠️  To rollback, manually recreate the observations and session_summaries tables');
  }
};


/**
 * Migration 008 - Add Sleep Agent supersession and deprecation fields
 * Supports the Sleep Agent memory consolidation system
 */
export const migration008: Migration = {
  version: 18,
  up: (db: Database) => {
    // Add supersession tracking fields to observations table
    db.run(`ALTER TABLE observations ADD COLUMN superseded_by INTEGER REFERENCES observations(id) ON DELETE SET NULL`);
    db.run(`ALTER TABLE observations ADD COLUMN deprecated INTEGER DEFAULT 0`);
    db.run(`ALTER TABLE observations ADD COLUMN deprecated_at INTEGER`);
    db.run(`ALTER TABLE observations ADD COLUMN deprecation_reason TEXT`);
    db.run(`ALTER TABLE observations ADD COLUMN decision_chain_id TEXT`);

    // Indexes for supersession queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_superseded_by ON observations(superseded_by)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_deprecated ON observations(deprecated)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_decision_chain ON observations(decision_chain_id)`);

    // Sleep cycles table for tracking consolidation runs
    db.run(`
      CREATE TABLE IF NOT EXISTS sleep_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at_epoch INTEGER NOT NULL,
        completed_at_epoch INTEGER,
        cycle_type TEXT CHECK(cycle_type IN ('micro', 'light', 'deep', 'manual')) NOT NULL,
        status TEXT CHECK(status IN ('running', 'completed', 'failed', 'cancelled')) NOT NULL DEFAULT 'running',
        observations_processed INTEGER DEFAULT 0,
        supersessions_detected INTEGER DEFAULT 0,
        chains_consolidated INTEGER DEFAULT 0,
        memories_deprecated INTEGER DEFAULT 0,
        error_message TEXT
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_sleep_cycles_started ON sleep_cycles(started_at_epoch DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sleep_cycles_status ON sleep_cycles(status)`);

    console.log('✅ Created Sleep Agent supersession fields and sleep_cycles table');
  },

  down: (db: Database) => {
    db.run(`DROP TABLE IF EXISTS sleep_cycles`);
    db.run(`DROP INDEX IF EXISTS idx_observations_superseded_by`);
    db.run(`DROP INDEX IF EXISTS idx_observations_deprecated`);
    db.run(`DROP INDEX IF EXISTS idx_observations_decision_chain`);
    // Note: SQLite doesn't support DROP COLUMN in all versions
    console.log('⚠️  Warning: Column removal requires table recreation');
  }
};

/**
 * Migration 009 - Add Surprise metrics fields for P2 Surprise-Based Learning
 * Inspired by Nested Learning: high surprise = increase learning rate
 */
export const migration009: Migration = {
  version: 19,
  up: (db: Database) => {
    // Add surprise metrics to observations table
    db.run(`ALTER TABLE observations ADD COLUMN surprise_score REAL`);
    db.run(`ALTER TABLE observations ADD COLUMN surprise_tier TEXT CHECK(surprise_tier IN ('routine', 'notable', 'surprising', 'anomalous'))`);
    db.run(`ALTER TABLE observations ADD COLUMN surprise_calculated_at INTEGER`);

    // Indexes for surprise queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_surprise_score ON observations(surprise_score)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_surprise_tier ON observations(surprise_tier)`);

    console.log('✅ Added Surprise metrics columns for P2 Surprise-Based Learning');
  },

  down: (db: Database) => {
    db.run(`DROP INDEX IF EXISTS idx_observations_surprise_score`);
    db.run(`DROP INDEX IF EXISTS idx_observations_surprise_tier`);
    // Note: SQLite doesn't support DROP COLUMN in all versions
    console.log('⚠️  Warning: Column removal requires table recreation');
  }
};

/**
 * Migration 010 - Add Memory Tier fields for P2 Memory Hierarchical (CMS)
 * Inspired by Nested Learning's Continuum Memory Systems
 * Memory is a spectrum with different update frequencies
 */
export const migration010: Migration = {
  version: 20,
  up: (db: Database) => {
    // Add memory tier fields to observations table
    db.run(`ALTER TABLE observations ADD COLUMN memory_tier TEXT CHECK(memory_tier IN ('core', 'working', 'archive', 'ephemeral')) DEFAULT 'working'`);
    db.run(`ALTER TABLE observations ADD COLUMN memory_tier_updated_at INTEGER`);
    db.run(`ALTER TABLE observations ADD COLUMN reference_count INTEGER DEFAULT 0`);
    db.run(`ALTER TABLE observations ADD COLUMN last_accessed_at INTEGER`);

    // Indexes for memory tier queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_memory_tier ON observations(memory_tier)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_reference_count ON observations(reference_count)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_observations_last_accessed ON observations(last_accessed_at)`);

    // Initialize reference_count based on existing superseded_by references
    // Count how many times each observation is referenced
    db.run(`
      UPDATE observations
      SET reference_count = (
        SELECT COUNT(*)
        FROM observations AS ref
        WHERE ref.superseded_by = observations.id
      )
    `);

    console.log('✅ Added Memory Tier columns for P2 Memory Hierarchical (CMS)');
  },

  down: (db: Database) => {
    db.run(`DROP INDEX IF EXISTS idx_observations_memory_tier`);
    db.run(`DROP INDEX IF EXISTS idx_observations_reference_count`);
    db.run(`DROP INDEX IF EXISTS idx_observations_last_accessed`);
    // Note: SQLite doesn't support DROP COLUMN in all versions
    console.log('⚠️  Warning: Column removal requires table recreation');
  }
};

/**
 * Migration 011 - Add Supersession Training Data for P3 Regression Model
 * Stores training examples for the learned supersession model
 */
export const migration011: Migration = {
  version: 21,
  up: (db: Database) => {
    // Table for storing supersession training examples
    db.run(`
      CREATE TABLE IF NOT EXISTS supersession_training (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        older_observation_id INTEGER NOT NULL,
        newer_observation_id INTEGER NOT NULL,
        semantic_similarity REAL NOT NULL,
        topic_match INTEGER NOT NULL,
        file_overlap REAL NOT NULL,
        type_match REAL NOT NULL,
        time_delta_hours REAL NOT NULL,
        priority_score REAL NOT NULL,
        older_reference_count INTEGER NOT NULL,
        label INTEGER NOT NULL CHECK(label IN (0, 1)),
        confidence REAL NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (older_observation_id) REFERENCES observations(id) ON DELETE CASCADE,
        FOREIGN KEY (newer_observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `);

    // Indexes for training queries
    db.run(`CREATE INDEX IF NOT EXISTS idx_supersession_training_created ON supersession_training(created_at_epoch DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_supersession_training_label ON supersession_training(label)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_supersession_training_older ON supersession_training(older_observation_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_supersession_training_newer ON supersession_training(newer_observation_id)`);

    // Table for storing learned model weights
    db.run(`
      CREATE TABLE IF NOT EXISTS learned_model_weights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        weight_semantic_similarity REAL NOT NULL,
        weight_topic_match REAL NOT NULL,
        weight_file_overlap REAL NOT NULL,
        weight_type_match REAL NOT NULL,
        weight_time_decay REAL NOT NULL,
        weight_priority_boost REAL NOT NULL,
        weight_reference_decay REAL NOT NULL,
        weight_bias REAL NOT NULL,
        trained_at_epoch INTEGER NOT NULL,
        examples_used INTEGER NOT NULL,
        loss REAL NOT NULL,
        accuracy REAL NOT NULL
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_learned_model_weights_trained ON learned_model_weights(trained_at_epoch DESC)`);

    console.log('✅ Added Supersession Training tables for P3 Regression Model');
  },

  down: (db: Database) => {
    db.run(`DROP TABLE IF EXISTS learned_model_weights`);
    db.run(`DROP TABLE IF EXISTS supersession_training`);
  }
};

/**
 * Migration 012 - Add Handoff observation type for PreCompact continuity
 * Inspired by Continuous Claude v2's handoff pattern
 */
export const migration012: Migration = {
  version: 22,
  up: (db: Database) => {
    // SQLite requires table recreation to modify CHECK constraints
    // Use transaction for safety
    db.run('BEGIN TRANSACTION');

    try {
      // Get current columns from observations table
      const tableInfo = db.query(`PRAGMA table_info(observations)`).all() as { name: string }[];
      const columns = tableInfo.map(col => col.name).filter(n => n !== 'id');

      // Create new table with updated CHECK constraint (adding 'handoff')
      db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sdk_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change', 'handoff')),
          title TEXT,
          subtitle TEXT,
          facts TEXT,
          narrative TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          superseded_by INTEGER,
          deprecated INTEGER DEFAULT 0,
          deprecated_at INTEGER,
          deprecation_reason TEXT,
          decision_chain_id TEXT,
          surprise_score REAL,
          surprise_tier TEXT CHECK(surprise_tier IN ('routine', 'notable', 'surprising', 'anomalous')),
          surprise_calculated_at INTEGER,
          memory_tier TEXT CHECK(memory_tier IN ('core', 'working', 'archive', 'ephemeral')) DEFAULT 'working',
          memory_tier_updated_at INTEGER,
          reference_count INTEGER DEFAULT 0,
          last_accessed_at INTEGER,
          FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE,
          FOREIGN KEY(superseded_by) REFERENCES observations(id) ON DELETE SET NULL
        )
      `);

      // Copy data from old table
      const columnList = columns.join(', ');
      db.run(`
        INSERT INTO observations_new (${columnList})
        SELECT ${columnList} FROM observations
      `);

      // Drop old table and rename new one
      db.run('DROP TABLE observations');
      db.run('ALTER TABLE observations_new RENAME TO observations');

      // Recreate indexes
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(sdk_session_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_superseded_by ON observations(superseded_by)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_deprecated ON observations(deprecated)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_memory_tier ON observations(memory_tier)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_reference_count ON observations(reference_count DESC)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_observations_last_accessed ON observations(last_accessed_at DESC)`);

      // Recreate FTS5 triggers
      db.run(`DROP TRIGGER IF EXISTS observations_ai`);
      db.run(`DROP TRIGGER IF EXISTS observations_ad`);
      db.run(`DROP TRIGGER IF EXISTS observations_au`);

      db.run(`
        CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (NEW.id, NEW.title, NEW.subtitle, NEW.narrative, NEW.text, NEW.facts, NEW.concepts);
        END
      `);
      db.run(`
        CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES ('delete', OLD.id, OLD.title, OLD.subtitle, OLD.narrative, OLD.text, OLD.facts, OLD.concepts);
        END
      `);
      db.run(`
        CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES ('delete', OLD.id, OLD.title, OLD.subtitle, OLD.narrative, OLD.text, OLD.facts, OLD.concepts);
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (NEW.id, NEW.title, NEW.subtitle, NEW.narrative, NEW.text, NEW.facts, NEW.concepts);
        END
      `);

      db.run('COMMIT');
      console.log('✅ Added handoff observation type for PreCompact continuity');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  },

  down: (db: Database) => {
    // Note: Downgrade would require removing handoff type - complex to do safely
    console.log('⚠️  Warning: handoff type removal requires manual intervention');
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
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012
];