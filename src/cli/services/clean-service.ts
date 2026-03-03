/**
 * Clean Service - Clean up old data
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { paths } from '../utils/paths';
import { logService } from './log-service';

export interface CleanOptions {
  sessions?: number;    // Days
  observations?: number; // Days
  logs?: number;        // Days
  failed?: boolean;     // Clean failed observations
  dryRun?: boolean;
}

export interface CleanResult {
  cleaned: boolean;
  sessionsDeleted?: number;
  observationsDeleted?: number;
  logsDeleted?: number;
  spaceFreed?: number;
  errors: string[];
}

export class CleanService {
  private dbPath = paths.database;

  /**
   * Analyze what can be cleaned
   */
  analyze(options: CleanOptions = {}): { 
    sessions: number; 
    observations: number; 
    logs: number;
    spaceEstimate: number;
  } {
    const result = { sessions: 0, observations: 0, logs: 0, spaceEstimate: 0 };

    if (!existsSync(this.dbPath)) return result;

    // Count old sessions
    if (options.sessions) {
      const since = Date.now() - (options.sessions * 24 * 60 * 60 * 1000);
      const count = this.query(`SELECT COUNT(*) FROM sdk_sessions WHERE started_at_epoch < ${since};`);
      result.sessions = parseInt(count?.trim() || '0', 10);
    }

    // Count old observations
    if (options.observations) {
      const since = Date.now() - (options.observations * 24 * 60 * 60 * 1000);
      const count = this.query(`SELECT COUNT(*) FROM observations WHERE created_at_epoch < ${since};`);
      result.observations = parseInt(count?.trim() || '0', 10);
    }

    // Count old logs
    if (options.logs) {
      const logFiles = logService.getLogFiles();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - options.logs);

      for (const file of logFiles) {
        const fileDate = new Date(file.date);
        if (fileDate < cutoff) {
          result.logs++;
          result.spaceEstimate += file.size;
        }
      }
    }

    return result;
  }

  /**
   * Clean data
   */
  clean(options: CleanOptions): CleanResult {
    const result: CleanResult = { cleaned: false, errors: [] };

    if (options.dryRun) {
      return result;
    }

    // Clean old sessions
    if (options.sessions) {
      const since = Date.now() - (options.sessions * 24 * 60 * 60 * 1000);
      const before = this.query('SELECT COUNT(*) FROM sdk_sessions;');
      
      this.query(`DELETE FROM sdk_sessions WHERE started_at_epoch < ${since};`);
      
      const after = this.query('SELECT COUNT(*) FROM sdk_sessions;');
      result.sessionsDeleted = parseInt(before?.trim() || '0', 10) - parseInt(after?.trim() || '0', 10);
    }

    // Clean old observations
    if (options.observations) {
      const since = Date.now() - (options.observations * 24 * 60 * 60 * 1000);
      const before = this.query('SELECT COUNT(*) FROM observations;');
      
      this.query(`DELETE FROM observations WHERE created_at_epoch < ${since};`);
      
      const after = this.query('SELECT COUNT(*) FROM observations;');
      result.observationsDeleted = parseInt(before?.trim() || '0', 10) - parseInt(after?.trim() || '0', 10);
    }

    // Clean old logs
    if (options.logs) {
      const cleanResult = logService.cleanOldLogs(options.logs);
      result.logsDeleted = cleanResult.deleted;
      result.spaceFreed = cleanResult.freed;
    }

    // Clean failed observations
    if (options.failed) {
      this.query(`DELETE FROM pending_messages WHERE status = 'failed';`);
    }

    // Vacuum database to reclaim space
    this.query('VACUUM;');

    result.cleaned = true;
    return result;
  }

  private query(sql: string): string | null {
    try {
      const result = spawnSync('sqlite3', [this.dbPath, sql], {
        encoding: 'utf-8',
        timeout: 30000
      });
      return result.status === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  }
}

export const cleanService = new CleanService();
