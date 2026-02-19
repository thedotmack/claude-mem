/**
 * PaginationHelper: DRY pagination utility
 *
 * Responsibility:
 * - DRY helper for paginated queries
 * - Eliminates copy-paste across observations/summaries/prompts endpoints
 * - Efficient LIMIT+1 trick to avoid COUNT(*) query
 */

import type { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
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
    const marker = `/${projectName}/`;
    const index = filePath.indexOf(marker);

    if (index !== -1) {
      // Strip everything before and including the project name
      return filePath.substring(index + marker.length);
    }

    // Fallback: return original path if project name not found
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
      logger.debug('WORKER', 'File paths is plain string, using as-is', {}, err as Error);
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
   * Compute the time window for a summary: (previousSummaryEpoch, thisSummaryEpoch].
   * Returns { epochAfter, epochBefore } where epochAfter is exclusive lower bound
   * and epochBefore is inclusive upper bound.
   */
  private getSummaryTimeWindow(summaryId: number): { memorySessionId: string; epochAfter: number; epochBefore: number } | null {
    const db = this.dbManager.getSessionStore().db;
    const summary = db.prepare(
      'SELECT memory_session_id, created_at_epoch FROM session_summaries WHERE id = ?'
    ).get(summaryId) as { memory_session_id: string; created_at_epoch: number } | undefined;

    if (!summary) return null;

    const prevSummary = db.prepare(
      `SELECT MAX(created_at_epoch) as epoch FROM session_summaries
       WHERE memory_session_id = ? AND created_at_epoch < ?`
    ).get(summary.memory_session_id, summary.created_at_epoch) as { epoch: number | null } | undefined;

    return {
      memorySessionId: summary.memory_session_id,
      epochAfter: prevSummary?.epoch ?? 0,
      epochBefore: summary.created_at_epoch,
    };
  }

  /**
   * Find the epoch of the latest summary for a session, resolving both
   * content_session_id and memory_session_id.
   * Returns 0 if no summaries exist for the session.
   */
  private getLatestSummaryEpoch(sessionId: string): number {
    const db = this.dbManager.getSessionStore().db;
    const row = db.prepare(`
      SELECT MAX(ss.created_at_epoch) as epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      WHERE s.content_session_id = ? OR ss.memory_session_id = ?
    `).get(sessionId, sessionId) as { epoch: number | null } | undefined;
    return row?.epoch ?? 0;
  }

  /**
   * Get paginated observations
   */
  getObservations(offset: number, limit: number, project?: string, sessionId?: string, summaryId?: number, unsummarized?: boolean): PaginatedResult<Observation> {
    const db = this.dbManager.getSessionStore().db;

    // When summaryId is provided, scope to that summary's time window
    if (summaryId) {
      const window = this.getSummaryTimeWindow(summaryId);
      if (!window) {
        return { items: [], hasMore: false, offset, limit };
      }

      let query = `
        SELECT o.id, o.memory_session_id, o.project, o.type, o.title, o.subtitle,
               o.narrative, o.text, o.facts, o.concepts, o.files_read, o.files_modified,
               o.prompt_number, o.created_at, o.created_at_epoch
        FROM observations o
        WHERE o.memory_session_id = ?
          AND o.created_at_epoch > ?
          AND o.created_at_epoch <= ?
      `;
      const params: (string | number)[] = [window.memorySessionId, window.epochAfter, window.epochBefore];

      if (project) {
        query += ' AND o.project = ?';
        params.push(project);
      }

      query += ' ORDER BY o.created_at_epoch DESC LIMIT ? OFFSET ?';
      params.push(limit + 1, offset);

      const results = db.prepare(query).all(...params) as Observation[];

      return {
        items: results.slice(0, limit).map(obs => this.sanitizeObservation(obs)),
        hasMore: results.length > limit,
        offset,
        limit
      };
    }

    if (sessionId) {
      // Match by content_session_id (via sdk_sessions JOIN) OR by memory_session_id directly.
      // Active/in-progress sessions pass memory_session_id, while summarized sessions
      // pass content_session_id — LEFT JOIN + OR handles both cases.
      let query = `
        SELECT o.id, o.memory_session_id, o.project, o.type, o.title, o.subtitle,
               o.narrative, o.text, o.facts, o.concepts, o.files_read, o.files_modified,
               o.prompt_number, o.created_at, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      `;
      const params: (string | number)[] = [];
      const conditions: string[] = ['(s.content_session_id = ? OR o.memory_session_id = ?)'];
      params.push(sessionId, sessionId);

      // When unsummarized=true, scope to observations after the latest summary
      if (unsummarized) {
        const afterEpoch = this.getLatestSummaryEpoch(sessionId);
        if (afterEpoch > 0) {
          conditions.push('o.created_at_epoch > ?');
          params.push(afterEpoch);
        }
      }

      if (project) {
        conditions.push('o.project = ?');
        params.push(project);
      }

      query += ` WHERE ${conditions.join(' AND ')}`;
      query += ' ORDER BY o.created_at_epoch DESC LIMIT ? OFFSET ?';
      params.push(limit + 1, offset);

      const results = db.prepare(query).all(...params) as Observation[];

      return {
        items: results.slice(0, limit).map(obs => this.sanitizeObservation(obs)),
        hasMore: results.length > limit,
        offset,
        limit
      };
    }

    const result = this.paginate<Observation>(
      'observations',
      'id, memory_session_id, project, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch',
      offset,
      limit,
      project
    );

    return {
      ...result,
      items: result.items.map(obs => this.sanitizeObservation(obs))
    };
  }

  /**
   * Get paginated summaries
   */
  getSummaries(offset: number, limit: number, project?: string, sessionId?: string): PaginatedResult<Summary> {
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT
        ss.id,
        s.content_session_id as session_id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.project,
        ss.created_at,
        ss.created_at_epoch,
        (SELECT COUNT(*) FROM observations o
         WHERE o.memory_session_id = ss.memory_session_id
           AND o.created_at_epoch <= ss.created_at_epoch
           AND o.created_at_epoch > COALESCE(
             (SELECT MAX(ss2.created_at_epoch)
              FROM session_summaries ss2
              WHERE ss2.memory_session_id = ss.memory_session_id
                AND ss2.created_at_epoch < ss.created_at_epoch),
             0
           )
        ) as observation_count
      FROM session_summaries ss
      JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    `;
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (project) {
      conditions.push('ss.project = ?');
      params.push(project);
    }
    if (sessionId) {
      // Match by content_session_id OR memory_session_id — sessions loaded via
      // the search API carry memory_session_id, while sessions from the summaries
      // API carry content_session_id.  This mirrors getObservations/getPrompts.
      conditions.push('(s.content_session_id = ? OR ss.memory_session_id = ?)');
      params.push(sessionId, sessionId);
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
  getPrompts(offset: number, limit: number, project?: string, sessionId?: string, summaryId?: number, unsummarized?: boolean): PaginatedResult<UserPrompt> {
    const db = this.dbManager.getSessionStore().db;

    // When summaryId is provided, scope prompts to that summary's time window
    if (summaryId) {
      const window = this.getSummaryTimeWindow(summaryId);
      if (!window) {
        return { items: [], hasMore: false, offset, limit };
      }

      let query = `
        SELECT up.id, up.content_session_id, s.project, up.prompt_number, up.prompt_text, up.created_at, up.created_at_epoch
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        WHERE s.memory_session_id = ?
          AND up.created_at_epoch > ?
          AND up.created_at_epoch <= ?
      `;
      const params: (string | number)[] = [window.memorySessionId, window.epochAfter, window.epochBefore];

      if (project) {
        query += ' AND s.project = ?';
        params.push(project);
      }

      query += ' ORDER BY up.created_at_epoch DESC LIMIT ? OFFSET ?';
      params.push(limit + 1, offset);

      const results = db.prepare(query).all(...params) as UserPrompt[];

      return {
        items: results.slice(0, limit),
        hasMore: results.length > limit,
        offset,
        limit
      };
    }

    // LEFT JOIN so prompts from active sessions (where sdk_sessions may reference
    // by memory_session_id) are still returned.  The OR handles both
    // content_session_id and memory_session_id lookups.
    let query = `
      SELECT up.id, up.content_session_id, s.project, up.prompt_number, up.prompt_text, up.created_at, up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    `;
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (project) {
      conditions.push('s.project = ?');
      params.push(project);
    }
    if (sessionId) {
      conditions.push('(up.content_session_id = ? OR s.memory_session_id = ?)');
      params.push(sessionId, sessionId);

      // When unsummarized=true, scope to prompts after the latest summary
      if (unsummarized) {
        const afterEpoch = this.getLatestSummaryEpoch(sessionId);
        if (afterEpoch > 0) {
          conditions.push('up.created_at_epoch > ?');
          params.push(afterEpoch);
        }
      }
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY up.created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);

    const results = db.prepare(query).all(...params) as UserPrompt[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }

  /** Allowed table names for pagination queries */
  private static readonly ALLOWED_TABLES = ['observations', 'session_summaries', 'user_prompts'];

  /**
   * Generic pagination implementation (DRY)
   */
  private paginate<T>(
    table: string,
    columns: string,
    offset: number,
    limit: number,
    project?: string,
    extraFilter?: { column: string; value: string }
  ): PaginatedResult<T> {
    if (!PaginationHelper.ALLOWED_TABLES.includes(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }

    const db = this.dbManager.getSessionStore().db;

    let query = `SELECT ${columns} FROM ${table}`;
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (project) {
      conditions.push('project = ?');
      params.push(project);
    }
    if (extraFilter) {
      conditions.push(`${extraFilter.column} = ?`);
      params.push(extraFilter.value);
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
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
