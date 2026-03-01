import { Database } from './sqlite-compat.js';
import type { TableNameRow } from '../../types/database.js';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isDirectChild } from '../../shared/path-utils.js';
import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult,
  SearchOptions,
  SearchFilters,
  ObservationRow,
  UserPromptRow
} from './types.js';

/**
 * Search interface for session-based memory
 * Provides filter-only structured queries for sessions, observations, and user prompts
 * Vector search is handled by ChromaDB - this class only supports filtering without query text
 */
export class SessionSearch {
  private db: Database;

  constructor(dbPathOrDb?: string | Database) {
    if (dbPathOrDb instanceof Database) {
      this.db = dbPathOrDb;
    } else {
      const dbPath = dbPathOrDb ?? (() => { ensureDir(DATA_DIR); return DB_PATH; })();
      this.db = new Database(dbPath);
      this.db.run('PRAGMA journal_mode = WAL');
    }

    // Ensure FTS tables exist
    this.ensureFTSTables();
  }

  /**
   * Return the underlying Database instance.
   * Used by BM25SearchStrategy to execute raw FTS5 BM25 queries directly.
   */
  getDb(): Database {
    return this.db;
  }

  /**
   * Ensure FTS5 tables exist for keyword search (BM25).
   *
   * FTS5 tables power BM25 keyword search alongside Chroma vector search.
   * Migration 24 recreates these tables with unicode61 tokenizer and optimized
   * column order for weighted BM25 scoring. Migration 26 adds topics + entities.
   *
   * This method creates tables only if they don't exist (fallback for fresh installs
   * where migration hasn't run yet). Migration 26 handles the enrichment upgrade.
   *
   * Column order for observations_fts matches bm25() weight order:
   * title(10.0), narrative(5.0), facts(3.0), concepts(2.0), subtitle(1.0), text(1.0), topics(2.0), entities(1.5)
   */
  private ensureFTSTables(): void {
    // Check if FTS tables already exist
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all() as TableNameRow[];
    const hasFTS = tables.some(t => t.name === 'observations_fts' || t.name === 'session_summaries_fts');

    if (hasFTS) {
      // Already migrated
      return;
    }

    logger.info('DB', 'Creating FTS5 tables');

    // Create observations_fts virtual table (8 columns including topics + entities)
    // Column order matches bm25() weight arguments: title=10, narrative=5, facts=3, concepts=2, subtitle=1, text=1, topics=2, entities=1.5
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title,
        narrative,
        facts,
        concepts,
        subtitle,
        text,
        topics,
        entities,
        content='observations',
        content_rowid='id',
        tokenize='unicode61'
      );
    `);

    // Populate with existing data
    // For entities, extract names from JSON array to avoid BM25 noise from JSON structure
    this.db.run(`
      INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
      SELECT id,
        COALESCE(title,''), COALESCE(narrative,''), COALESCE(facts,''),
        COALESCE(concepts,''), COALESCE(subtitle,''), COALESCE(text,''),
        COALESCE(topics,''),
        COALESCE((
          SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
          FROM json_each(entities)
        ), '')
      FROM observations;
    `);

    // Create triggers for observations
    // INSERT trigger
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES (new.id,
          COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''),
          COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''),
          COALESCE(new.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(new.entities)
          ), ''));
      END;
    `);

    // DELETE trigger
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES('delete', old.id,
          COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''),
          COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''),
          COALESCE(old.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(old.entities)
          ), ''));
      END;
    `);

    // UPDATE trigger — conditional WHEN clause prevents firing on access_count/pinned changes
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations
      WHEN OLD.title IS NOT NEW.title OR OLD.narrative IS NOT NEW.narrative OR OLD.facts IS NOT NEW.facts
        OR OLD.concepts IS NOT NEW.concepts OR OLD.subtitle IS NOT NEW.subtitle OR OLD.text IS NOT NEW.text
        OR OLD.topics IS NOT NEW.topics OR OLD.entities IS NOT NEW.entities
      BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES('delete', old.id,
          COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''),
          COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''),
          COALESCE(old.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(old.entities)
          ), ''));
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text, topics, entities)
        VALUES (new.id,
          COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''),
          COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''),
          COALESCE(new.topics,''),
          COALESCE((
            SELECT GROUP_CONCAT(json_extract(value, '$.name'), ', ')
            FROM json_each(new.entities)
          ), ''));
      END;
    `);

    // Create session_summaries_fts virtual table (unchanged from migration 24)
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
        request,
        investigated,
        learned,
        completed,
        next_steps,
        notes,
        content='session_summaries',
        content_rowid='id',
        tokenize='unicode61'
      );
    `);

    // Populate with existing data
    this.db.run(`
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      SELECT id, COALESCE(request,''), COALESCE(investigated,''), COALESCE(learned,''), COALESCE(completed,''), COALESCE(next_steps,''), COALESCE(notes,'')
      FROM session_summaries;
    `);

    // Create triggers for session_summaries (unchanged from migration 24)
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
      END;
    `);

    logger.info('DB', 'FTS5 tables created successfully');
  }


  /**
   * Build WHERE clause for structured filters
   */
  private buildFilterClause(
    filters: SearchFilters,
    params: (string | number)[],
    tableAlias: string = 'o'
  ): string {
    const conditions: string[] = [];

    // Project filter
    if (filters.project) {
      conditions.push(`${tableAlias}.project = ?`);
      params.push(filters.project);
    }

    // Type filter (for observations only)
    if (filters.type) {
      if (Array.isArray(filters.type)) {
        const placeholders = filters.type.map(() => '?').join(',');
        conditions.push(`${tableAlias}.type IN (${placeholders})`);
        params.push(...filters.type);
      } else {
        conditions.push(`${tableAlias}.type = ?`);
        params.push(filters.type);
      }
    }

    // Date range filter
    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        conditions.push(`${tableAlias}.created_at_epoch >= ?`);
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        conditions.push(`${tableAlias}.created_at_epoch <= ?`);
        params.push(endEpoch);
      }
    }

    // Concepts filter (JSON array search)
    if (filters.concepts) {
      const concepts = Array.isArray(filters.concepts) ? filters.concepts : [filters.concepts];
      const conceptConditions = concepts.map(() => {
        return `EXISTS (SELECT 1 FROM json_each(${tableAlias}.concepts) WHERE value = ?)`;
      });
      if (conceptConditions.length > 0) {
        conditions.push(`(${conceptConditions.join(' OR ')})`);
        params.push(...concepts);
      }
    }

    // Files filter (JSON array search)
    if (filters.files) {
      const files = Array.isArray(filters.files) ? filters.files : [filters.files];
      const fileConditions = files.map(() => {
        return `(
          EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_read) WHERE value LIKE ?)
          OR EXISTS (SELECT 1 FROM json_each(${tableAlias}.files_modified) WHERE value LIKE ?)
        )`;
      });
      if (fileConditions.length > 0) {
        conditions.push(`(${fileConditions.join(' OR ')})`);
        files.forEach(file => {
          params.push(`%${file}%`, `%${file}%`);
        });
      }
    }

    // Topics filter (JSON array search — AND: all specified topics must be present)
    if (filters.topics && filters.topics.length > 0) {
      for (const topic of filters.topics) {
        conditions.push(`EXISTS (SELECT 1 FROM json_each(${tableAlias}.topics) WHERE value = ?)`);
        params.push(topic);
      }
    }

    // Entity name filter (search within entities JSON array)
    if (filters.entity) {
      conditions.push(`EXISTS (SELECT 1 FROM json_each(${tableAlias}.entities) WHERE json_extract(value, '$.name') = ?)`);
      params.push(filters.entity);
    }

    // Entity type filter (search within entities JSON array)
    if (filters.entityType) {
      conditions.push(`EXISTS (SELECT 1 FROM json_each(${tableAlias}.entities) WHERE json_extract(value, '$.type') = ?)`);
      params.push(filters.entityType);
    }

    // Pinned filter
    if (filters.pinned === true) {
      conditions.push(`${tableAlias}.pinned = 1`);
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '';
  }

  /**
   * Build ORDER BY clause
   */
  private buildOrderClause(orderBy: SearchOptions['orderBy'] = 'relevance', hasFTS: boolean = true, ftsTable: string = 'observations_fts'): string {
    switch (orderBy) {
      case 'relevance':
        return hasFTS ? `ORDER BY ${ftsTable}.rank ASC` : 'ORDER BY o.created_at_epoch DESC';
      case 'date_desc':
        return 'ORDER BY o.created_at_epoch DESC';
      case 'date_asc':
        return 'ORDER BY o.created_at_epoch ASC';
      default:
        return 'ORDER BY o.created_at_epoch DESC';
    }
  }

  /**
   * Search observations using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchObservations(query: string | undefined, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: (string | number)[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    // FILTER-ONLY PATH: When no query text, query table directly
    // This enables date filtering which Chroma cannot do (requires direct SQLite access)
    if (!query) {
      const filterClause = this.buildFilterClause(filters, params, 'o');
      if (!filterClause) {
        throw new Error('Either query or filters required for search');
      }

      const orderClause = this.buildOrderClause(orderBy, false);

      const sql = `
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
    }

    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  /**
   * Search session summaries using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchSessions(query: string | undefined, options: SearchOptions = {}): SessionSummarySearchResult[] {
    const params: (string | number)[] = [];
    const { limit = 50, offset = 0, orderBy = 'relevance', ...filters } = options;

    // FILTER-ONLY PATH: When no query text, query session_summaries table directly
    if (!query) {
      const filterOptions = { ...filters };
      delete filterOptions.type;
      const filterClause = this.buildFilterClause(filterOptions, params, 's');
      if (!filterClause) {
        throw new Error('Either query or filters required for search');
      }

      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY s.created_at_epoch ASC'
        : 'ORDER BY s.created_at_epoch DESC';

      const sql = `
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${filterClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as SessionSummarySearchResult[];
    }

    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  /**
   * Find observations by concept tag
   */
  findByConcept(concept: string, options: SearchOptions = {}): ObservationSearchResult[] {
    const params: (string | number)[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    // Add concept to filters
    const conceptFilters = { ...filters, concepts: concept };
    const filterClause = this.buildFilterClause(conceptFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Check whether a JSON-serialized file list contains any file that is a direct child of folderPath.
   * Returns false for null, invalid JSON, or non-array values.
   */
  private hasDirectChildInJson(filesJson: string | null, folderPath: string): boolean {
    if (!filesJson) return false;
    try {
      const files: unknown = JSON.parse(filesJson);
      if (Array.isArray(files)) {
        return files.some((f: string) => isDirectChild(f, folderPath));
      }
    } catch { /* intentionally empty - invalid JSON treated as no files */ }
    return false;
  }

  /**
   * Check if an observation has any files that are direct children of the folder
   */
  private hasDirectChildFile(obs: ObservationSearchResult, folderPath: string): boolean {
    return this.hasDirectChildInJson(obs.files_modified, folderPath)
      || this.hasDirectChildInJson(obs.files_read, folderPath);
  }

  /**
   * Check if a session has any files that are direct children of the folder
   */
  private hasDirectChildFileSession(session: SessionSummarySearchResult, folderPath: string): boolean {
    return this.hasDirectChildInJson(session.files_read, folderPath)
      || this.hasDirectChildInJson(session.files_edited, folderPath);
  }

  /**
   * Find observations and summaries by file path
   * When isFolder=true, only returns results with files directly in the folder (not subfolders)
   */
  findByFile(filePath: string, options: SearchOptions = {}): {
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  } {
    const params: (string | number)[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', isFolder = false, ...filters } = options;

    // Query more results if we're filtering to direct children
    const queryLimit = isFolder ? limit * 3 : limit;

    // Add file to filters
    const fileFilters = { ...filters, files: filePath };
    const filterClause = this.buildFilterClause(fileFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const observationsSql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(queryLimit, offset);

    let observations = this.db.prepare(observationsSql).all(...params) as ObservationSearchResult[];

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      observations = observations.filter(obs => this.hasDirectChildFile(obs, filePath)).slice(0, limit);
    }

    // For session summaries, search files_read and files_edited
    const sessionParams: (string | number)[] = [];
    const sessionFilters = { ...filters };
    delete sessionFilters.type; // Remove type filter for sessions

    const baseConditions: string[] = [];
    if (sessionFilters.project) {
      baseConditions.push('s.project = ?');
      sessionParams.push(sessionFilters.project);
    }

    if (sessionFilters.dateRange) {
      const { start, end } = sessionFilters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('s.created_at_epoch >= ?');
        sessionParams.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('s.created_at_epoch <= ?');
        sessionParams.push(endEpoch);
      }
    }

    // File condition
    baseConditions.push(`(
      EXISTS (SELECT 1 FROM json_each(s.files_read) WHERE value LIKE ?)
      OR EXISTS (SELECT 1 FROM json_each(s.files_edited) WHERE value LIKE ?)
    )`);
    sessionParams.push(`%${filePath}%`, `%${filePath}%`);

    const sessionsSql = `
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${baseConditions.join(' AND ')}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;

    sessionParams.push(queryLimit, offset);

    let sessions = this.db.prepare(sessionsSql).all(...sessionParams) as SessionSummarySearchResult[];

    // Post-filter to direct children if isFolder mode
    if (isFolder) {
      sessions = sessions.filter(s => this.hasDirectChildFileSession(s, filePath)).slice(0, limit);
    }

    return { observations, sessions };
  }

  /**
   * Find observations by type
   */
  findByType(
    type: ObservationRow['type'] | ObservationRow['type'][],
    options: SearchOptions = {}
  ): ObservationSearchResult[] {
    const params: (string | number)[] = [];
    const { limit = 50, offset = 0, orderBy = 'date_desc', ...filters } = options;

    // Add type to filters
    const typeFilters = { ...filters, type };
    const filterClause = this.buildFilterClause(typeFilters, params, 'o');
    const orderClause = this.buildOrderClause(orderBy, false);

    const sql = `
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${filterClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as ObservationSearchResult[];
  }

  /**
   * Search user prompts using filter-only direct SQLite query.
   * Vector search is handled by ChromaDB - this only supports filtering without query text.
   */
  searchUserPrompts(query: string | undefined, options: SearchOptions = {}): UserPromptSearchResult[] {
    const params: (string | number)[] = [];
    const { limit = 20, offset = 0, orderBy = 'relevance', ...filters } = options;

    // Build filter conditions (join with sdk_sessions for project filtering)
    const baseConditions: string[] = [];
    if (filters.project) {
      baseConditions.push('s.project = ?');
      params.push(filters.project);
    }

    if (filters.dateRange) {
      const { start, end } = filters.dateRange;
      if (start) {
        const startEpoch = typeof start === 'number' ? start : new Date(start).getTime();
        baseConditions.push('up.created_at_epoch >= ?');
        params.push(startEpoch);
      }
      if (end) {
        const endEpoch = typeof end === 'number' ? end : new Date(end).getTime();
        baseConditions.push('up.created_at_epoch <= ?');
        params.push(endEpoch);
      }
    }

    // FILTER-ONLY PATH: When no query text, query user_prompts table directly
    if (!query) {
      if (baseConditions.length === 0) {
        throw new Error('Either query or filters required for search');
      }

      const whereClause = `WHERE ${baseConditions.join(' AND ')}`;
      const orderClause = orderBy === 'date_asc'
        ? 'ORDER BY up.created_at_epoch ASC'
        : 'ORDER BY up.created_at_epoch DESC';

      const sql = `
        SELECT up.*
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as UserPromptSearchResult[];
    }

    // Vector search with query text should be handled by ChromaDB
    // This method only supports filter-only queries (query=undefined)
    logger.warn('DB', 'Text search not supported - use ChromaDB for vector search');
    return [];
  }

  /**
   * Get all prompts for a session by content_session_id
   */
  getUserPromptsBySession(contentSessionId: string): UserPromptRow[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        content_session_id,
        prompt_number,
        prompt_text,
        created_at,
        created_at_epoch
      FROM user_prompts
      WHERE content_session_id = ?
      ORDER BY prompt_number ASC
    `);

    return stmt.all(contentSessionId) as UserPromptRow[];
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
