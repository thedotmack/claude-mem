/**
 * Search Service - Search observations in the database
 */

import { spawnSync } from 'child_process';
import { paths } from '../utils/paths';

export interface SearchOptions {
  query: string;
  project?: string;
  type?: string;
  limit?: number;
  since?: string;
  until?: string;
}

export interface ObservationResult {
  id: number;
  sessionId: string;
  project: string;
  type: string;
  text: string;
  createdAt: string;
}

export class SearchService {
  private dbPath = paths.database;

  /**
   * Search observations
   */
  search(options: SearchOptions): ObservationResult[] {
    const { query, project, type, limit = 10 } = options;

    let sql = `
      SELECT 
        o.id,
        o.memory_session_id as sessionId,
        o.project,
        o.type,
        COALESCE(o.text, o.title, o.narrative) as text,
        o.created_at as createdAt
      FROM observations o
      WHERE (
        o.text LIKE '%${query}%' OR
        o.title LIKE '%${query}%' OR
        o.narrative LIKE '%${query}%'
      )
    `;

    if (project) {
      sql += ` AND o.project = '${project}'`;
    }

    if (type) {
      sql += ` AND o.type = '${type}'`;
    }

    sql += ` ORDER BY o.created_at_epoch DESC LIMIT ${limit};`;

    const result = this.query(sql);
    if (!result) return [];

    return this.parseResults(result);
  }

  /**
   * Get recent observations
   */
  getRecent(limit = 10): ObservationResult[] {
    const sql = `
      SELECT 
        o.id,
        o.memory_session_id as sessionId,
        o.project,
        o.type,
        COALESCE(o.text, o.title, o.narrative) as text,
        o.created_at as createdAt
      FROM observations o
      ORDER BY o.created_at_epoch DESC
      LIMIT ${limit};
    `;

    const result = this.query(sql);
    return result ? this.parseResults(result) : [];
  }

  /**
   * Get projects list
   */
  getProjects(): string[] {
    const sql = `SELECT DISTINCT project FROM sdk_sessions ORDER BY project;`;
    const result = this.query(sql);
    return result ? result.split('\n').filter(p => p.trim()) : [];
  }

  /**
   * Get observation types
   */
  getTypes(): string[] {
    const sql = `SELECT DISTINCT type FROM observations ORDER BY type;`;
    const result = this.query(sql);
    return result ? result.split('\n').filter(t => t.trim()) : [];
  }

  private parseResults(result: string): ObservationResult[] {
    return result.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.split('|');
        return {
          id: parseInt(parts[0]?.trim() || '0', 10),
          sessionId: parts[1]?.trim() || '',
          project: parts[2]?.trim() || '',
          type: parts[3]?.trim() || '',
          text: parts[4]?.trim() || '',
          createdAt: parts[5]?.trim() || ''
        };
      });
  }

  private query(sql: string): string | null {
    try {
      const result = spawnSync('sqlite3', [this.dbPath, sql], {
        encoding: 'utf-8',
        timeout: 10000
      });
      return result.status === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  }
}

export const searchService = new SearchService();
