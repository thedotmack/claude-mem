import type { SQLQueryBindings } from 'bun:sqlite';
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import { USER_PROMPT_DEDUPE_WINDOW_MS } from '../../shared/user-prompts.js';
import type { PaginatedResult, Observation, Summary, UserPrompt, AdvisorCall } from '../worker-types.js';

/**
 * Resolve results from either sync (SQLite) or async (MySQL) .all() calls.
 * MySQL's mysql2 prepared-statement .all() returns Promise<any[]>,
 * while SQLite (bun:sqlite) .all() returns any[] synchronously.
 */
async function resolveResults<T>(resultsOrPromise: T[] | Promise<T[]>): Promise<T[]> {
  if (resultsOrPromise && typeof (resultsOrPromise as any).then === 'function') {
    return await resultsOrPromise;
  }
  return resultsOrPromise as T[];
}

export class PaginationHelper {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  private stripProjectPath(filePath: string, projectName: string): string {
    const leaf = projectName.includes('/') ? projectName.split('/').pop()! : projectName;
    const marker = `/${leaf}/`;
    const index = filePath.indexOf(marker);

    if (index !== -1) {
      return filePath.substring(index + marker.length);
    }

    return filePath;
  }

  private stripProjectPaths(filePathsStr: string | null, projectName: string): string | null {
    if (!filePathsStr) return filePathsStr;

    try {
      const paths = JSON.parse(filePathsStr) as string[];

      const strippedPaths = paths.map(p => this.stripProjectPath(p, projectName));

      return JSON.stringify(strippedPaths);
    } catch (err) {
      if (err instanceof Error) {
        logger.debug('WORKER', 'File paths is plain string, using as-is', {}, err);
      } else {
        logger.debug('WORKER', 'File paths is plain string, using as-is', { rawError: String(err) });
      }
      return filePathsStr;
    }
  }

  private sanitizeObservation(obs: Observation): Observation {
    return {
      ...obs,
      files_read: this.stripProjectPaths(obs.files_read, obs.project),
      files_modified: this.stripProjectPaths(obs.files_modified, obs.project)
    };
  }

  async getObservations(offset: number, limit: number, project?: string, platformSource?: string): Promise<PaginatedResult<Observation>> {
    const db = this.dbManager.getSessionStore().db;
    let query = `
      SELECT
        o.id,
        o.memory_session_id,
        o.project,
        o.merged_into_project,
        COALESCE(s.platform_source, 'claude') as platform_source,
        o.type,
        o.title,
        o.subtitle,
        o.narrative,
        o.text,
        o.facts,
        o.concepts,
        o.files_read,
        o.files_modified,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    `;
    const params: SQLQueryBindings[] = [];
    const conditions: string[] = [];

    if (project) {
      conditions.push('(o.project = ? OR o.merged_into_project = ?)');
      params.push(project, project);
    } else {
      conditions.push('o.project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }
    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY o.created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const rawResults = db.prepare(query).all(...params) as Observation[] | Promise<Observation[]>;
    const results = await resolveResults(rawResults);
    const result: PaginatedResult<Observation> = {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };

    return {
      ...result,
      items: result.items.map(obs => this.sanitizeObservation(obs))
    };
  }

  async getSummaries(offset: number, limit: number, project?: string, platformSource?: string): Promise<PaginatedResult<Summary>> {
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT
        ss.id,
        s.content_session_id as session_id,
        COALESCE(s.platform_source, 'claude') as platform_source,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.project,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    `;
    const params: any[] = [];

    const conditions: string[] = [];

    if (project) {
      conditions.push('(ss.project = ? OR ss.merged_into_project = ?)');
      params.push(project, project);
    } else {
      conditions.push('ss.project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }

    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY ss.created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const stmt = db.prepare(query);
    const rawResults = stmt.all(...params) as Summary[] | Promise<Summary[]>;
    const results = await resolveResults(rawResults);

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  async getPrompts(offset: number, limit: number, project?: string, platformSource?: string): Promise<PaginatedResult<UserPrompt>> {
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, 'claude') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
    `;
    const params: any[] = [];

    const conditions: string[] = [];

    if (project) {
      conditions.push('s.project = ?');
      params.push(project);
    } else {
      conditions.push('s.project != ?');
      params.push(OBSERVER_SESSIONS_PROJECT);
    }

    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }

    conditions.push(`
      NOT EXISTS (
        SELECT 1
        FROM user_prompts duplicate
        WHERE duplicate.session_db_id = up.session_db_id
          AND duplicate.prompt_text = up.prompt_text
          AND (
            duplicate.created_at_epoch > up.created_at_epoch
            OR (
              duplicate.created_at_epoch = up.created_at_epoch
              AND duplicate.id > up.id
            )
          )
          AND duplicate.created_at_epoch - up.created_at_epoch <= ?
      )
    `);
    params.push(USER_PROMPT_DEDUPE_WINDOW_MS);

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY up.created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const stmt = db.prepare(query);
    const rawResults = stmt.all(...params) as UserPrompt[] | Promise<UserPrompt[]>;
    const results = await resolveResults(rawResults);

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  private async paginate<T>(
    table: string,
    columns: string,
    offset: number,
    limit: number,
    project?: string
  ): Promise<PaginatedResult<T>> {
    const db = this.dbManager.getSessionStore().db;

    let query = `SELECT ${columns} FROM ${table}`;
    const params: any[] = [];

    if (project) {
      query += ' WHERE project = ?';
      params.push(project);
    }

    query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset); 

    const stmt = db.prepare(query);
    const rawResults = stmt.all(...params) as T[] | Promise<T[]>;
    const results = await resolveResults(rawResults);

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }
}
