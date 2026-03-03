/**
 * Stats Service - Gather statistics from the database
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { paths } from '../utils/paths';

export interface DatabaseStats {
  observations: number;
  sessions: number;
  summaries: number;
  databaseSize: number;
}

export interface ActivityStats {
  totalSessions: number;
  totalObservations: number;
  avgObservationsPerSession: number;
  firstSessionDate?: string;
}

export interface TopProject {
  name: string;
  sessions: number;
  observations: number;
}

export class StatsService {
  private dbPath = paths.database;

  /**
   * Check if database is accessible
   */
  isDatabaseAccessible(): boolean {
    return existsSync(this.dbPath);
  }

  /**
   * Get basic database stats
   */
  getDatabaseStats(): DatabaseStats | null {
    if (!this.isDatabaseAccessible()) return null;

    try {
      const obsResult = this.query('SELECT COUNT(*) FROM observations;');
      const sessResult = this.query('SELECT COUNT(*) FROM sdk_sessions;');
      const sumResult = this.query('SELECT COUNT(*) FROM session_summaries;');
      
      const { statSync } = require('fs');
      const stats = statSync(this.dbPath);

      return {
        observations: parseInt(obsResult?.trim() || '0', 10),
        sessions: parseInt(sessResult?.trim() || '0', 10),
        summaries: parseInt(sumResult?.trim() || '0', 10),
        databaseSize: stats.size
      };
    } catch {
      return null;
    }
  }

  /**
   * Get activity stats (last 30 days)
   */
  getActivityStats(days = 30): ActivityStats | null {
    if (!this.isDatabaseAccessible()) return null;

    try {
      const since = Date.now() - (days * 24 * 60 * 60 * 1000);
      
      const sessionsResult = this.query(`
        SELECT COUNT(*) FROM sdk_sessions 
        WHERE started_at_epoch > ${since};
      `);
      
      const obsResult = this.query(`
        SELECT COUNT(*) FROM observations 
        WHERE created_at_epoch > ${since};
      `);

      const firstSession = this.query(`
        SELECT started_at FROM sdk_sessions 
        ORDER BY started_at_epoch ASC LIMIT 1;
      `);

      const totalSessions = parseInt(sessionsResult?.trim() || '0', 10);
      const totalObservations = parseInt(obsResult?.trim() || '0', 10);

      return {
        totalSessions,
        totalObservations,
        avgObservationsPerSession: totalSessions > 0 ? Math.round(totalObservations / totalSessions) : 0,
        firstSessionDate: firstSession?.trim()
      };
    } catch {
      return null;
    }
  }

  /**
   * Get top projects by activity
   */
  getTopProjects(limit = 5): TopProject[] | null {
    if (!this.isDatabaseAccessible()) return null;

    try {
      const result = this.query(`
        SELECT 
          project,
          COUNT(DISTINCT s.id) as sessions,
          COUNT(o.id) as observations
        FROM sdk_sessions s
        LEFT JOIN observations o ON s.memory_session_id = o.memory_session_id
        GROUP BY project
        ORDER BY observations DESC
        LIMIT ${limit};
      `);

      if (!result) return [];

      return result.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split('|');
          return {
            name: parts[0]?.trim() || '',
            sessions: parseInt(parts[1]?.trim() || '0', 10),
            observations: parseInt(parts[2]?.trim() || '0', 10)
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Get observation types distribution
   */
  getObservationTypes(): { type: string; count: number }[] | null {
    if (!this.isDatabaseAccessible()) return null;

    try {
      const result = this.query(`
        SELECT type, COUNT(*) as count 
        FROM observations 
        GROUP BY type 
        ORDER BY count DESC;
      `);

      if (!result) return [];

      return result.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split('|');
          return {
            type: parts[0]?.trim() || '',
            count: parseInt(parts[1]?.trim() || '0', 10)
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Execute SQLite query
   */
  private query(sql: string): string | null {
    try {
      const result = spawnSync('sqlite3', [this.dbPath, sql], {
        encoding: 'utf-8',
        timeout: 5000
      });
      return result.status === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  }
}

export const statsService = new StatsService();
