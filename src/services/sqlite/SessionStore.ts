import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { DATA_DIR, DB_PATH, ensureDir, OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  SdkSessionRecord,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult
} from '../../types/database.js';
import type { PendingMessageStore } from './PendingMessageStore.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from './types.js';
import { computeObservationContentHash } from './observations/store.js';
import { parseFileList } from './observations/files.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';

function resolveCreateSessionArgs(
  customTitle?: string,
  platformSource?: string
): { customTitle?: string; platformSource?: string } {
  return {
    customTitle,
    platformSource: platformSource ? normalizePlatformSource(platformSource) : undefined
  };
}

export class SessionStore {
  public db: Database;

  constructor(dbPathOrDb: string | Database = DB_PATH) {
    if (dbPathOrDb instanceof Database) {
      this.db = dbPathOrDb;
    } else {
      if (dbPathOrDb !== ':memory:') {
        ensureDir(DATA_DIR);
      }
      this.db = new Database(dbPathOrDb);

      this.db.run('PRAGMA journal_mode = WAL');
      this.db.run('PRAGMA synchronous = NORMAL');
      this.db.run('PRAGMA foreign_keys = ON');
      this.db.run('PRAGMA journal_size_limit = 4194304'); 
    }

    this.initializeSchema();

    this.ensureWorkerPortColumn();
    this.ensurePromptTrackingColumns();
    this.removeSessionSummariesUniqueConstraint();
    this.addObservationHierarchicalFields();
    this.makeObservationsTextNullable();
    this.createUserPromptsTable();
    this.ensureDiscoveryTokensColumn();
    this.createPendingMessagesTable();
    this.renameSessionIdColumns();
    this.repairSessionIdColumnRename();
    this.addFailedAtEpochColumn();
    this.addOnUpdateCascadeToForeignKeys();
    this.addObservationContentHashColumn();
    this.addSessionCustomTitleColumn();
    this.addSessionPlatformSourceColumn();
    this.addObservationModelColumns();
    this.ensureMergedIntoProjectColumns();
    this.addObservationSubagentColumns();
    this.addObservationsUniqueContentHashIndex();
    this.addObservationsMetadataColumn();
    this.dropDeadPendingMessagesColumns();
    this.ensurePendingMessagesToolUseIdColumn();
    this.dropWorkerPidColumn();
  }

  private dropWorkerPidColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(32) as SchemaVersion | undefined;

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasColumn = cols.some(c => c.name === 'worker_pid');
    if (applied && !hasColumn) return;

    if (hasColumn) {
      try {
        this.db.run('DROP INDEX IF EXISTS idx_pending_messages_worker_pid');
        this.db.run('ALTER TABLE pending_messages DROP COLUMN worker_pid');
        logger.debug('DB', 'Dropped worker_pid column and its index from pending_messages');
      } catch (error) {
        logger.warn('DB', 'Failed to drop worker_pid column from pending_messages', {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(32, new Date().toISOString());
    }
  }

  private dropDeadPendingMessagesColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(31) as SchemaVersion | undefined;

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const colNames = new Set(cols.map(c => c.name));
    const deadColumns = ['retry_count', 'failed_at_epoch', 'completed_at_epoch'];
    const toDrop = deadColumns.filter(name => colNames.has(name));
    if (applied && toDrop.length === 0) return;

    if (toDrop.length > 0) {
      this.db.run('BEGIN TRANSACTION');
      try {
        this.db.run(`DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')`);
        for (const colName of toDrop) {
          this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${colName}`);
          logger.debug('DB', `Dropped dead column ${colName} from pending_messages`);
        }
        if (!applied) {
          this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
        }
        this.db.run('COMMIT');
      } catch (error) {
        this.db.run('ROLLBACK');
        logger.warn('DB', 'Failed to drop dead columns from pending_messages', {}, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      return;
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
    }
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
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

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

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
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString());
  }

  private ensureWorkerPortColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasWorkerPort = tableInfo.some(col => col.name === 'worker_port');

    if (!hasWorkerPort) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER');
      logger.debug('DB', 'Added worker_port column to sdk_sessions table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());
  }

  private ensurePromptTrackingColumns(): void {
    const sessionsInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasPromptCounter = sessionsInfo.some(col => col.name === 'prompt_counter');

    if (!hasPromptCounter) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0');
      logger.debug('DB', 'Added prompt_counter column to sdk_sessions table');
    }

    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasPromptNumber = observationsInfo.some(col => col.name === 'prompt_number');

    if (!obsHasPromptNumber) {
      this.db.run('ALTER TABLE observations ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to observations table');
    }

    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasPromptNumber = summariesInfo.some(col => col.name === 'prompt_number');

    if (!sumHasPromptNumber) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER');
      logger.debug('DB', 'Added prompt_number column to session_summaries table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString());
  }

  private removeSessionSummariesUniqueConstraint(): void {
    const summariesIndexes = this.db.query('PRAGMA index_list(session_summaries)').all() as IndexInfo[];
    const hasUniqueConstraint = summariesIndexes.some(idx => idx.unique === 1 && idx.origin !== 'pk');

    if (!hasUniqueConstraint) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Removing UNIQUE constraint from session_summaries.memory_session_id');

    this.db.run('BEGIN TRANSACTION');

    this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    this.db.run(`
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

    this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `);

    this.db.run('DROP TABLE session_summaries');

    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `);

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString());

    logger.debug('DB', 'Successfully removed UNIQUE constraint from session_summaries.memory_session_id');
  }

  private addObservationHierarchicalFields(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(8) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasTitle = tableInfo.some(col => col.name === 'title');

    if (hasTitle) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Adding hierarchical fields to observations table');

    this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `);

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString());

    logger.debug('DB', 'Successfully added hierarchical fields to observations table');
  }

  private makeObservationsTextNullable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(9) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const textColumn = tableInfo.find(col => col.name === 'text');

    if (!textColumn || textColumn.notnull === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Making observations.text nullable');

    this.db.run('BEGIN TRANSACTION');

    this.db.run('DROP TABLE IF EXISTS observations_new');

    this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `);

    this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `);

    this.db.run('DROP TABLE observations');

    this.db.run('ALTER TABLE observations_new RENAME TO observations');

    this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `);

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString());

    logger.debug('DB', 'Successfully made observations.text nullable');
  }

  private createUserPromptsTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(10) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(user_prompts)').all() as TableColumnInfo[];
    if (tableInfo.length > 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating user_prompts table with FTS5 support');

    this.db.run('BEGIN TRANSACTION');

    this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);

    const ftsCreateSQL = `
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `;
    const ftsTriggersSQL = `
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `;

    try {
      this.db.run(ftsCreateSQL);
      this.db.run(ftsTriggersSQL);
    } catch (ftsError) {
      if (ftsError instanceof Error) {
        logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, ftsError);
      } else {
        logger.warn('DB', 'FTS5 not available — user_prompts_fts skipped (search uses ChromaDB)', {}, new Error(String(ftsError)));
      }
      this.db.run('COMMIT');
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());
      logger.debug('DB', 'Created user_prompts table (without FTS5)');
      return;
    }

    this.db.run('COMMIT');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString());

    logger.debug('DB', 'Successfully created user_prompts table');
  }

  private ensureDiscoveryTokensColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(11) as SchemaVersion | undefined;
    if (applied) return;

    const observationsInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasDiscoveryTokens = observationsInfo.some(col => col.name === 'discovery_tokens');

    if (!obsHasDiscoveryTokens) {
      this.db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to observations table');
    }

    const summariesInfo = this.db.query('PRAGMA table_info(session_summaries)').all() as TableColumnInfo[];
    const sumHasDiscoveryTokens = summariesInfo.some(col => col.name === 'discovery_tokens');

    if (!sumHasDiscoveryTokens) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0');
      logger.debug('DB', 'Added discovery_tokens column to session_summaries table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString());
  }

  private createPendingMessagesTable(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(16) as SchemaVersion | undefined;
    if (applied) return;

    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all() as TableNameRow[];
    if (tables.length > 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());
      return;
    }

    logger.debug('DB', 'Creating pending_messages table');

    this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString());

    logger.debug('DB', 'pending_messages table created successfully');
  }

  private renameSessionIdColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(17) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Checking session ID columns for semantic clarity rename');

    let renamesPerformed = 0;

    const safeRenameColumn = (table: string, oldCol: string, newCol: string): boolean => {
      const tableInfo = this.db.query(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const hasOldCol = tableInfo.some(col => col.name === oldCol);
      const hasNewCol = tableInfo.some(col => col.name === newCol);

      if (hasNewCol) {
        return false;
      }

      if (hasOldCol) {
        this.db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
        logger.debug('DB', `Renamed ${table}.${oldCol} to ${newCol}`);
        return true;
      }

      logger.warn('DB', `Column ${oldCol} not found in ${table}, skipping rename`);
      return false;
    };

    if (safeRenameColumn('sdk_sessions', 'claude_session_id', 'content_session_id')) renamesPerformed++;
    if (safeRenameColumn('sdk_sessions', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('pending_messages', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    if (safeRenameColumn('observations', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('session_summaries', 'sdk_session_id', 'memory_session_id')) renamesPerformed++;

    if (safeRenameColumn('user_prompts', 'claude_session_id', 'content_session_id')) renamesPerformed++;

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString());

    if (renamesPerformed > 0) {
      logger.debug('DB', `Successfully renamed ${renamesPerformed} session ID columns`);
    } else {
      logger.debug('DB', 'No session ID column renames needed (already up to date)');
    }
  }

  private repairSessionIdColumnRename(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(19) as SchemaVersion | undefined;
    if (applied) return;

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(19, new Date().toISOString());
  }

  private addFailedAtEpochColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(20) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'failed_at_epoch');

    if (!hasColumn) {
      this.db.run('ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER');
      logger.debug('DB', 'Added failed_at_epoch column to pending_messages table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(20, new Date().toISOString());
  }

  private addOnUpdateCascadeToForeignKeys(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(21) as SchemaVersion | undefined;
    if (applied) return;

    logger.debug('DB', 'Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries');

    this.db.run('PRAGMA foreign_keys = OFF');
    this.db.run('BEGIN TRANSACTION');

    this.db.run('DROP TRIGGER IF EXISTS observations_ai');
    this.db.run('DROP TRIGGER IF EXISTS observations_ad');
    this.db.run('DROP TRIGGER IF EXISTS observations_au');

    this.db.run('DROP TABLE IF EXISTS observations_new');

    const observationsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const observationsHasMetadata = observationsCols.some(c => c.name === 'metadata');
    const metadataColumnSQL = observationsHasMetadata ? ',\n        metadata TEXT' : '';
    const metadataSelectSQL = observationsHasMetadata ? ', metadata' : '';

    const observationsNewSQL = `
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
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
        created_at_epoch INTEGER NOT NULL${metadataColumnSQL},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const observationsCopySQL = `
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${metadataSelectSQL}
      FROM observations
    `;
    const observationsIndexesSQL = `
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `;
    const observationsFTSTriggersSQL = `
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
    `;

    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
    this.db.run('DROP TRIGGER IF EXISTS session_summaries_au');

    this.db.run('DROP TABLE IF EXISTS session_summaries_new');

    const summariesNewSQL = `
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
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `;
    const summariesCopySQL = `
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `;
    const summariesIndexesSQL = `
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `;
    const summariesFTSTriggersSQL = `
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
    `;

    try {
      this.recreateObservationsWithCascade(observationsNewSQL, observationsCopySQL, observationsIndexesSQL, observationsFTSTriggersSQL);
      this.recreateSessionSummariesWithCascade(summariesNewSQL, summariesCopySQL, summariesIndexesSQL, summariesFTSTriggersSQL);

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(21, new Date().toISOString());
      this.db.run('COMMIT');
      this.db.run('PRAGMA foreign_keys = ON');
      logger.debug('DB', 'Successfully added ON UPDATE CASCADE to FK constraints');
    } catch (error) {
      this.db.run('ROLLBACK');
      this.db.run('PRAGMA foreign_keys = ON');
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }

  private recreateObservationsWithCascade(createSQL: string, copySQL: string, indexesSQL: string, ftsTriggersSQL: string): void {
    this.db.run(createSQL);
    this.db.run(copySQL);
    this.db.run('DROP TABLE observations');
    this.db.run('ALTER TABLE observations_new RENAME TO observations');
    this.db.run(indexesSQL);

    const hasFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all() as { name: string }[]).length > 0;
    if (hasFTS) {
      this.db.run(ftsTriggersSQL);
    }
  }

  private recreateSessionSummariesWithCascade(createSQL: string, copySQL: string, indexesSQL: string, ftsTriggersSQL: string): void {
    this.db.run(createSQL);
    this.db.run(copySQL);
    this.db.run('DROP TABLE session_summaries');
    this.db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');
    this.db.run(indexesSQL);

    const hasSummariesFTS = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all() as { name: string }[]).length > 0;
    if (hasSummariesFTS) {
      this.db.run(ftsTriggersSQL);
    }
  }

  private addObservationContentHashColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'content_hash');

    if (hasColumn) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
      return;
    }

    this.db.run('ALTER TABLE observations ADD COLUMN content_hash TEXT');
    this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL");
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)');
    logger.debug('DB', 'Added content_hash column to observations table with backfill and index');

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(22, new Date().toISOString());
  }

  private addSessionCustomTitleColumn(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(23) as SchemaVersion | undefined;
    if (applied) return;

    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'custom_title');

    if (!hasColumn) {
      this.db.run('ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT');
      logger.debug('DB', 'Added custom_title column to sdk_sessions table');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(23, new Date().toISOString());
  }

  private addSessionPlatformSourceColumn(): void {
    const tableInfo = this.db.query('PRAGMA table_info(sdk_sessions)').all() as TableColumnInfo[];
    const hasColumn = tableInfo.some(col => col.name === 'platform_source');
    const indexInfo = this.db.query('PRAGMA index_list(sdk_sessions)').all() as IndexInfo[];
    const hasIndex = indexInfo.some(index => index.name === 'idx_sdk_sessions_platform_source');
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(24) as SchemaVersion | undefined;

    if (applied && hasColumn && hasIndex) return;

    if (!hasColumn) {
      this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}'`);
      logger.debug('DB', 'Added platform_source column to sdk_sessions table');
    }

    this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${DEFAULT_PLATFORM_SOURCE}'
      WHERE platform_source IS NULL OR platform_source = ''
    `);

    if (!hasIndex) {
      this.db.run('CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());
  }

  private addObservationModelColumns(): void {
    const columns = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasGeneratedByModel = columns.some(col => col.name === 'generated_by_model');
    const hasRelevanceCount = columns.some(col => col.name === 'relevance_count');

    if (hasGeneratedByModel && hasRelevanceCount) return;

    if (!hasGeneratedByModel) {
      this.db.run('ALTER TABLE observations ADD COLUMN generated_by_model TEXT');
    }
    if (!hasRelevanceCount) {
      this.db.run('ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(26, new Date().toISOString());
  }

  private ensureMergedIntoProjectColumns(): void {
    const obsCols = this.db
      .query('PRAGMA table_info(observations)')
      .all() as TableColumnInfo[];
    if (!obsCols.some(c => c.name === 'merged_into_project')) {
      this.db.run('ALTER TABLE observations ADD COLUMN merged_into_project TEXT');
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)'
    );

    const sumCols = this.db
      .query('PRAGMA table_info(session_summaries)')
      .all() as TableColumnInfo[];
    if (!sumCols.some(c => c.name === 'merged_into_project')) {
      this.db.run('ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT');
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)'
    );
  }

  private addObservationSubagentColumns(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(27) as SchemaVersion | undefined;

    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const obsHasAgentType = obsCols.some(col => col.name === 'agent_type');
    const obsHasAgentId = obsCols.some(col => col.name === 'agent_id');

    if (!obsHasAgentType) {
      this.db.run('ALTER TABLE observations ADD COLUMN agent_type TEXT');
    }
    if (!obsHasAgentId) {
      this.db.run('ALTER TABLE observations ADD COLUMN agent_id TEXT');
    }
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)');

    const pendingCols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    if (pendingCols.length > 0) {
      const pendingHasAgentType = pendingCols.some(col => col.name === 'agent_type');
      const pendingHasAgentId = pendingCols.some(col => col.name === 'agent_id');
      if (!pendingHasAgentType) {
        this.db.run('ALTER TABLE pending_messages ADD COLUMN agent_type TEXT');
      }
      if (!pendingHasAgentId) {
        this.db.run('ALTER TABLE pending_messages ADD COLUMN agent_id TEXT');
      }
    }

    if (!applied) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(27, new Date().toISOString());
    }
  }

  private ensurePendingMessagesToolUseIdColumn(): void {
    const tables = this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
    ).all() as TableNameRow[];
    if (tables.length === 0) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
      return;
    }

    const cols = this.db.query('PRAGMA table_info(pending_messages)').all() as TableColumnInfo[];
    const hasToolUseId = cols.some(c => c.name === 'tool_use_id');

    if (!hasToolUseId) {
      this.db.run('ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT');
    }

    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run(`
        DELETE FROM pending_messages
         WHERE id IN (
           SELECT id
             FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY content_session_id, tool_use_id
                        ORDER BY CASE status
                          WHEN 'processing' THEN 0
                          WHEN 'pending' THEN 1
                          ELSE 2
                        END, id
                      ) AS duplicate_rank
                 FROM pending_messages
                WHERE tool_use_id IS NOT NULL
             )
            WHERE duplicate_rank > 1
           )
      `);
      this.db.run(`
        -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
        -- only for rows that came from a concrete tool-use event.
        CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
        ON pending_messages(content_session_id, tool_use_id)
        WHERE tool_use_id IS NOT NULL
      `);

      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, new Date().toISOString());
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  private addObservationsUniqueContentHashIndex(): void {
    const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(29) as SchemaVersion | undefined;
    if (applied) return;

    const obsCols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasMem = obsCols.some(c => c.name === 'memory_session_id');
    const hasHash = obsCols.some(c => c.name === 'content_hash');
    if (!hasMem || !hasHash) {
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
      return;
    }

    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run(`
        DELETE FROM observations
         WHERE id NOT IN (
           SELECT MIN(id) FROM observations
            GROUP BY memory_session_id, content_hash
         )
      `);
      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
        ON observations(memory_session_id, content_hash)
      `);
      this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(29, new Date().toISOString());
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  private addObservationsMetadataColumn(): void {
    const cols = this.db.query('PRAGMA table_info(observations)').all() as TableColumnInfo[];
    const hasColumn = cols.some(c => c.name === 'metadata');

    if (!hasColumn) {
      this.db.run('ALTER TABLE observations ADD COLUMN metadata TEXT');
      logger.debug('DB', 'Added metadata column to observations table (#2116)');
    }

    this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(30, new Date().toISOString());
  }

  updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): void {
    this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(memorySessionId, sessionDbId);
  }

  markSessionCompleted(sessionDbId: number): void {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(nowIso, nowEpoch, sessionDbId);
  }

  ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): void {
    const session = this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId) as { id: number; memory_session_id: string | null } | undefined;

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }

    if (session.memory_session_id !== memorySessionId) {
      this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(memorySessionId, sessionDbId);

      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId
      });
    }
  }

  getRecentSummaries(project: string, limit: number = 10): Array<{
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit) as Array<{
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      prompt_number: number | null;
      created_at: string;
    }>;
  }

  getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Array<{
    memory_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit) as Array<{
      memory_session_id: string;
      request: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      prompt_number: number | null;
      created_at: string;
    }>;
  }

  getRecentObservations(project: string, limit: number = 20): Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(project, limit) as Array<{
      type: string;
      text: string;
      prompt_number: number | null;
      created_at: string;
    }>;
  }

  getAllRecentObservations(limit: number = 100): Array<{
    id: number;
    type: string;
    title: string | null;
    subtitle: string | null;
    text: string;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit) as Array<{
      id: number;
      type: string;
      title: string | null;
      subtitle: string | null;
      text: string;
      project: string;
      platform_source: string;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getAllRecentSummaries(limit: number = 50): Array<{
    id: number;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    project: string;
    platform_source: string;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        ss.id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.files_read,
        ss.files_edited,
        ss.notes,
        ss.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit) as Array<{
      id: number;
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      project: string;
      platform_source: string;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getAllRecentUserPrompts(limit: number = 100): Array<{
    id: number;
    content_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `);

    return stmt.all(limit) as Array<{
      id: number;
      content_session_id: string;
      project: string;
      platform_source: string;
      prompt_number: number;
      prompt_text: string;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getAllProjects(platformSource?: string): string[] {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let query = `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `;
    const params: SQLQueryBindings[] = [OBSERVER_SESSIONS_PROJECT];

    if (normalizedPlatformSource) {
      query += ' AND COALESCE(platform_source, ?) = ?';
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }

    query += ' ORDER BY project ASC';

    const rows = this.db.prepare(query).all(...params) as Array<{ project: string }>;
    return rows.map(row => row.project);
  }

  getProjectCatalog(): {
    projects: string[];
    sources: string[];
    projectsBySource: Record<string, string[]>;
  } {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}'), project
      ORDER BY latest_epoch DESC
    `).all(OBSERVER_SESSIONS_PROJECT) as Array<{ platform_source: string; project: string; latest_epoch: number }>;

    const projects: string[] = [];
    const seenProjects = new Set<string>();
    const projectsBySource: Record<string, string[]> = {};

    for (const row of rows) {
      const source = normalizePlatformSource(row.platform_source);

      if (!projectsBySource[source]) {
        projectsBySource[source] = [];
      }

      if (!projectsBySource[source].includes(row.project)) {
        projectsBySource[source].push(row.project);
      }

      if (!seenProjects.has(row.project)) {
        seenProjects.add(row.project);
        projects.push(row.project);
      }
    }

    const sources = sortPlatformSources(Object.keys(projectsBySource));

    return {
      projects,
      sources,
      projectsBySource: Object.fromEntries(
        sources.map(source => [source, projectsBySource[source] || []])
      )
    };
  }

  getLatestUserPrompt(contentSessionId: string): {
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined {
    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `);

    return stmt.get(contentSessionId) as LatestPromptResult | undefined;
  }

  getRecentSessionsWithStatus(project: string, limit: number = 3): Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }> {
    const stmt = this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `);

    return stmt.all(project, limit) as Array<{
      memory_session_id: string | null;
      status: string;
      started_at: string;
      user_prompt: string | null;
      has_summary: boolean;
    }>;
  }

  getObservationsForSession(memorySessionId: string): Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `);

    return stmt.all(memorySessionId) as Array<{
      title: string;
      subtitle: string;
      type: string;
      prompt_number: number | null;
    }>;
  }

  getObservationById(id: number): ObservationRecord | null {
    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `);

    return stmt.get(id) as ObservationRecord | undefined || null;
  }

  getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): ObservationSearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit ? `LIMIT ${limit}` : '';

    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];
    const additionalConditions: string[] = [];

    if (project) {
      additionalConditions.push('project = ?');
      params.push(project);
    }

    if (type) {
      if (Array.isArray(type)) {
        const typePlaceholders = type.map(() => '?').join(',');
        additionalConditions.push(`type IN (${typePlaceholders})`);
        params.push(...type);
      } else {
        additionalConditions.push('type = ?');
        params.push(type);
      }
    }

    if (concepts) {
      const conceptsList = Array.isArray(concepts) ? concepts : [concepts];
      const conceptConditions = conceptsList.map(() =>
        'EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)'
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      const fileConditions = filesList.map(() => {
        return '(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))';
      });
      filesList.forEach(file => {
        params.push(`%${file}%`, `%${file}%`);
      });
      additionalConditions.push(`(${fileConditions.join(' OR ')})`);
    }

    const whereClause = additionalConditions.length > 0
      ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
      : `WHERE id IN (${placeholders})`;

    const stmt = this.db.prepare(`
      SELECT *
      FROM observations
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as ObservationSearchResult[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => rowMap.get(id)).filter((r): r is ObservationSearchResult => !!r);
  }

  getSummaryForSession(memorySessionId: string): {
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `);

    return (stmt.get(memorySessionId) as {
      request: string | null;
      investigated: string | null;
      learned: string | null;
      completed: string | null;
      next_steps: string | null;
      files_read: string | null;
      files_edited: string | null;
      notes: string | null;
      prompt_number: number | null;
      created_at: string;
      created_at_epoch: number;
    } | null) || null;
  }

  getFilesForSession(memorySessionId: string): {
    filesRead: string[];
    filesModified: string[];
  } {
    const stmt = this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `);

    const rows = stmt.all(memorySessionId) as Array<{
      files_read: string | null;
      files_modified: string | null;
    }>;

    const filesReadSet = new Set<string>();
    const filesModifiedSet = new Set<string>();

    for (const row of rows) {
      parseFileList(row.files_read).forEach(f => filesReadSet.add(f));

      parseFileList(row.files_modified).forEach(f => filesModifiedSet.add(f));
    }

    return {
      filesRead: Array.from(filesReadSet),
      filesModified: Array.from(filesModifiedSet)
    };
  }

  getSessionById(id: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
  } | null {
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as {
      id: number;
      content_session_id: string;
      memory_session_id: string | null;
      project: string;
      platform_source: string;
      user_prompt: string;
      custom_title: string | null;
      status: string;
    } | null) || null;
  }

  getSdkSessionsBySessionIds(memorySessionIds: string[]): {
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }[] {
    if (memorySessionIds.length === 0) return [];

    const placeholders = memorySessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${DEFAULT_PLATFORM_SOURCE}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `);

    return stmt.all(...memorySessionIds) as any[];
  }

  getPromptNumberFromUserPrompts(contentSessionId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(contentSessionId) as { count: number };
    return result.count;
  }

  createSDKSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    customTitle?: string,
    platformSource?: string
  ): number {
    const now = new Date();
    const nowEpoch = now.getTime();
    const resolved = resolveCreateSessionArgs(customTitle, platformSource);
    const normalizedPlatformSource = resolved.platformSource ?? DEFAULT_PLATFORM_SOURCE;

    const existing = this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(contentSessionId) as { id: number; platform_source: string | null } | undefined;

    if (existing) {
      if (project) {
        this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(project, contentSessionId);
      }
      if (resolved.customTitle) {
        this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(resolved.customTitle, contentSessionId);
      }

      if (resolved.platformSource) {
        const storedPlatformSource = existing.platform_source?.trim()
          ? normalizePlatformSource(existing.platform_source)
          : undefined;

        if (!storedPlatformSource) {
          this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(resolved.platformSource, contentSessionId);
        } else if (storedPlatformSource !== resolved.platformSource) {
          throw new Error(
            `Platform source conflict for session ${contentSessionId}: existing=${storedPlatformSource}, received=${resolved.platformSource}`
          );
        }
      }
      return existing.id;
    }

    this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, resolved.customTitle || null, now.toISOString(), nowEpoch);

    const row = this.db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
      .get(contentSessionId) as { id: number };
    return row.id;
  }

  saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): number {
    const now = new Date();
    const nowEpoch = now.getTime();

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(contentSessionId, promptNumber, promptText, now.toISOString(), nowEpoch);
    return result.lastInsertRowid as number;
  }

  getUserPrompt(contentSessionId: string, promptNumber: number): string | null {
    const stmt = this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `);

    const result = stmt.get(contentSessionId, promptNumber) as { prompt_text: string } | undefined;
    return result?.prompt_text ?? null;
  }

  storeObservation(
    memorySessionId: string,
    project: string,
    observation: {
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      agent_type?: string | null;
      agent_id?: string | null;
      metadata?: string | null;
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): { id: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);

    const stmt = this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
       generated_by_model, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id, created_at_epoch
    `);

    const inserted = stmt.get(
      memorySessionId,
      project,
      observation.type,
      observation.title,
      observation.subtitle,
      JSON.stringify(observation.facts),
      observation.narrative,
      JSON.stringify(observation.concepts),
      JSON.stringify(observation.files_read),
      JSON.stringify(observation.files_modified),
      promptNumber || null,
      discoveryTokens,
      observation.agent_type ?? null,
      observation.agent_id ?? null,
      contentHash,
      timestampIso,
      timestampEpoch,
      generatedByModel || null,
      observation.metadata ?? null
    ) as { id: number; created_at_epoch: number } | null;

    if (inserted) {
      return { id: inserted.id, createdAtEpoch: inserted.created_at_epoch };
    }

    const existing = this.db.prepare(
      'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?'
    ).get(memorySessionId, contentHash) as { id: number; created_at_epoch: number } | null;

    if (!existing) {
      throw new Error(
        `storeObservation: ON CONFLICT without existing row for content_hash=${contentHash}`
      );
    }
    return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
  }

  storeSummary(
    memorySessionId: string,
    project: string,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number
  ): { id: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      memorySessionId,
      project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      promptNumber || null,
      discoveryTokens,
      timestampIso,
      timestampEpoch
    );

    return {
      id: Number(result.lastInsertRowid),
      createdAtEpoch: timestampEpoch
    };
  }

  storeObservations(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      agent_type?: string | null;
      agent_id?: string | null;
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): { observationIds: number[]; summaryId: number | null; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const storeTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `);
      const lookupExistingStmt = this.db.prepare(
        'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
      );

      for (const observation of observations) {
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const inserted = obsStmt.get(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          observation.agent_type ?? null,
          observation.agent_id ?? null,
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null
        ) as { id: number } | null;

        if (inserted) {
          observationIds.push(inserted.id);
          continue;
        }

        const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
        if (!existing) {
          throw new Error(
            `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`
          );
        }
        observationIds.push(existing.id);
      }

      let summaryId: number | null = null;
      if (summary) {
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    return storeTx();
  }

  storeObservationsAndMarkComplete(
    memorySessionId: string,
    project: string,
    observations: Array<{
      type: string;
      title: string | null;
      subtitle: string | null;
      facts: string[];
      narrative: string | null;
      concepts: string[];
      files_read: string[];
      files_modified: string[];
      agent_type?: string | null;
      agent_id?: string | null;
    }>,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    } | null,
    messageId: number,
    _pendingStore: PendingMessageStore,
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): { observationIds: number[]; summaryId?: number; createdAtEpoch: number } {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();
    const timestampIso = new Date(timestampEpoch).toISOString();

    const storeAndMarkTx = this.db.transaction(() => {
      const observationIds: number[] = [];

      const obsStmt = this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `);
      const lookupExistingStmt = this.db.prepare(
        'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?'
      );

      for (const observation of observations) {
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const inserted = obsStmt.get(
          memorySessionId,
          project,
          observation.type,
          observation.title,
          observation.subtitle,
          JSON.stringify(observation.facts),
          observation.narrative,
          JSON.stringify(observation.concepts),
          JSON.stringify(observation.files_read),
          JSON.stringify(observation.files_modified),
          promptNumber || null,
          discoveryTokens,
          observation.agent_type ?? null,
          observation.agent_id ?? null,
          contentHash,
          timestampIso,
          timestampEpoch,
          generatedByModel || null
        ) as { id: number } | null;

        if (inserted) {
          observationIds.push(inserted.id);
          continue;
        }

        const existing = lookupExistingStmt.get(memorySessionId, contentHash) as { id: number } | null;
        if (!existing) {
          throw new Error(
            `storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${contentHash}`
          );
        }
        observationIds.push(existing.id);
      }

      let summaryId: number | undefined;
      if (summary) {
        const summaryStmt = this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = summaryStmt.run(
          memorySessionId,
          project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.notes,
          promptNumber || null,
          discoveryTokens,
          timestampIso,
          timestampEpoch
        );
        summaryId = Number(result.lastInsertRowid);
      }

      // Current queue rows are live work only; completed work is removed, not retained as processed.
      const deleteStmt = this.db.prepare(`
        DELETE FROM pending_messages
        WHERE id = ? AND status = 'processing'
      `);
      const deleteResult = deleteStmt.run(messageId);
      if (deleteResult.changes !== 1) {
        throw new Error(`storeObservationsAndMarkComplete: failed to complete pending message ${messageId}`);
      }

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    return storeAndMarkTx();
  }

  getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string } = {}
  ): SessionSummarySearchResult[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    const whereClause = project
      ? `WHERE id IN (${placeholders}) AND project = ?`
      : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT * FROM session_summaries
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as SessionSummarySearchResult[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => rowMap.get(id)).filter((r): r is SessionSummarySearchResult => !!r);
  }

  getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string } = {}
  ): UserPromptRecord[] {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const preserveIdOrder = orderBy === 'relevance';
    const orderClause = preserveIdOrder ? '' : `ORDER BY up.created_at_epoch ${orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    const projectFilter = project ? 'AND s.project = ?' : '';
    if (project) params.push(project);

    const stmt = this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ${orderClause}
      ${limitClause}
    `);

    const rows = stmt.all(...params) as UserPromptRecord[];
    if (!preserveIdOrder) return rows;

    const rowMap = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => rowMap.get(id)).filter((r): r is UserPromptRecord => !!r);
  }

  getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    return this.getTimelineAroundObservation(null, anchorEpoch, depthBefore, depthAfter, project);
  }

  getTimelineAroundObservation(
    anchorObservationId: number | null,
    anchorEpoch: number,
    depthBefore: number = 10,
    depthAfter: number = 10,
    project?: string
  ): {
    observations: any[];
    sessions: any[];
    prompts: any[];
  } {
    const projectFilter = project ? 'AND project = ?' : '';
    const projectParams = project ? [project] : [];

    let startEpoch: number;
    let endEpoch: number;

    if (anchorObservationId !== null) {
      const beforeQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${projectFilter}
        ORDER BY id DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${projectFilter}
        ORDER BY id ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorObservationId, ...projectParams, depthBefore + 1) as Array<{id: number; created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorObservationId, ...projectParams, depthAfter + 1) as Array<{id: number; created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error('DB', 'Error getting boundary observations', { project }, err);
        } else {
          logger.error('DB', 'Error getting boundary observations with non-Error', {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    } else {
      const beforeQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${projectFilter}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `;
      const afterQuery = `
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${projectFilter}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;

      try {
        const beforeRecords = this.db.prepare(beforeQuery).all(anchorEpoch, ...projectParams, depthBefore) as Array<{created_at_epoch: number}>;
        const afterRecords = this.db.prepare(afterQuery).all(anchorEpoch, ...projectParams, depthAfter + 1) as Array<{created_at_epoch: number}>;

        if (beforeRecords.length === 0 && afterRecords.length === 0) {
          return { observations: [], sessions: [], prompts: [] };
        }

        startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
        endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
      } catch (err) {
        if (err instanceof Error) {
          logger.error('DB', 'Error getting boundary timestamps', { project }, err);
        } else {
          logger.error('DB', 'Error getting boundary timestamps with non-Error', {}, new Error(String(err)));
        }
        return { observations: [], sessions: [], prompts: [] };
      }
    }

    const obsQuery = `
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const sessQuery = `
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
    `;

    const promptQuery = `
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
      ORDER BY up.created_at_epoch ASC
    `;

    const observations = this.db.prepare(obsQuery).all(startEpoch, endEpoch, ...projectParams) as ObservationRecord[];
    const sessions = this.db.prepare(sessQuery).all(startEpoch, endEpoch, ...projectParams) as SessionSummaryRecord[];
    const prompts = this.db.prepare(promptQuery).all(startEpoch, endEpoch, ...projectParams) as UserPromptRecord[];

    return {
      observations,
      sessions: sessions.map(s => ({
        id: s.id,
        memory_session_id: s.memory_session_id,
        project: s.project,
        request: s.request,
        completed: s.completed,
        next_steps: s.next_steps,
        created_at: s.created_at,
        created_at_epoch: s.created_at_epoch
      })),
      prompts: prompts.map(p => ({
        id: p.id,
        content_session_id: p.content_session_id,
        prompt_number: p.prompt_number,
        prompt_text: p.prompt_text,
        project: p.project,
        created_at: p.created_at,
        created_at_epoch: p.created_at_epoch
      }))
    };
  }

  getPromptById(id: number): {
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as {
      id: number;
      content_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    } | null) || null;
  }

  getPromptsByIds(ids: number[]): Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string;
    created_at: string;
    created_at_epoch: number;
  }> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${placeholders})
      ORDER BY p.created_at_epoch DESC
    `);

    return stmt.all(...ids) as Array<{
      id: number;
      content_session_id: string;
      prompt_number: number;
      prompt_text: string;
      project: string;
      created_at: string;
      created_at_epoch: number;
    }>;
  }

  getSessionSummaryById(id: number): {
    id: number;
    memory_session_id: string | null;
    content_session_id: string;
    project: string;
    user_prompt: string;
    request_summary: string | null;
    learned_summary: string | null;
    status: string;
    created_at: string;
    created_at_epoch: number;
  } | null {
    const stmt = this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    return (stmt.get(id) as {
      id: number;
      memory_session_id: string | null;
      content_session_id: string;
      project: string;
      user_prompt: string;
      request_summary: string | null;
      learned_summary: string | null;
      status: string;
      created_at: string;
      created_at_epoch: number;
    } | null) || null;
  }

  getOrCreateManualSession(project: string): string {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = this.db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get(memorySessionId) as { memory_session_id: string } | undefined;

    if (existing) {
      return memorySessionId;
    }

    const now = new Date();
    this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(memorySessionId, contentSessionId, project, DEFAULT_PLATFORM_SOURCE, now.toISOString(), now.getTime());

    logger.info('SESSION', 'Created manual session', { memorySessionId, project });

    return memorySessionId;
  }

  close(): void {
    this.db.close();
  }

  importSdkSession(session: {
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source?: string;
    user_prompt: string;
    started_at: string;
    started_at_epoch: number;
    completed_at: string | null;
    completed_at_epoch: number | null;
    status: string;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(
      'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
    ).get(session.content_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      session.content_session_id,
      session.memory_session_id,
      session.project,
      normalizePlatformSource(session.platform_source),
      session.user_prompt,
      session.started_at,
      session.started_at_epoch,
      session.completed_at,
      session.completed_at_epoch,
      session.status
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  importSessionSummary(summary: {
    memory_session_id: string;
    project: string;
    request: string | null;
    investigated: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    files_read: string | null;
    files_edited: string | null;
    notes: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(
      'SELECT id FROM session_summaries WHERE memory_session_id = ?'
    ).get(summary.memory_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.memory_session_id,
      summary.project,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.files_read,
      summary.files_edited,
      summary.notes,
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.created_at,
      summary.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  importObservation(obs: {
    memory_session_id: string;
    project: string;
    text: string | null;
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string | null;
    narrative: string | null;
    concepts: string | null;
    files_read: string | null;
    files_modified: string | null;
    prompt_number: number | null;
    discovery_tokens: number;
    created_at: string;
    created_at_epoch: number;
    agent_type?: string | null;
    agent_id?: string | null;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.memory_session_id, obs.title, obs.created_at_epoch) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.memory_session_id,
      obs.project,
      obs.text,
      obs.type,
      obs.title,
      obs.subtitle,
      obs.facts,
      obs.narrative,
      obs.concepts,
      obs.files_read,
      obs.files_modified,
      obs.prompt_number,
      obs.discovery_tokens || 0,
      obs.agent_type ?? null,
      obs.agent_id ?? null,
      obs.created_at,
      obs.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }

  rebuildObservationsFTSIndex(): void {
    const hasFTS = (this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'"
    ).all() as { name: string }[]).length > 0;

    if (!hasFTS) {
      return;
    }

    this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
  }

  importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): { imported: boolean; id: number } {
    const existing = this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(prompt.content_session_id, prompt.prompt_number) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      prompt.content_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at,
      prompt.created_at_epoch
    );

    return { imported: true, id: result.lastInsertRowid as number };
  }
}
