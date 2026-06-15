/**
 * MySQL SessionStore
 *
 * Async version of SessionStore adapted for MySQL.
 * Uses mysql2/promise for async operations.
 */

import { MySQLDatabase } from './Database.js';
import { runMigrations } from './migrations.js';
import { logger } from '../../utils/logger.js';
import {
  TableColumnInfo,
  IndexInfo,
  TableNameRow,
  SchemaVersion,
  ObservationRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  LatestPromptResult
} from '../../types/database.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';
import type { PendingMessageStore } from './PendingMessageStore.js';

// Re-export types for compatibility
export * from './types.js';

/**
 * MySQL Session Store
 *
 * Provides async CRUD operations for sessions, observations, and summaries.
 * Compatible with SQLite SessionStore API but using async MySQL operations.
 */
export class SessionStore {
  public db: MySQLDatabase;

  constructor(db?: MySQLDatabase) {
    this.db = db || new MySQLDatabase();
  }

  /**
   * Initialize database and run migrations
   */
  async initialize(): Promise<void> {
    await runMigrations(this.db);
    logger.info('DB', 'MySQL SessionStore initialized');
  }

  /**
   * Update memory session ID for a session
   */
  async updateMemorySessionId(sessionDbId: number, memorySessionId: string | null): Promise<void> {
    await this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(memorySessionId, sessionDbId);
  }

  /**
   * Mark session as completed
   */
  async markSessionCompleted(sessionDbId: number): Promise<void> {
    const nowEpoch = Date.now();
    await this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = FROM_UNIXTIME(?/1000), completed_at_epoch = ?
      WHERE id = ?
    `).run(nowEpoch, nowEpoch, sessionDbId);
  }

  /**
   * Ensure memory_session_id is registered before FK-constrained INSERT
   */
  async ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): Promise<void> {
    const session = await this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get<{ id: number; memory_session_id: string | null }>(sessionDbId);

    if (!session) {
      throw new Error(`Session ${sessionDbId} not found in sdk_sessions`);
    }

    if (session.memory_session_id !== memorySessionId) {
      await this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(memorySessionId, sessionDbId);

      logger.info('DB', 'Registered memory_session_id before storage (FK fix)', {
        sessionDbId,
        oldId: session.memory_session_id,
        newId: memorySessionId
      });
    }
  }

  /**
   * Get recent session summaries for a project
   */
  async getRecentSummaries(project: string, limit: number = 10): Promise<Array<{
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
  }>> {
    return await this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, limit);
  }

  /**
   * Get recent summaries with session info
   */
  async getRecentSummariesWithSessionInfo(project: string, limit: number = 3): Promise<Array<{
    memory_session_id: string;
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    prompt_number: number | null;
    created_at: string;
  }>> {
    return await this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, limit);
  }

  /**
   * Get recent observations for a project
   */
  async getRecentObservations(project: string, limit: number = 20): Promise<Array<{
    type: string;
    text: string;
    prompt_number: number | null;
    created_at: string;
  }>> {
    return await this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, limit);
  }

  /**
   * Get all recent observations (for web UI)
   */
  async getAllRecentObservations(limit: number = 100): Promise<Array<{
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
  }>> {
    return await this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, ?) as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(DEFAULT_PLATFORM_SOURCE, limit);
  }

  /**
   * Get all recent summaries (for web UI)
   */
  async getAllRecentSummaries(limit: number = 50): Promise<Array<{
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
  }>> {
    return await this.db.prepare(`
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
        COALESCE(s.platform_source, ?) as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `).all(DEFAULT_PLATFORM_SOURCE, limit);
  }

  /**
   * Get all recent user prompts (for web UI)
   */
  async getAllRecentUserPrompts(limit: number = 100): Promise<Array<{
    id: number;
    content_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }>> {
    return await this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, ?) as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(DEFAULT_PLATFORM_SOURCE, limit);
  }

  /**
   * Get all unique projects
   */
  async getAllProjects(platformSource?: string): Promise<string[]> {
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : undefined;
    let sql = `
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
    `;
    const params: unknown[] = [];

    if (normalizedPlatformSource) {
      sql += ' AND COALESCE(platform_source, ?) = ?';
      params.push(DEFAULT_PLATFORM_SOURCE, normalizedPlatformSource);
    }

    sql += ' ORDER BY project ASC';

    const rows = await this.db.prepare(sql).all(...params) as Array<{ project: string }>;
    return rows.map(row => row.project);
  }

  /**
   * Get project catalog
   */
  async getProjectCatalog(): Promise<{
    projects: string[];
    sources: string[];
    projectsBySource: Record<string, string[]>;
  }> {
    const rows = await this.db.prepare(`
      SELECT
        COALESCE(platform_source, ?) as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      GROUP BY COALESCE(platform_source, ?), project
      ORDER BY latest_epoch DESC
    `).all(DEFAULT_PLATFORM_SOURCE, DEFAULT_PLATFORM_SOURCE) as Array<{
      platform_source: string;
      project: string;
      latest_epoch: number;
    }>;

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

  /**
   * Get latest user prompt for a session
   */
  async getLatestUserPrompt(contentSessionId: string): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  } | undefined> {
    return await this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, ?) as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(DEFAULT_PLATFORM_SOURCE, contentSessionId) as LatestPromptResult | undefined;
  }

  /**
   * Get recent sessions with status
   */
  async getRecentSessionsWithStatus(project: string, limit: number = 3): Promise<Array<{
    memory_session_id: string | null;
    status: string;
    started_at: string;
    user_prompt: string | null;
    has_summary: boolean;
  }>> {
    return await this.db.prepare(`
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
    `).all(project, limit);
  }

  /**
   * Get observations for a session
   */
  async getObservationsForSession(memorySessionId: string): Promise<Array<{
    title: string;
    subtitle: string;
    type: string;
    prompt_number: number | null;
  }>> {
    return await this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(memorySessionId);
  }

  /**
   * Get observation by ID
   */
  async getObservationById(id: number): Promise<ObservationRecord | null> {
    const result = await this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(id);
    return result as ObservationRecord || null;
  }

  /**
   * Get observations by IDs with ordering and limit
   */
  async getObservationsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string; type?: string | string[]; concepts?: string | string[]; files?: string | string[] } = {}
  ): Promise<ObservationRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project, type, concepts, files } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
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
      // MySQL JSON_CONTAINS for concepts filter
      const conceptConditions = conceptsList.map(() =>
        'JSON_CONTAINS(concepts, JSON_QUOTE(?))'
      );
      params.push(...conceptsList);
      additionalConditions.push(`(${conceptConditions.join(' OR ')})`);
    }

    if (files) {
      const filesList = Array.isArray(files) ? files : [files];
      // MySQL JSON_CONTAINS for files filter
      const fileConditions = filesList.map(() => {
        return '(JSON_CONTAINS(files_read, JSON_QUOTE(?)) OR JSON_CONTAINS(files_modified, JSON_QUOTE(?)))';
      });
      filesList.forEach(file => {
        params.push(file, file);
      });
      additionalConditions.push(`(${fileConditions.join(' OR ')})`);
    }

    const whereClause = additionalConditions.length > 0
      ? `WHERE id IN (${placeholders}) AND ${additionalConditions.join(' AND ')}`
      : `WHERE id IN (${placeholders})`;

    const sql = `
      SELECT *
      FROM observations
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `;

    return await this.db.prepare(sql).all(...params) as ObservationRecord[];
  }

  /**
   * Get observations associated with a given file path, scoped to specific projects.
   * Matches on the full file path (not just basename) to avoid cross-project collisions.
   */
  async getObservationsByFilePath(
    filePath: string,
    options?: { projects?: string[]; limit?: number }
  ): Promise<ObservationRecord[]> {
    const rawLimit = options?.limit;
    const limit = Number.isInteger(rawLimit) && (rawLimit as number) > 0
      ? Math.min(rawLimit as number, 100)
      : 15;
    const params: (string | number)[] = [filePath, filePath];

    let projectClause = '';
    if (options?.projects?.length) {
      const placeholders = options.projects.map(() => '?').join(',');
      projectClause = `AND project IN (${placeholders})`;
      params.push(...options.projects);
    }

    params.push(limit);

    const sql = `
      SELECT *
      FROM observations
      WHERE (
        JSON_CONTAINS(files_read, JSON_QUOTE(?))
        OR JSON_CONTAINS(files_modified, JSON_QUOTE(?))
      )
      ${projectClause}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `;

    return await this.db.prepare(sql).all(...params) as ObservationRecord[];
  }

  /**
   * Get summary for a session
   */
  async getSummaryForSession(memorySessionId: string): Promise<{
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
  } | null> {
    const result = await this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(memorySessionId) as { request: string | null; investigated: string | null; learned: string | null; completed: string | null; next_steps: string | null; files_read: string | null; files_edited: string | null; notes: string | null; prompt_number: number | null; created_at: string; created_at_epoch: number } | null;
    return result || null;
  }

  /**
   * Get session by ID
   */
  async getSessionById(id: number): Promise<{
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    status: string;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
  } | null> {
    const result = await this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, status, project,
             COALESCE(platform_source, ?) as platform_source,
             user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(DEFAULT_PLATFORM_SOURCE, id) as { id: number; content_session_id: string; memory_session_id: string | null; status: string; project: string; platform_source: string; user_prompt: string; custom_title: string | null } | null;
    return result || null;
  }

  /**
   * Get session started_at_epoch by ID
   * Used for wall-clock age validation in ensureGeneratorRunning
   */
  async getSessionStartedAtEpoch(id: number): Promise<number | null> {
    const result = await this.db.prepare(`
      SELECT started_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(id) as { started_at_epoch: number } | undefined;
    return result?.started_at_epoch ?? null;
  }

  /**
   * Get SDK sessions by session IDs
   */
  async getSdkSessionsBySessionIds(memorySessionIds: string[]): Promise<Array<{
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
  }>> {
    if (memorySessionIds.length === 0) return [];

    const placeholders = memorySessionIds.map(() => '?').join(',');
    return await this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, ?) as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${placeholders})
      ORDER BY started_at_epoch DESC
    `).all(DEFAULT_PLATFORM_SOURCE, ...memorySessionIds) as any[];
  }

  /**
   * Get prompt number from user_prompts count
   */
  async getPromptNumberFromUserPrompts(contentSessionId: string): Promise<number> {
    const result = await this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(contentSessionId) as { count: number };
    return result.count;
  }

  /**
   * Create SDK session (idempotent)
   */
  async createSDKSession(
    contentSessionId: string,
    project: string,
    userPrompt: string,
    customTitle?: string,
    platformSource?: string
  ): Promise<number> {
    const now = Date.now();
    const normalizedPlatformSource = platformSource ? normalizePlatformSource(platformSource) : DEFAULT_PLATFORM_SOURCE;

    // Check if session exists
    const existing = await this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get<{ id: number; platform_source: string | null }>(contentSessionId);

    if (existing) {
      // Backfill project if empty
      if (project) {
        await this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(project, contentSessionId);
      }

      // Backfill custom_title if empty
      if (customTitle) {
        await this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(customTitle, contentSessionId);
      }

      return existing.id;
    }

    // Create new session
    await this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?, 'active')
    `).run(contentSessionId, project, normalizedPlatformSource, userPrompt, customTitle || null, now, now);

    // Get new ID
    const row = await this.db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?')
      .get<{ id: number }>(contentSessionId);
    return row!.id;
  }

  /**
   * Save user prompt
   */
  async saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): Promise<number> {
    const now = Date.now();

    const result = await this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, FROM_UNIXTIME(?/1000), ?)
    `).run(contentSessionId, promptNumber, promptText, now, now);

    return result.insertId;
  }

  /**
   * Get user prompt
   */
  async getUserPrompt(contentSessionId: string, promptNumber: number): Promise<string | null> {
    const result = await this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get<{ prompt_text: string }>(contentSessionId, promptNumber);
    return result?.prompt_text ?? null;
  }

  /**
   * Store observation
   */
  async storeObservation(
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
    },
    promptNumber?: number,
    discoveryTokens: number = 0,
    overrideTimestampEpoch?: number,
    generatedByModel?: string
  ): Promise<{ id: number; createdAtEpoch: number }> {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();

    // Generate content hash
    const contentHash = this.computeContentHash(memorySessionId, observation.title, observation.narrative);

    // Level 1: Dedup check by content_hash
    const existingByHash = await this.db.prepare(
      `SELECT id, created_at_epoch FROM observations WHERE content_hash = ?`
    ).get(contentHash) as { id: number; created_at_epoch: number } | undefined;

    if (existingByHash) {
      return { id: existingByHash.id, createdAtEpoch: existingByHash.created_at_epoch };
    }

    // Level 2: Dedup check by title within same session
    // This prevents duplicate initialization observations when SDK agent restarts after crash recovery
    const existingByTitle = await this.findDuplicateByTitle(memorySessionId, observation.title);
    if (existingByTitle) {
      return { id: existingByTitle.id, createdAtEpoch: existingByTitle.created_at_epoch };
    }

    const result = await this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
       generated_by_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?, ?)
    `).run(
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
      contentHash,
      timestampEpoch,
      timestampEpoch,
      generatedByModel || null
    );

    return {
      id: result.insertId,
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * Compute content hash for deduplication
   */
  private computeContentHash(memorySessionId: string, title: string | null, narrative: string | null): string {
    const content = `${memorySessionId}:${title || ''}:${narrative || ''}`;
    // Simple hash (not crypto, but sufficient for deduplication)
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(16, '0');
  }

  /**
   * Check if an observation with the same title exists for the same memory_session_id.
   * This prevents duplicate initialization observations when SDK agent restarts after crash recovery.
   */
  private async findDuplicateByTitle(
    memorySessionId: string,
    title: string | null
  ): Promise<{ id: number; created_at_epoch: number } | null> {
    if (!title) return null;
    const existing = await this.db.prepare(
      'SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND title = ? ORDER BY id DESC LIMIT 1'
    ).get(memorySessionId, title) as { id: number; created_at_epoch: number } | undefined;
    return existing ?? null;
  }

  /**
   * Store summary
   */
  async storeSummary(
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
  ): Promise<{ id: number; createdAtEpoch: number }> {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();

    // Dedup check: check by (memory_session_id, prompt_number) if promptNumber is provided
    if (promptNumber !== undefined && promptNumber !== null) {
      const existing = await this.db.prepare(
        `SELECT id, created_at_epoch FROM session_summaries
         WHERE memory_session_id = ? AND prompt_number = ?`
      ).get(memorySessionId, promptNumber) as { id: number; created_at_epoch: number } | undefined;

      if (existing) {
        return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
      }
    } else {
      // Fallback: check by memory_session_id only if no prompt_number
      const existing = await this.db.prepare(
        `SELECT id, created_at_epoch FROM session_summaries WHERE memory_session_id = ? ORDER BY id DESC LIMIT 1`
      ).get(memorySessionId) as { id: number; created_at_epoch: number } | undefined;

      if (existing) {
        return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
      }
    }

    const result = await this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?)
    `).run(
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
      timestampEpoch,
      timestampEpoch
    );

    return {
      id: result.insertId,
      createdAtEpoch: timestampEpoch
    };
  }

  /**
   * Store observations (atomic)
   */
  async storeObservations(
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
  ): Promise<{ observationIds: number[]; summaryId: number | null; createdAtEpoch: number }> {
    const timestampEpoch = overrideTimestampEpoch ?? Date.now();

    const tx = this.db.transaction(async (txConn) => {
      const observationIds: number[] = [];

      for (const observation of observations) {
        const contentHash = this.computeContentHash(memorySessionId, observation.title, observation.narrative);

        // Level 1: Dedup check by content_hash
        const existingByHash = await txConn.prepare(
          `SELECT id FROM observations WHERE content_hash = ?`
        ).get(contentHash) as { id: number } | undefined;

        if (existingByHash) {
          observationIds.push(existingByHash.id);
          continue; // Skip INSERT
        }

        // Level 2: Dedup check by title within same session
        // This prevents duplicate initialization observations when SDK agent restarts after crash recovery
        if (observation.title) {
          const existingByTitle = await txConn.prepare(
            `SELECT id FROM observations WHERE memory_session_id = ? AND title = ? ORDER BY id DESC LIMIT 1`
          ).get(memorySessionId, observation.title) as { id: number } | undefined;

          if (existingByTitle) {
            observationIds.push(existingByTitle.id);
            continue; // Skip INSERT
          }
        }

        const obsStmt = txConn.prepare(`
          INSERT INTO observations
          (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
           files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
           generated_by_model)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?, ?)
        `);

        const result = await obsStmt.run(
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
          contentHash,
          timestampEpoch,
          timestampEpoch,
          generatedByModel || null
        );
        observationIds.push(result.insertId);
      }

      let summaryId: number | null = null;
      if (summary) {
        // Dedup check: check by (memory_session_id, prompt_number) if promptNumber is provided
        if (promptNumber !== undefined && promptNumber !== null) {
          const existingSummary = await txConn.prepare(
            `SELECT id FROM session_summaries WHERE memory_session_id = ? AND prompt_number = ?`
          ).get(memorySessionId, promptNumber) as { id: number } | undefined;

          if (existingSummary) {
            summaryId = existingSummary.id;
          }
        }

        // Only INSERT if no existing summary found
        if (summaryId === null) {
          const summaryStmt = txConn.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?)
          `);

          const result = await summaryStmt.run(
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
            timestampEpoch,
            timestampEpoch
          );
          summaryId = result.insertId;
        }
      }

      return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
    });

    return await tx();
  }

  /**
   * Get session summaries by IDs
   */
  async getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): Promise<SessionSummaryRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    const whereClause = project
      ? `WHERE id IN (${placeholders}) AND project = ?`
      : `WHERE id IN (${placeholders})`;
    if (project) params.push(project);

    return await this.db.prepare(`
      SELECT * FROM session_summaries
      ${whereClause}
      ORDER BY created_at_epoch ${orderClause}
      ${limitClause}
    `).all(...params) as SessionSummaryRecord[];
  }

  /**
   * Get user prompts by IDs
   */
  async getUserPromptsByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc'; limit?: number; project?: string } = {}
  ): Promise<UserPromptRecord[]> {
    if (ids.length === 0) return [];

    const { orderBy = 'date_desc', limit, project } = options;
    const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
    const limitClause = limit ? `LIMIT ${limit}` : '';
    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    const projectFilter = project ? 'AND s.project = ?' : '';
    if (project) params.push(project);

    return await this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${placeholders}) ${projectFilter}
      ORDER BY up.created_at_epoch ${orderClause}
      ${limitClause}
    `).all(...params) as UserPromptRecord[];
  }

  /**
   * Get or create manual session
   */
  async getOrCreateManualSession(project: string): Promise<string> {
    const memorySessionId = `manual-${project}`;
    const contentSessionId = `manual-content-${project}`;

    const existing = await this.db.prepare(
      'SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?'
    ).get<{ memory_session_id: string }>(memorySessionId);

    if (existing) {
      return memorySessionId;
    }

    const now = Date.now();
    await this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?, 'active')
    `).run(memorySessionId, contentSessionId, project, DEFAULT_PLATFORM_SOURCE, now, now);

    logger.info('SESSION', 'Created manual session', { memorySessionId, project });

    return memorySessionId;
  }

  /**
   * Get database statistics (counts of observations, sessions, summaries)
   */
  async getStats(): Promise<{ observations: number; sessions: number; summaries: number }> {
    const totalObservations = await this.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    const totalSessions = await this.db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
    const totalSummaries = await this.db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

    return {
      observations: totalObservations.count,
      sessions: totalSessions.count,
      summaries: totalSummaries.count
    };
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Import SDK session with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  async importSdkSession(session: {
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
  }): Promise<{ imported: boolean; id: number }> {
    // Check if session already exists
    const existing = await this.db.prepare(
      'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
    ).get(session.content_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?, ?, ?, ?)
    `).run(
      session.content_session_id,
      session.memory_session_id,
      session.project,
      normalizePlatformSource(session.platform_source),
      session.user_prompt,
      session.started_at_epoch,
      session.started_at_epoch,
      session.completed_at_epoch,
      session.completed_at_epoch,
      session.status
    );

    return { imported: true, id: result.insertId };
  }

  /**
   * Import session summary with duplicate checking
   * Returns: { imported: boolean, id: number }
   */
  async importSessionSummary(summary: {
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
  }): Promise<{ imported: boolean; id: number }> {
    // Check if summary already exists for this session
    const existing = await this.db.prepare(
      'SELECT id FROM session_summaries WHERE memory_session_id = ?'
    ).get(summary.memory_session_id) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?)
    `).run(
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
      summary.created_at_epoch,
      summary.created_at_epoch
    );

    return { imported: true, id: result.insertId };
  }

  /**
   * Import observation with duplicate checking
   * Duplicates are identified by memory_session_id + title + created_at_epoch
   * Returns: { imported: boolean, id: number }
   */
  async importObservation(obs: {
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
  }): Promise<{ imported: boolean; id: number }> {
    // Check if observation already exists
    const existing = await this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(obs.memory_session_id, obs.title, obs.created_at_epoch) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), ?)
    `).run(
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
      obs.created_at_epoch,
      obs.created_at_epoch
    );

    return { imported: true, id: result.insertId };
  }

  /**
   * Import user prompt with duplicate checking
   * Duplicates are identified by content_session_id + prompt_number
   * Returns: { imported: boolean, id: number }
   */
  async importUserPrompt(prompt: {
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    created_at: string;
    created_at_epoch: number;
  }): Promise<{ imported: boolean; id: number }> {
    // Check if prompt already exists
    const existing = await this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(prompt.content_session_id, prompt.prompt_number) as { id: number } | undefined;

    if (existing) {
      return { imported: false, id: existing.id };
    }

    const result = await this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, FROM_UNIXTIME(?/1000), ?)
    `).run(
      prompt.content_session_id,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at_epoch,
      prompt.created_at_epoch
    );

    return { imported: true, id: result.insertId };
  }

  /**
   * Rebuild FTS index (MySQL doesn't have FTS5, this is a no-op)
   */
  async rebuildObservationsFTSIndex(): Promise<void> {
    // MySQL doesn't use FTS5 like SQLite - no-op for MySQL
    // MySQL uses built-in full-text search or external tools like Chroma
  }
}