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
      'id, session_db_id, claude_session_id, project, type, title, subtitle, text, concepts, files, prompt_number, created_at, created_at_epoch',
      offset,
      limit,
      project
    );
  }

  /**
   * Get paginated summaries
   */
  getSummaries(offset: number, limit: number, project?: string): PaginatedResult<Summary> {
    return this.paginate<Summary>(
      'summaries',
      'id, session_db_id, claude_session_id, project, request, completion, summary, learnings, notes, created_at, created_at_epoch',
      offset,
      limit,
      project
    );
  }

  /**
   * Get paginated user prompts
   */
  getPrompts(offset: number, limit: number, project?: string): PaginatedResult<UserPrompt> {
    return this.paginate<UserPrompt>(
      'user_prompts',
      'id, session_db_id, claude_session_id, project, prompt, created_at, created_at_epoch',
      offset,
      limit,
      project
    );
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
