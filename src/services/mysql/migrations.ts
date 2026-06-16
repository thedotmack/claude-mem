/**
 * MySQL Migrations
 *
 * Schema migrations adapted for MySQL syntax.
 * Key differences from SQLite:
 * - AUTOINCREMENT → AUTO_INCREMENT
 * - TEXT → VARCHAR/TEXT with length
 * - CREATE INDEX IF NOT EXISTS → check with SHOW INDEX first
 * - INSERT OR IGNORE → INSERT IGNORE
 * - json_each → JSON_CONTAINS/JSON_EXTRACT
 */

import { MySQLDatabase } from './Database.js';
import { logger } from '../../utils/logger.js';

export interface Migration {
  version: number;
  up: (db: MySQLDatabase) => Promise<void>;
  down?: (db: MySQLDatabase) => Promise<void>;
}

/**
 * Create index safely (MySQL 5.7 doesn't support CREATE INDEX IF NOT EXISTS)
 */
async function createIndexSafe(db: MySQLDatabase, tableName: string, indexName: string, indexSql: string): Promise<void> {
  const exists = await db.indexExists(tableName, indexName);
  if (!exists) {
    await db.run(indexSql);
    logger.debug('DB', `Created index ${indexName} on ${tableName}`);
  }
}

/**
 * Migration 004 - Core schema (equivalent to SQLite migrations 001-004 combined)
 * Creates all core tables for SDK session tracking
 */
export const migration004: Migration = {
  version: 4,
  up: async (db: MySQLDatabase) => {
    // Schema versions table
    await db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version INT UNIQUE NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // SDK sessions table
    await db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        content_session_id VARCHAR(255) UNIQUE NOT NULL,
        memory_session_id VARCHAR(255) UNIQUE,
        project VARCHAR(500) NOT NULL,
        platform_source VARCHAR(50) NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TIMESTAMP NOT NULL,
        started_at_epoch BIGINT NOT NULL,
        completed_at TIMESTAMP NULL,
        completed_at_epoch BIGINT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        CHECK(status IN ('active', 'completed', 'failed'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await createIndexSafe(db, 'sdk_sessions', 'idx_sdk_sessions_claude_id',
      'CREATE INDEX idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)');
    await createIndexSafe(db, 'sdk_sessions', 'idx_sdk_sessions_sdk_id',
      'CREATE INDEX idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)');
    await createIndexSafe(db, 'sdk_sessions', 'idx_sdk_sessions_project',
      'CREATE INDEX idx_sdk_sessions_project ON sdk_sessions(project)');
    await createIndexSafe(db, 'sdk_sessions', 'idx_sdk_sessions_status',
      'CREATE INDEX idx_sdk_sessions_status ON sdk_sessions(status)');
    await createIndexSafe(db, 'sdk_sessions', 'idx_sdk_sessions_started',
      'CREATE INDEX idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)');

    // Observations table
    await db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        memory_session_id VARCHAR(255) NOT NULL,
        project VARCHAR(500) NOT NULL,
        text TEXT NULL,
        type VARCHAR(50) NOT NULL,
        created_at TIMESTAMP NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        FOREIGN KEY (memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await createIndexSafe(db, 'observations', 'idx_observations_sdk_session',
      'CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id)');
    await createIndexSafe(db, 'observations', 'idx_observations_project',
      'CREATE INDEX idx_observations_project ON observations(project)');
    await createIndexSafe(db, 'observations', 'idx_observations_type',
      'CREATE INDEX idx_observations_type ON observations(type)');
    await createIndexSafe(db, 'observations', 'idx_observations_created',
      'CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC)');

    // Session summaries table
    await db.run(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        memory_session_id VARCHAR(255) NOT NULL,
        project VARCHAR(500) NOT NULL,
        request TEXT NULL,
        investigated TEXT NULL,
        learned TEXT NULL,
        completed TEXT NULL,
        next_steps TEXT NULL,
        files_read TEXT NULL,
        files_edited TEXT NULL,
        notes TEXT NULL,
        created_at TIMESTAMP NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        FOREIGN KEY (memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await createIndexSafe(db, 'session_summaries', 'idx_session_summaries_sdk_session',
      'CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id)');
    await createIndexSafe(db, 'session_summaries', 'idx_session_summaries_project',
      'CREATE INDEX idx_session_summaries_project ON session_summaries(project)');
    await createIndexSafe(db, 'session_summaries', 'idx_session_summaries_created',
      'CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)');

    // Record migration version 4
    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [4]
    );

    logger.info('DB', 'Migration 004: Created core MySQL tables');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('DROP TABLE IF EXISTS session_summaries');
    await db.run('DROP TABLE IF EXISTS observations');
    await db.run('DROP TABLE IF EXISTS sdk_sessions');
    await db.run('DROP TABLE IF EXISTS schema_versions');
  }
};

/**
 * Migration 005 - Add worker_port column
 */
export const migration005: Migration = {
  version: 5,
  up: async (db: MySQLDatabase) => {
    const hasColumn = await db.columnExists('sdk_sessions', 'worker_port');
    if (!hasColumn) {
      await db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INT NULL');
      logger.debug('DB', 'Added worker_port column to sdk_sessions');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [5]
    );
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE sdk_sessions DROP COLUMN IF EXISTS worker_port');
  }
};

/**
 * Migration 006 - Add prompt tracking columns
 */
export const migration006: Migration = {
  version: 6,
  up: async (db: MySQLDatabase) => {
    // Add prompt_counter to sdk_sessions
    const hasPromptCounter = await db.columnExists('sdk_sessions', 'prompt_counter');
    if (!hasPromptCounter) {
      await db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INT DEFAULT 0');
    }

    // Add prompt_number to observations
    const hasObsPromptNumber = await db.columnExists('observations', 'prompt_number');
    if (!hasObsPromptNumber) {
      await db.run('ALTER TABLE observations ADD COLUMN prompt_number INT NULL');
    }

    // Add prompt_number to session_summaries
    const hasSumPromptNumber = await db.columnExists('session_summaries', 'prompt_number');
    if (!hasSumPromptNumber) {
      await db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INT NULL');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [6]
    );
    logger.debug('DB', 'Migration 006: Added prompt tracking columns');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE sdk_sessions DROP COLUMN IF EXISTS prompt_counter');
    await db.run('ALTER TABLE observations DROP COLUMN IF EXISTS prompt_number');
    await db.run('ALTER TABLE session_summaries DROP COLUMN IF EXISTS prompt_number');
  }
};

/**
 * Migration 008 - Add hierarchical fields to observations
 */
export const migration008: Migration = {
  version: 8,
  up: async (db: MySQLDatabase) => {
    const columns = ['title', 'subtitle', 'facts', 'narrative', 'concepts', 'files_read', 'files_modified'];
    for (const col of columns) {
      const hasColumn = await db.columnExists('observations', col);
      if (!hasColumn) {
        await db.run(`ALTER TABLE observations ADD COLUMN ${col} TEXT NULL`);
      }
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [8]
    );
    logger.debug('DB', 'Migration 008: Added hierarchical fields to observations');
  },

  down: async (db: MySQLDatabase) => {
    const columns = ['files_modified', 'files_read', 'concepts', 'narrative', 'facts', 'subtitle', 'title'];
    for (const col of columns) {
      await db.run(`ALTER TABLE observations DROP COLUMN IF EXISTS ${col}`);
    }
  }
};

/**
 * Migration 010 - Create user_prompts table
 */
export const migration010: Migration = {
  version: 10,
  up: async (db: MySQLDatabase) => {
    const tableExists = await db.tableExists('user_prompts');
    if (!tableExists) {
      await db.run(`
        CREATE TABLE IF NOT EXISTS user_prompts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          content_session_id VARCHAR(255) NOT NULL,
          prompt_number INT NOT NULL,
          prompt_text TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL,
          created_at_epoch BIGINT NOT NULL,
          FOREIGN KEY (content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      await createIndexSafe(db, 'user_prompts', 'idx_user_prompts_claude_session',
        'CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id)');
      await createIndexSafe(db, 'user_prompts', 'idx_user_prompts_created',
        'CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC)');
      await createIndexSafe(db, 'user_prompts', 'idx_user_prompts_prompt_number',
        'CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number)');
      await createIndexSafe(db, 'user_prompts', 'idx_user_prompts_lookup',
        'CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number)');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [10]
    );
    logger.debug('DB', 'Migration 010: Created user_prompts table');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('DROP TABLE IF EXISTS user_prompts');
  }
};

/**
 * Migration 011 - Add discovery_tokens column
 */
export const migration011: Migration = {
  version: 11,
  up: async (db: MySQLDatabase) => {
    const hasObsDiscoveryTokens = await db.columnExists('observations', 'discovery_tokens');
    if (!hasObsDiscoveryTokens) {
      await db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INT DEFAULT 0');
    }

    const hasSumDiscoveryTokens = await db.columnExists('session_summaries', 'discovery_tokens');
    if (!hasSumDiscoveryTokens) {
      await db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INT DEFAULT 0');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [11]
    );
    logger.debug('DB', 'Migration 011: Added discovery_tokens columns');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE observations DROP COLUMN IF EXISTS discovery_tokens');
    await db.run('ALTER TABLE session_summaries DROP COLUMN IF EXISTS discovery_tokens');
  }
};

/**
 * Migration 016 - Create pending_messages table
 */
export const migration016: Migration = {
  version: 16,
  up: async (db: MySQLDatabase) => {
    const tableExists = await db.tableExists('pending_messages');
    if (!tableExists) {
      await db.run(`
        CREATE TABLE IF NOT EXISTS pending_messages (
          id INT AUTO_INCREMENT PRIMARY KEY,
          session_db_id INT NOT NULL,
          content_session_id VARCHAR(255) NOT NULL,
          message_type VARCHAR(20) NOT NULL,
          tool_name VARCHAR(100) NULL,
          tool_input TEXT NULL,
          tool_response TEXT NULL,
          cwd VARCHAR(500) NULL,
          last_user_message TEXT NULL,
          last_assistant_message TEXT NULL,
          prompt_number INT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          retry_count INT NOT NULL DEFAULT 0,
          created_at_epoch BIGINT NOT NULL,
          started_processing_at_epoch BIGINT NULL,
          completed_at_epoch BIGINT NULL,
          FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE,
          CHECK(message_type IN ('observation', 'summarize')),
          CHECK(status IN ('pending', 'processing', 'processed', 'failed'))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);

      await createIndexSafe(db, 'pending_messages', 'idx_pending_messages_session',
        'CREATE INDEX idx_pending_messages_session ON pending_messages(session_db_id)');
      await createIndexSafe(db, 'pending_messages', 'idx_pending_messages_status',
        'CREATE INDEX idx_pending_messages_status ON pending_messages(status)');
      await createIndexSafe(db, 'pending_messages', 'idx_pending_messages_claude_session',
        'CREATE INDEX idx_pending_messages_claude_session ON pending_messages(content_session_id)');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [16]
    );
    logger.debug('DB', 'Migration 016: Created pending_messages table');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('DROP TABLE IF EXISTS pending_messages');
  }
};

/**
 * Migration 020 - Add failed_at_epoch column
 */
export const migration020: Migration = {
  version: 20,
  up: async (db: MySQLDatabase) => {
    const hasColumn = await db.columnExists('pending_messages', 'failed_at_epoch');
    if (!hasColumn) {
      await db.run('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch BIGINT NULL');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [20]
    );
    logger.debug('DB', 'Migration 020: Added failed_at_epoch column');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE pending_messages DROP COLUMN IF EXISTS failed_at_epoch');
  }
};

/**
 * Migration 022 - Add content_hash column to observations
 */
export const migration022: Migration = {
  version: 22,
  up: async (db: MySQLDatabase) => {
    const hasColumn = await db.columnExists('observations', 'content_hash');
    if (!hasColumn) {
      await db.run('ALTER TABLE observations ADD COLUMN content_hash VARCHAR(64) NULL');
      // Backfill with random hashes (MySQL doesn't have randomblob)
      await db.run('UPDATE observations SET content_hash = MD5(RAND()) WHERE content_hash IS NULL');
      await createIndexSafe(db, 'observations', 'idx_observations_content_hash',
        'CREATE INDEX idx_observations_content_hash ON observations(content_hash, created_at_epoch)');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [22]
    );
    logger.debug('DB', 'Migration 022: Added content_hash column with backfill and index');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE observations DROP COLUMN IF EXISTS content_hash');
  }
};

/**
 * Migration 023 - Add custom_title column to sdk_sessions
 */
export const migration023: Migration = {
  version: 23,
  up: async (db: MySQLDatabase) => {
    const hasColumn = await db.columnExists('sdk_sessions', 'custom_title');
    if (!hasColumn) {
      await db.run('ALTER TABLE sdk_sessions ADD COLUMN custom_title VARCHAR(255) NULL');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [23]
    );
    logger.debug('DB', 'Migration 023: Added custom_title column');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE sdk_sessions DROP COLUMN IF EXISTS custom_title');
  }
};

/**
 * Migration 024 - Add platform_source column (already in core schema, but ensure index)
 */
export const migration024: Migration = {
  version: 24,
  up: async (db: MySQLDatabase) => {
    const hasColumn = await db.columnExists('sdk_sessions', 'platform_source');
    if (!hasColumn) {
      await db.run("ALTER TABLE sdk_sessions ADD COLUMN platform_source VARCHAR(50) NOT NULL DEFAULT 'claude'");
    }

    await createIndexSafe(db, 'sdk_sessions', 'idx_sdk_sessions_platform_source',
      'CREATE INDEX idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)');

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [24]
    );
    logger.debug('DB', 'Migration 024: Ensured platform_source column and index');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE sdk_sessions DROP COLUMN IF EXISTS platform_source');
  }
};

/**
 * Migration 026 - Add generated_by_model and relevance_count columns
 */
export const migration026: Migration = {
  version: 26,
  up: async (db: MySQLDatabase) => {
    const hasGeneratedByModel = await db.columnExists('observations', 'generated_by_model');
    if (!hasGeneratedByModel) {
      await db.run('ALTER TABLE observations ADD COLUMN generated_by_model VARCHAR(100) NULL');
    }

    const hasRelevanceCount = await db.columnExists('observations', 'relevance_count');
    if (!hasRelevanceCount) {
      await db.run('ALTER TABLE observations ADD COLUMN relevance_count INT DEFAULT 0');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [26]
    );
    logger.debug('DB', 'Migration 026: Added model tracking columns');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE observations DROP COLUMN IF EXISTS generated_by_model');
    await db.run('ALTER TABLE observations DROP COLUMN IF EXISTS relevance_count');
  }
};

/**
 * Migration 027 - Add subagent identity columns (agent_type, agent_id)
 *
 * Claude Code hooks that fire inside a subagent carry agent_id and agent_type on the
 * stdin payload. These flow hook → worker → pending_messages → SDK storage so that
 * observation rows can be attributed to the originating subagent. Main-session rows
 * keep NULL for both columns.
 */
export const migration027: Migration = {
  version: 27,
  up: async (db: MySQLDatabase) => {
    // Add agent_type and agent_id to observations table
    const hasObsAgentType = await db.columnExists('observations', 'agent_type');
    if (!hasObsAgentType) {
      await db.run('ALTER TABLE observations ADD COLUMN agent_type VARCHAR(100) NULL');
    }

    const hasObsAgentId = await db.columnExists('observations', 'agent_id');
    if (!hasObsAgentId) {
      await db.run('ALTER TABLE observations ADD COLUMN agent_id VARCHAR(100) NULL');
    }

    await createIndexSafe(db, 'observations', 'idx_observations_agent_type',
      'CREATE INDEX idx_observations_agent_type ON observations(agent_type)');
    await createIndexSafe(db, 'observations', 'idx_observations_agent_id',
      'CREATE INDEX idx_observations_agent_id ON observations(agent_id)');

    // Add agent_type and agent_id to pending_messages table
    const hasPendingAgentType = await db.columnExists('pending_messages', 'agent_type');
    if (!hasPendingAgentType) {
      await db.run('ALTER TABLE pending_messages ADD COLUMN agent_type VARCHAR(100) NULL');
    }

    const hasPendingAgentId = await db.columnExists('pending_messages', 'agent_id');
    if (!hasPendingAgentId) {
      await db.run('ALTER TABLE pending_messages ADD COLUMN agent_id VARCHAR(100) NULL');
    }

    await db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, NOW())',
      [27]
    );
    logger.debug('DB', 'Migration 027: Added subagent identity columns to observations and pending_messages');
  },

  down: async (db: MySQLDatabase) => {
    await db.run('ALTER TABLE observations DROP COLUMN IF EXISTS agent_id');
    await db.run('ALTER TABLE observations DROP COLUMN IF EXISTS agent_type');
    await db.run('ALTER TABLE pending_messages DROP COLUMN IF EXISTS agent_id');
    await db.run('ALTER TABLE pending_messages DROP COLUMN IF EXISTS agent_type');
  }
};

/**
 * All migrations in order
 */
export const migrations: Migration[] = [
  migration004,
  migration005,
  migration006,
  migration008,
  migration010,
  migration011,
  migration016,
  migration020,
  migration022,
  migration023,
  migration024,
  migration026,
  migration027,
];

/**
 * Run all pending migrations
 */
export async function runMigrations(db: MySQLDatabase): Promise<void> {
  // Ensure schema_versions table exists before querying it
  const tableExists = await db.tableExists('schema_versions');
  if (!tableExists) {
    await db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version INT UNIQUE NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  // Get applied versions
  const appliedRows = await db.all<{ version: number }>('SELECT version FROM schema_versions ORDER BY version');
  const appliedVersions = new Set(appliedRows.map(r => r.version));

  const maxApplied = appliedRows.length > 0 ? Math.max(...appliedRows.map(r => r.version)) : 0;

  for (const migration of migrations) {
    if (migration.version > maxApplied || !appliedVersions.has(migration.version)) {
      logger.info('DB', `Applying MySQL migration ${migration.version}`);

      try {
        await migration.up(db);
        logger.info('DB', `MySQL migration ${migration.version} applied successfully`);
      } catch (error) {
        logger.error('DB', `MySQL migration ${migration.version} failed`, {}, error as Error);
        throw error;
      }
    }
  }
}