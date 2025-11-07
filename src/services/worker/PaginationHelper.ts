/**
 * PaginationHelper: DRY pagination utility
 *
 * Responsibility:
 * - DRY helper for paginated queries
 * - Eliminates copy-paste across observations/summaries/prompts endpoints
 * - Efficient LIMIT+1 trick to avoid COUNT(*) query
 */

import { DatabaseManager } from './DatabaseManager.js';
import type { PaginatedResult, Observation, Summary, UserPrompt } from '../worker-types.js';

export class PaginationHelper {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Get paginated observations
   */
  getObservations(offset: number, limit: number, project?: string): PaginatedResult<Observation> {
    return this.paginate<Observation>(
      'observations',
      'id, sdk_session_id, project, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch',
      offset,
      limit,
      project
    );
  }

  /**
   * Get paginated summaries
   */
  getSummaries(offset: number, limit: number, project?: string): PaginatedResult<Summary> {
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT
        ss.id,
        s.claude_session_id as session_id,
        ss.request,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.project,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      JOIN sdk_sessions s ON ss.sdk_session_id = s.sdk_session_id
    `;
    const params: any[] = [];

    if (project) {
      query += ' WHERE ss.project = ?';
      params.push(project);
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
  getPrompts(offset: number, limit: number, project?: string): PaginatedResult<UserPrompt> {
    const db = this.dbManager.getSessionStore().db;

    let query = `
      SELECT up.id, up.claude_session_id, s.project, up.prompt_number, up.prompt_text, up.created_at, up.created_at_epoch
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
    `;
    const params: any[] = [];

    if (project) {
      query += ' WHERE s.project = ?';
      params.push(project);
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
