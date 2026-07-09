
import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

/**
 * Cloud sync status endpoint (cmem.ai Pro).
 *
 * Registered unconditionally: an unconfigured install (no token/user id →
 * DatabaseManager.getCloudSync() returns null) still answers 200 with
 * `{configured: false}` so callers (the /cloud-sync skill, dashboards) can
 * distinguish "not set up" from "worker down" without special-casing a 404/500.
 */
export class CloudSyncRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/sync/status', this.handleGetStatus.bind(this));
  }

  private handleGetStatus = this.wrapHandler((_req: Request, res: Response): void => {
    // CloudSync.status() carries counts and metadata only — never the token.
    const status = this.dbManager.getCloudSync()?.status();
    if (!status) {
      logger.debug('CLOUD_SYNC', 'Status requested but cloud sync is not configured');
    }
    res.json(status ?? { configured: false });
  });
}
