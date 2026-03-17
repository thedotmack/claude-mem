/**
 * Endless Mode Routes
 *
 * Handles endless mode task lifecycle: starting runs and checking status.
 * POST /api/endless/run — Start an endless mode task
 * GET /api/endless/status — Get current task status
 */

import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { EndlessRunner } from '../../EndlessRunner.js';

export class EndlessRoutes extends BaseRouteHandler {
  constructor(
    private endlessRunner: EndlessRunner
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/endless/run', this.handleRun.bind(this));
    app.get('/api/endless/status', this.handleStatus.bind(this));
  }

  /**
   * Start an endless mode task
   * POST /api/endless/run
   * Body: { task: string, project: string, cwd: string }
   */
  private handleRun = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { task, project, cwd } = req.body;

    if (!this.validateRequired(req, res, ['task', 'project', 'cwd'])) {
      return;
    }

    logger.info('HTTP', '→ POST /api/endless/run', {
      task: task.substring(0, 100),
      project,
      cwd,
    });

    // Start the run in the background — don't block the HTTP response
    // The caller polls GET /api/endless/status for progress
    this.endlessRunner.run(task, project, cwd).catch((error) => {
      logger.error('ENDLESS', 'Endless run failed', {}, error as Error);
    });

    res.json({
      status: 'started',
      taskId: this.endlessRunner.getTaskState()?.taskId,
    });
  });

  /**
   * Get current endless mode task status
   * GET /api/endless/status
   */
  private handleStatus = this.wrapHandler((req: Request, res: Response): void => {
    const state = this.endlessRunner.getTaskState();

    if (!state) {
      res.json({ status: 'idle', task: null });
      return;
    }

    res.json(state);
  });
}
