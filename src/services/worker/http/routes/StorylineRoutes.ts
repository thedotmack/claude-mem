/**
 * Storyline Routes
 *
 * Handles Storyline content ingestion lifecycle:
 * POST /api/storyline/run    — Start a content ingestion run
 * GET  /api/storyline/status  — Poll ingestion progress
 * POST /api/storyline/cancel  — Cancel an active ingestion run
 */

import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { ContentIngestionRunner } from '../../ContentIngestionRunner.js';
import { StorylineRepository } from '../../../../services/sqlite/StorylineRepository.js';

export class StorylineRoutes extends BaseRouteHandler {
  private activeRunners: Map<string, ContentIngestionRunner> = new Map();

  constructor(
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/storyline/run', this.handleRun.bind(this));
    app.get('/api/storyline/status', this.handleStatus.bind(this));
    app.post('/api/storyline/cancel', this.handleCancel.bind(this));
  }

  /**
   * Start a content ingestion run
   * POST /api/storyline/run
   * Body: { inbox_path, goal, mode_config, project, files }
   */
  private handleRun = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (!this.validateRequired(req, res, ['inbox_path', 'goal', 'mode_config', 'project', 'files'])) {
      return;
    }

    const { inbox_path, goal, mode_config, project, files } = req.body;

    logger.info('HTTP', '→ POST /api/storyline/run', {
      inbox_path,
      goal: goal.substring(0, 100),
      project,
      file_count: files.length,
    });

    const runner = new ContentIngestionRunner(
      this.dbManager,
      this.sessionManager,
      project,
      goal,
      mode_config,
      files,
      inbox_path
    );

    const runId = await runner.startRun();
    this.activeRunners.set(runId, runner);

    // Fire-and-forget: process files in background, clean up runner when done
    runner.processFiles().catch((error) => {
      logger.error('STORYLINE', 'Content ingestion run failed', { run_id: runId }, error as Error);
    }).finally(() => {
      this.activeRunners.delete(runId);
    });

    res.json({
      run_id: runId,
      status: 'running',
      total_files: files.length,
    });
  });

  /**
   * Get ingestion run status
   * GET /api/storyline/status?run_id=<id>
   */
  private handleStatus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const runId = req.query.run_id as string;

    if (!runId) {
      this.badRequest(res, 'Missing run_id query parameter');
      return;
    }

    // Check active runners first (has live current_file info)
    const activeRunner = this.activeRunners.get(runId);
    if (activeRunner) {
      const status = await activeRunner.getStatus();
      res.json(status);
      return;
    }

    // Fall back to SQLite for completed/cancelled runs
    const sessionStore = this.dbManager.getSessionStore();
    const repo = new StorylineRepository(sessionStore.db);
    const result = repo.getStorylineRunStatus(runId);

    if (!result) {
      this.notFound(res, `Run ${runId} not found`);
      return;
    }

    res.json({
      run: {
        run_id: result.run.run_id,
        status: result.run.status,
        goal: result.run.goal,
        total_files: result.run.total_files,
        files_processed: result.run.files_processed,
        observations_generated: result.run.observations_generated,
        current_file: null,
        started_at: result.run.started_at,
        completed_at: result.run.completed_at,
        error_message: result.run.error_message,
      },
      files: result.files.map(f => ({
        file_path: f.file_path,
        status: f.status,
        observations_count: f.observations_count,
        error_message: f.error_message,
      })),
    });
  });

  /**
   * Cancel an active ingestion run
   * POST /api/storyline/cancel
   * Body: { run_id }
   */
  private handleCancel = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (!this.validateRequired(req, res, ['run_id'])) {
      return;
    }

    const { run_id } = req.body;

    const runner = this.activeRunners.get(run_id);
    if (!runner) {
      this.notFound(res, `No active run found for run_id: ${run_id}`);
      return;
    }

    logger.info('HTTP', '→ POST /api/storyline/cancel', { run_id });

    await runner.cancel();

    res.json({
      run_id,
      status: 'cancelled',
    });
  });
}
