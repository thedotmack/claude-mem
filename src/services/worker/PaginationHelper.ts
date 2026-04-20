/**
 * PaginationHelper: DRY pagination utility
 *
 * Responsibility:
 * - DRY helper for paginated queries
 * - Eliminates copy-paste across observations/summaries/prompts endpoints
 * - Efficient LIMIT+1 trick to avoid COUNT(*) query
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import type { PaginatedResult, Observation, Summary, UserPrompt } from '../worker-types.js';

export class PaginationHelper {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Strip project path from file paths using heuristic
   * Converts "/Users/user/project/src/file.ts" -> "src/file.ts"
   * Uses first occurrence of project name from left (project root)
   */
  private stripProjectPath(filePath: string, projectName: string): string {
    // Composite names ("parent/worktree") don't appear in on-disk paths for
    // standard git worktrees — only the checkout basename does. Match on the
    // leaf segment so the heuristic works regardless of worktree layout.
    const leaf = projectName.includes('/') ? projectName.split('/').pop()! : projectName;
    const marker = `/${leaf}/`;
    const index = filePath.indexOf(marker);

    if (index !== -1) {
      return filePath.substring(index + marker.length);
    }

    return filePath;
  }

  /**
   * Strip project path from JSON array of file paths
   */
  private stripProjectPaths(filePathsStr: string | null, projectName: string): string | null {
    if (!filePathsStr) return filePathsStr;

    try {
      // Parse JSON array
      const paths = JSON.parse(filePathsStr) as string[];

      // Strip project path from each file
      const strippedPaths = paths.map(p => this.stripProjectPath(p, projectName));

      // Return as JSON string
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

  /**
   * Sanitize observation by stripping project paths from files
   */
  private sanitizeObservation(obs: Observation): Observation {
    return {
      ...obs,
      files_read: this.stripProjectPaths(obs.files_read, obs.project),
      files_modified: this.stripProjectPaths(obs.files_modified, obs.project)
    };
  }

  /**
   * Get paginated observations
   */
  getObservations(offset: number, limit: number, project?: string, platformSource?: string): PaginatedResult<Observation> {
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
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (project) {
      // Include adopted merged-worktree rows so the parent project's view
      // surfaces observations that originated under its merged children.
      conditions.push('(o.project = ? OR o.merged_into_project = ?)');
      params.push(project, project);
    } else {
      // Hide internal observer-session rows from the unfiltered UI list.
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

    const results = db.prepare(query).all(...params) as Observation[];
    const result: PaginatedResult<Observation> = {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };

    // Strip project paths from file paths before returning
    return {
      ...result,
      items: result.items.map(obs => this.sanitizeObservation(obs))
    };
  }

  /**
   * Get paginated summaries
   */
  getSummaries(offset: number, limit: number, project?: string, platformSource?: string): PaginatedResult<Summary> {
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
      // Include adopted merged-worktree summaries so the parent project's view
      // surfaces rows that originated under its merged children.
      conditions.push('(ss.project = ? OR ss.merged_into_project = ?)');
      params.push(project, project);
    } else {
      // Hide internal observer-session rows from the unfiltered UI list.
      conditions.push("ss.project != 'observer-sessions'");
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
    const results = stmt.all(...params) as Summary[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  /**
   * Get paginated user prompts
   */
  getPrompts(offset: number, limit: number, project?: string, platformSource?: string): PaginatedResult<UserPrompt> {
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
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    `;
    const params: any[] = [];

    const conditions: string[] = [];

    if (project) {
      conditions.push('s.project = ?');
      params.push(project);
    } else {
      // Hide internal observer-session rows from the unfiltered UI list.
      conditions.push("s.project != 'observer-sessions'");
    }

    if (platformSource) {
      conditions.push(`COALESCE(s.platform_source, 'claude') = ?`);
      params.push(platformSource);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY up.created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const stmt = db.prepare(query);
    const results = stmt.all(...params) as UserPrompt[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  /**
   * Generic pagination implementation (DRY)
   */
  private paginate<T>(
    table: string,
    columns: string,
    offset: number,
    limit: number,
    project?: string
  ): PaginatedResult<T> {
    const db = this.dbManager.getSessionStore().db;

    let query = `SELECT ${columns} FROM ${table}`;
    const params: any[] = [];

    if (project) {
      query += ' WHERE project = ?';
      params.push(project);
    }

    query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset); // Fetch one extra to check hasMore

    const stmt = db.prepare(query);
    const results = stmt.all(...params) as T[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }
}
