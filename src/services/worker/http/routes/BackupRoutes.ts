/**
 * Backup Routes
 *
 * Exposes Litestream cloud backup status and restore endpoints.
 * GET  /api/backup/status  - Current replication status
 * POST /api/backup/restore - Restore DB from cloud replica
 */

import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { LitestreamManager } from '../../../backup/LitestreamManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class BackupRoutes extends BaseRouteHandler {
  private litestreamManager: LitestreamManager;

  constructor(litestreamManager: LitestreamManager) {
    super();
    this.litestreamManager = litestreamManager;
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/backup/status', this.handleGetStatus.bind(this));
    app.post('/api/backup/restore', this.handleRestore.bind(this));
  }

  /**
   * GET /api/backup/status
   * Returns current backup replication status.
   */
  private handleGetStatus = this.wrapHandler((req: Request, res: Response): void => {
    const status = this.litestreamManager.getStatus();
    res.json(status);
  });

  /**
   * POST /api/backup/restore
   * Restores the database from the latest cloud replica.
   * Body (optional): { targetPath: string } - defaults to the main DB path
   */
  private handleRestore = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { targetPath } = req.body || {};

    logger.info('BACKUP', 'Restore requested', { targetPath });

    const result = await this.litestreamManager.restore(targetPath);

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, error: result.message });
    }
  });
}
