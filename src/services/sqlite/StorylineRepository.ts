/**
 * StorylineRepository: Database operations for Storyline content ingestion
 *
 * Provides CRUD operations for storyline_runs and storyline_files tables.
 * Follows the same pattern as SessionStore — receives a Database instance
 * and exposes synchronous methods for SQLite operations.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export interface StorylineRunRecord {
  run_id: string;
  project: string;
  goal: string;
  mode_config: string;
  status: string;
  total_files: number;
  files_processed: number;
  observations_generated: number;
  started_at: number;
  completed_at: number | null;
  error_message: string | null;
}

export interface StorylineFileRecord {
  file_path: string;
  content_hash: string;
  status: string;
  error_message: string | null;
  observations_count: number;
}

export class StorylineRepository {
  constructor(private db: Database) {}

  /**
   * Create a new Storyline ingestion run
   */
  createStorylineRun(run: {
    run_id: string;
    project: string;
    goal: string;
    mode_config: string;
    total_files: number;
    started_at: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO storyline_runs (run_id, project, goal, mode_config, total_files, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.run_id,
      run.project,
      run.goal,
      run.mode_config,
      run.total_files,
      run.started_at
    );
    logger.info('STORYLINE_DB', 'Created storyline run', {
      run_id: run.run_id,
      project: run.project,
      total_files: run.total_files,
    });
  }

  /**
   * Batch insert files for a run
   */
  createStorylineFiles(
    runId: string,
    files: Array<{ path: string; content_hash: string }>
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO storyline_files (run_id, file_path, content_hash)
      VALUES (?, ?, ?)
    `);

    const insertAll = this.db.transaction(() => {
      for (const file of files) {
        stmt.run(runId, file.path, file.content_hash);
      }
    });

    insertAll();
    logger.info('STORYLINE_DB', 'Created storyline files', {
      run_id: runId,
      file_count: files.length,
    });
  }

  /**
   * Update a file's processing status
   */
  updateFileStatus(
    runId: string,
    filePath: string,
    status: string,
    observationsCount?: number,
    errorMessage?: string
  ): void {
    const setClauses = ['status = ?'];
    const params: (string | number)[] = [status];

    if (observationsCount !== undefined) {
      setClauses.push('observations_count = ?');
      params.push(observationsCount);
    }

    if (errorMessage !== undefined) {
      setClauses.push('error_message = ?');
      params.push(errorMessage);
    }

    params.push(runId, filePath);

    const sql = `UPDATE storyline_files SET ${setClauses.join(', ')} WHERE run_id = ? AND file_path = ?`;
    this.db.prepare(sql).run(...params);
  }

  /**
   * Update run progress counters
   */
  updateRunProgress(
    runId: string,
    filesProcessed: number,
    observationsGenerated: number
  ): void {
    this.db.prepare(`
      UPDATE storyline_runs
      SET files_processed = ?, observations_generated = ?
      WHERE run_id = ?
    `).run(filesProcessed, observationsGenerated, runId);
  }

  /**
   * Update run status (completed, cancelled, error)
   */
  updateRunStatus(
    runId: string,
    status: string,
    completedAt?: number,
    errorMessage?: string
  ): void {
    const setClauses = ['status = ?'];
    const params: (string | number)[] = [status];

    if (completedAt !== undefined) {
      setClauses.push('completed_at = ?');
      params.push(completedAt);
    }

    if (errorMessage !== undefined) {
      setClauses.push('error_message = ?');
      params.push(errorMessage);
    }

    params.push(runId);

    const sql = `UPDATE storyline_runs SET ${setClauses.join(', ')} WHERE run_id = ?`;
    this.db.prepare(sql).run(...params);
  }

  /**
   * Get full run status including file details
   */
  getStorylineRunStatus(runId: string): {
    run: StorylineRunRecord;
    files: StorylineFileRecord[];
  } | null {
    const run = this.db.prepare(`
      SELECT run_id, project, goal, mode_config, status, total_files,
             files_processed, observations_generated, started_at,
             completed_at, error_message
      FROM storyline_runs
      WHERE run_id = ?
    `).get(runId) as StorylineRunRecord | null;

    if (!run) return null;

    const files = this.db.prepare(`
      SELECT file_path, content_hash, status, error_message, observations_count
      FROM storyline_files
      WHERE run_id = ?
    `).all(runId) as StorylineFileRecord[];

    return { run, files };
  }

  /**
   * Get content hashes of all completed files for a project (for dedup across runs)
   */
  getProcessedHashes(project: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT sf.content_hash
      FROM storyline_files sf
      JOIN storyline_runs sr ON sf.run_id = sr.run_id
      WHERE sr.project = ? AND sf.status = 'completed'
    `).all(project) as Array<{ content_hash: string }>;

    return new Set(rows.map(r => r.content_hash));
  }
}
