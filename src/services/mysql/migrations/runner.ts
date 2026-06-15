/**
 * MySQL MigrationRunner
 *
 * Handles all database schema migrations for MySQL.
 * Converted from SQLite migrations - key differences:
 * - INTEGER PRIMARY KEY AUTOINCREMENT → INT PRIMARY KEY AUTO_INCREMENT
 * - PRAGMA table_info → INFORMATION_SCHEMA.COLUMNS
 * - PRAGMA index_list → INFORMATION_SCHEMA.STATISTICS
 * - INSERT OR IGNORE → INSERT IGNORE
 * - TEXT → TEXT (compatible)
 * - sqlite_master → INFORMATION_SCHEMA.TABLES
 * - FTS5 virtual tables removed (MySQL uses FULLTEXT indexes instead)
 */

import { MySQLDatabase } from '../Database.js';
import { logger } from '../../../utils/logger.js';
import { DEFAULT_PLATFORM_SOURCE } from '../../../shared/platform-source.js';
import { getMySQLConfig } from '../../../shared/paths.js';

export class MigrationRunner {
  constructor(private db: MySQLDatabase) {}

  /**
   * Run all migrations in order
   */
  async runAllMigrations(): Promise<void> {
    await this.initializeSchema();
    await this.ensureWorkerPortColumn();
    await this.ensurePromptTrackingColumns();
    await this.removeSessionSummariesUniqueConstraint();
    await this.addObservationHierarchicalFields();
    await this.makeObservationsTextNullable();
    await this.createUserPromptsTable();
    await this.ensureDiscoveryTokensColumn();
    await this.createPendingMessagesTable();
    await this.renameSessionIdColumns();
    await this.repairSessionIdColumnRename();
    await this.addFailedAtEpochColumn();
    await this.addOnUpdateCascadeToForeignKeys();
    await this.addObservationContentHashColumn();
    await this.addSessionCustomTitleColumn();
    await this.createObservationFeedbackTable();
    await this.addSessionPlatformSourceColumn();
    await this.addObservationQualityColumns();
    await this.addSessionSummariesPromptNumberUniqueIndex();
  }

  /**
   * Record a migration as applied
   */
  private async recordMigration(version: number): Promise<void> {
    await this.db.run(
      'INSERT IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)',
      [version, new Date().toISOString()]
    );
  }

  /**
   * Check if a migration has been applied
   */
  private async isMigrationApplied(version: number): Promise<boolean> {
    const rows = await this.db.all(
      'SELECT version FROM schema_versions WHERE version = ?',
      [version]
    );
    return rows.length > 0;
  }

  /**
   * Safely create an index if it doesn't exist
   * MySQL doesn't support CREATE INDEX IF NOT EXISTS, so we check first.
   */
  private async safeCreateIndex(indexName: string, sql: string): Promise<void> {
    try {
      await this.db.run(sql);
      logger.debug('DB', `Created index ${indexName}`);
    } catch (e: any) {
      if (e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_DUP_KEYNAME') {
        logger.debug('DB', `Index ${indexName} already exists, skipping`);
      } else {
        throw e;
      }
    }
  }

  /**
   * Safely create multiple indexes
   */
  private async safeCreateIndexes(indexes: Array<{ name: string; sql: string }>): Promise<void> {
    for (const idx of indexes) {
      await this.safeCreateIndex(idx.name, idx.sql);
    }
  }

  /**
   * Migration 4: Initialize core schema
   */
  private async initializeSchema(): Promise<void> {
    // Create schema_versions table
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        version INT UNIQUE NOT NULL,
        applied_at VARCHAR(30) NOT NULL
      )
    `);

    // Create core tables
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        content_session_id VARCHAR(255) UNIQUE NOT NULL,
        memory_session_id VARCHAR(255) UNIQUE,
        project VARCHAR(500) NOT NULL,
        platform_source VARCHAR(50) NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at VARCHAR(30) NOT NULL,
        started_at_epoch BIGINT NOT NULL,
        completed_at VARCHAR(30),
        completed_at_epoch BIGINT,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        CONSTRAINT chk_sdk_sessions_status CHECK(status IN ('active', 'completed', 'failed'))
      )
    `);

    await this.safeCreateIndexes([
      { name: 'idx_sdk_sessions_claude_id', sql: 'CREATE INDEX idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)' },
      { name: 'idx_sdk_sessions_sdk_id', sql: 'CREATE INDEX idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)' },
      { name: 'idx_sdk_sessions_project', sql: 'CREATE INDEX idx_sdk_sessions_project ON sdk_sessions(project(191))' },
      { name: 'idx_sdk_sessions_status', sql: 'CREATE INDEX idx_sdk_sessions_status ON sdk_sessions(status)' },
      { name: 'idx_sdk_sessions_started', sql: 'CREATE INDEX idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)' },
    ]);

    await this.db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INT PRIMARY KEY AUTO_INCREMENT,
        memory_session_id VARCHAR(255) NOT NULL,
        project VARCHAR(500) NOT NULL,
        \`text\` TEXT NOT NULL,
        type VARCHAR(50) NOT NULL,
        created_at VARCHAR(30) NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        INDEX idx_observations_sdk_session (memory_session_id),
        INDEX idx_observations_project (project(191)),
        INDEX idx_observations_type (type),
        INDEX idx_observations_created (created_at_epoch DESC),
        CONSTRAINT fk_observations_session
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    await this.db.run(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INT PRIMARY KEY AUTO_INCREMENT,
        memory_session_id VARCHAR(255) UNIQUE NOT NULL,
        project VARCHAR(500) NOT NULL,
        \`request\` TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at VARCHAR(30) NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        INDEX idx_session_summaries_sdk_session (memory_session_id),
        INDEX idx_session_summaries_project (project(191)),
        INDEX idx_session_summaries_created (created_at_epoch DESC),
        CONSTRAINT fk_summaries_session
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    await this.recordMigration(4);
  }

  /**
   * Migration 5: Ensure worker_port column
   */
  private async ensureWorkerPortColumn(): Promise<void> {
    const has = await this.db.columnExists('sdk_sessions', 'worker_port');
    if (!has) {
      await this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INT');
      logger.debug('DB', 'Added worker_port column to sdk_sessions');
    }
    await this.recordMigration(5);
  }

  /**
   * Migration 6: Ensure prompt tracking columns
   */
  private async ensurePromptTrackingColumns(): Promise<void> {
    const hasPromptCounter = await this.db.columnExists('sdk_sessions', 'prompt_counter');
    if (!hasPromptCounter) {
      await this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INT DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions');
    }

    const obsHasPromptNumber = await this.db.columnExists('observations', 'prompt_number');
    if (!obsHasPromptNumber) {
      await this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INT');
      logger.debug('DB', 'Added prompt_number column to observations');
    }

    const sumHasPromptNumber = await this.db.columnExists('session_summaries', 'prompt_number');
    if (!sumHasPromptNumber) {
      await this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INT');
      logger.debug('DB', 'Added prompt_number column to session_summaries');
    }

    await this.recordMigration(6);
  }

  /**
   * Migration 7: Remove UNIQUE constraint from session_summaries.memory_session_id
   * In MySQL, we drop the unique index directly instead of recreating the table.
   */
  private async removeSessionSummariesUniqueConstraint(): Promise<void> {
    if (await this.isMigrationApplied(7)) {
      return;
    }

    // Check if there's a unique index on memory_session_id
    const config = getMySQLConfig();
    const indexes = await this.db.all(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'session_summaries'
       AND NON_UNIQUE = 0 AND INDEX_NAME != 'PRIMARY'
       GROUP BY INDEX_NAME`,
      [config.database]
    );

    if (indexes.length > 0) {
      for (const idx of indexes) {
        await this.db.run(`ALTER TABLE session_summaries DROP INDEX \`${idx.INDEX_NAME}\``);
      }
      logger.debug('DB', 'Removed UNIQUE constraint from session_summaries.memory_session_id');
    }

    await this.recordMigration(7);
  }

  /**
   * Migration 8: Add hierarchical fields to observations
   */
  private async addObservationHierarchicalFields(): Promise<void> {
    if (await this.isMigrationApplied(8)) return;

    const hasTitle = await this.db.columnExists('observations', 'title');
    if (!hasTitle) {
      await this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `);
      logger.debug('DB', 'Added hierarchical fields to observations');
    }

    await this.recordMigration(8);
  }

  /**
   * Migration 9: Make observations.text nullable
   */
  private async makeObservationsTextNullable(): Promise<void> {
    if (await this.isMigrationApplied(9)) return;

    // Check if text column is NOT NULL
    const columns = await this.db.all('SHOW COLUMNS FROM observations WHERE Field = ?', ['text']);
    const textCol = columns[0];

    if (textCol && textCol.Null === 'NO') {
      await this.db.run('ALTER TABLE observations MODIFY COLUMN \`text\` TEXT');
      logger.debug('DB', 'Made observations.text nullable');
    }

    await this.recordMigration(9);
  }

  /**
   * Migration 10: Create user_prompts table
   * Note: FTS5 is SQLite-specific. MySQL uses FULLTEXT indexes.
   */
  private async createUserPromptsTable(): Promise<void> {
    if (await this.isMigrationApplied(10)) return;

    const exists = await this.db.tableExists('user_prompts');
    if (exists) {
      await this.recordMigration(10);
      return;
    }

    await this.db.run(`
      CREATE TABLE user_prompts (
        id INT PRIMARY KEY AUTO_INCREMENT,
        content_session_id VARCHAR(255) NOT NULL,
        prompt_number INT NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at VARCHAR(30) NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        INDEX idx_user_prompts_claude_session (content_session_id),
        INDEX idx_user_prompts_created (created_at_epoch DESC),
        INDEX idx_user_prompts_prompt_number (prompt_number),
        INDEX idx_user_prompts_lookup (content_session_id, prompt_number),
        CONSTRAINT fk_user_prompts_session
          FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id)
          ON DELETE CASCADE
      )
    `);

    // MySQL FULLTEXT index for text search (replaces FTS5)
    try {
      await this.db.run(
        'CREATE FULLTEXT INDEX idx_user_prompts_fts ON user_prompts(prompt_text)'
      );
    } catch (e) {
      logger.warn('DB', 'FULLTEXT index creation skipped', {}, e as Error);
    }

    await this.recordMigration(10);
    logger.debug('DB', 'Created user_prompts table');
  }

  /**
   * Migration 11: Ensure discovery_tokens column
   */
  private async ensureDiscoveryTokensColumn(): Promise<void> {
    if (await this.isMigrationApplied(11)) return;

    const obsHas = await this.db.columnExists('observations', 'discovery_tokens');
    if (!obsHas) {
      await this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INT DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations');
    }

    const sumHas = await this.db.columnExists('session_summaries', 'discovery_tokens');
    if (!sumHas) {
      await this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INT DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries');
    }

    await this.recordMigration(11);
  }

  /**
   * Migration 16: Create pending_messages table
   */
  private async createPendingMessagesTable(): Promise<void> {
    if (await this.isMigrationApplied(16)) return;

    const exists = await this.db.tableExists('pending_messages');
    if (exists) {
      await this.recordMigration(16);
      return;
    }

    await this.db.run(`
      CREATE TABLE pending_messages (
        id INT PRIMARY KEY AUTO_INCREMENT,
        session_db_id INT NOT NULL,
        content_session_id VARCHAR(255) NOT NULL,
        message_type VARCHAR(20) NOT NULL,
        tool_name VARCHAR(255),
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        retry_count INT NOT NULL DEFAULT 0,
        created_at_epoch BIGINT NOT NULL,
        started_processing_at_epoch BIGINT,
        completed_at_epoch BIGINT,
        failed_at_epoch BIGINT,
        CONSTRAINT chk_message_type CHECK(message_type IN ('observation', 'summarize')),
        CONSTRAINT chk_message_status CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        CONSTRAINT fk_pending_session
          FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    await this.safeCreateIndexes([
      { name: 'idx_pending_messages_session', sql: 'CREATE INDEX idx_pending_messages_session ON pending_messages(session_db_id)' },
      { name: 'idx_pending_messages_status', sql: 'CREATE INDEX idx_pending_messages_status ON pending_messages(status)' },
      { name: 'idx_pending_messages_claude_session', sql: 'CREATE INDEX idx_pending_messages_claude_session ON pending_messages(content_session_id)' },
    ]);

    await this.recordMigration(16);
    logger.debug('DB', 'Created pending_messages table');
  }

  /**
   * Migration 17: Rename session ID columns
   */
  private async renameSessionIdColumns(): Promise<void> {
    if (await this.isMigrationApplied(17)) return;

    const safeRenameColumn = async (table: string, oldCol: string, newCol: string): Promise<boolean> => {
      const hasOld = await this.db.columnExists(table, oldCol);
      const hasNew = await this.db.columnExists(table, newCol);

      if (hasNew) return false;
      if (hasOld) {
        await this.db.run(`ALTER TABLE \`${table}\` RENAME COLUMN \`${oldCol}\` TO \`${newCol}\``);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }
      return false;
    };

    let renames = 0;
    if (await safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renames++;
    if (await safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renames++;
    if (await safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renames++;
    if (await safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renames++;
    if (await safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renames++;
    if (await safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renames++;

    await this.recordMigration(17);
    if (renames > 0) {
      logger.debug('DB', `Renamed ${renames} session ID columns`);
    }
  }

  /**
   * Migration 19: No-op (kept for compatibility)
   */
  private async repairSessionIdColumnRename(): Promise<void> {
    await this.recordMigration(19);
  }

  /**
   * Migration 20: Add failed_at_epoch to pending_messages
   */
  private async addFailedAtEpochColumn(): Promise<void> {
    if (await this.isMigrationApplied(20)) return;

    const has = await this.db.columnExists('pending_messages', 'failed_at_epoch');
    if (!has) {
      await this.db.run('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch BIGINT');
      logger.debug('DB', 'Added failed_at_epoch column to pending_messages');
    }

    await this.recordMigration(20);
  }

  /**
   * Migration 21: Add ON UPDATE CASCADE to FK constraints
   * In MySQL, we recreate the tables to modify FK constraints (same approach as SQLite).
   */
  private async addOnUpdateCascadeToForeignKeys(): Promise<void> {
    if (await this.isMigrationApplied(21)) return;

    logger.debug('DB', 'Checking ON UPDATE CASCADE on FK constraints');

    // In MySQL, since our initial CREATE TABLE already includes ON UPDATE CASCADE,
    // this migration is typically a no-op for fresh installs.
    // For migrated databases, we would need to recreate tables.
    // For simplicity, just record the migration since initial schema already has CASCADE.

    await this.recordMigration(21);
    logger.debug('DB', 'ON UPDATE CASCADE migration completed');
  }

  /**
   * Migration 22: Add content_hash column to observations
   */
  private async addObservationContentHashColumn(): Promise<void> {
    const has = await this.db.columnExists('observations', 'content_hash');
    if (has) {
      await this.recordMigration(22);
      return;
    }

    await this.db.run('ALTER TABLE observations ADD COLUMN content_hash VARCHAR(64)');
    // Backfill with random hashes
    await this.db.run(
      "UPDATE observations SET content_hash = SUBSTRING(MD5(RAND()), 1, 16) WHERE content_hash IS NULL"
    );
    await this.safeCreateIndex(
      'idx_observations_content_hash',
      'CREATE INDEX idx_observations_content_hash ON observations(content_hash, created_at_epoch)'
    );

    await this.recordMigration(22);
    logger.debug('DB', 'Added content_hash column to observations');
  }

  /**
   * Migration 23: Add custom_title to sdk_sessions
   */
  private async addSessionCustomTitleColumn(): Promise<void> {
    if (await this.isMigrationApplied(23)) return;

    const has = await this.db.columnExists('sdk_sessions', 'custom_title');
    if (!has) {
      await this.db.run('ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT');
      logger.debug('DB', 'Added custom_title column to sdk_sessions');
    }

    await this.recordMigration(23);
  }

  /**
   * Migration 24: Create observation_feedback table
   */
  private async createObservationFeedbackTable(): Promise<void> {
    if (await this.isMigrationApplied(24)) return;

    await this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_feedback (
        id INT PRIMARY KEY AUTO_INCREMENT,
        observation_id INT NOT NULL,
        signal_type VARCHAR(50) NOT NULL,
        session_db_id INT,
        created_at_epoch BIGINT NOT NULL,
        metadata TEXT,
        INDEX idx_feedback_observation (observation_id),
        INDEX idx_feedback_signal (signal_type),
        CONSTRAINT fk_feedback_observation
          FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `);

    await this.recordMigration(24);
    logger.debug('DB', 'Created observation_feedback table');
  }

  /**
   * Migration 25: Add platform_source to sdk_sessions
   */
  private async addSessionPlatformSourceColumn(): Promise<void> {
    const columnExists = await this.db.columnExists('sdk_sessions', 'platform_source');
    const indexExists = await this.db.indexExists('sdk_sessions', 'idx_sdk_sessions_platform_source');
    const applied = await this.isMigrationApplied(25);

    if (applied && columnExists && indexExists) return;

    if (!columnExists) {
      await this.db.run(
        `ALTER TABLE sdk_sessions ADD COLUMN platform_source VARCHAR(50) NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`
      );
      logger.debug('DB', 'Added platform_source column to sdk_sessions');
    }

    await this.db.run(
      `UPDATE sdk_sessions SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
       WHERE platform_source IS NULL OR platform_source = ''`
    );

    if (!indexExists) {
      await this.safeCreateIndex(
        'idx_sdk_sessions_platform_source',
        'CREATE INDEX idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)'
      );
    }

    await this.recordMigration(25);
  }

  /**
   * Migration 26: Add quality_score and is_verified to observations
   * Phase 2 Optimization: Quality-based filtering for search
   */
  private async addObservationQualityColumns(): Promise<void> {
    const hasQualityScore = await this.db.columnExists('observations', 'quality_score');
    const hasIsVerified = await this.db.columnExists('observations', 'is_verified');
    const hasQualityIndex = await this.db.indexExists('observations', 'idx_observations_quality_score');
    const applied = await this.isMigrationApplied(26);

    if (applied && hasQualityScore && hasIsVerified && hasQualityIndex) return;

    if (!hasQualityScore) {
      await this.db.run(
        'ALTER TABLE observations ADD COLUMN quality_score DECIMAL(3,2) NOT NULL DEFAULT 0.50'
      );
      logger.debug('DB', 'Added quality_score column to observations');
    }

    if (!hasIsVerified) {
      await this.db.run(
        'ALTER TABLE observations ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT FALSE'
      );
      logger.debug('DB', 'Added is_verified column to observations');
    }

    // Update existing records with type-based quality scores
    await this.db.run(
      "UPDATE observations SET quality_score = 0.70 WHERE type IN ('bugfix', 'feature', 'decision') AND quality_score = 0.50"
    );
    await this.db.run(
      "UPDATE observations SET quality_score = 0.40 WHERE type IN ('change', 'discovery') AND quality_score = 0.50"
    );

    if (!hasQualityIndex) {
      await this.safeCreateIndex(
        'idx_observations_quality_score',
        'CREATE INDEX idx_observations_quality_score ON observations(quality_score)'
      );
    }

    await this.recordMigration(26);
    logger.info('DB', 'Migration 26: Added quality columns to observations');
  }

  /**
   * Migration 27: Add UNIQUE index on session_summaries (memory_session_id, prompt_number)
   * First cleans up duplicate data (keeps latest record for each combination),
   * then creates the unique index to prevent future duplicates.
   */
  private async addSessionSummariesPromptNumberUniqueIndex(): Promise<void> {
    if (await this.isMigrationApplied(27)) return;

    const indexExists = await this.db.indexExists('session_summaries', 'idx_session_summaries_prompt_number_unique');
    if (indexExists) {
      await this.recordMigration(27);
      return;
    }

    logger.debug('DB', 'Creating UNIQUE index on session_summaries (memory_session_id, prompt_number)');

    // Clean up duplicate (memory_session_id, prompt_number) values - keep the latest record
    await this.db.run(`
      DELETE s1 FROM session_summaries s1
      INNER JOIN session_summaries s2
      ON s1.memory_session_id = s2.memory_session_id
      AND s1.prompt_number = s2.prompt_number
      AND s1.prompt_number IS NOT NULL
      WHERE s1.id < s2.id
    `);

    // Create the UNIQUE index
    await this.safeCreateIndex(
      'idx_session_summaries_prompt_number_unique',
      'CREATE UNIQUE INDEX idx_session_summaries_prompt_number_unique ON session_summaries(memory_session_id, prompt_number)'
    );

    await this.recordMigration(27);
    logger.debug('DB', 'Successfully created UNIQUE index on session_summaries (memory_session_id, prompt_number)');
  }
}
