
import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { isRemoteModeActive } from '../../../../shared/remote-mode.js';

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

  private handleGetStatus = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const cloudSync = this.dbManager.getCloudSync();
    // Surfaced so the remote-mode skill (and dashboards) can tell "remote
    // creds present but sync failed to configure" from "not a remote setup".
    // Status is a rare, human-driven route — the settings read per call is fine.
    const remoteMode = isRemoteModeActive(
      SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)
    );
    if (!cloudSync) {
      logger.debug('CLOUD_SYNC', 'Status requested but cloud sync is not configured');
      res.json({ configured: false, remoteMode });
      return;
    }
    // Always performs an authenticated, read-only SyncHub status GET. An
    // empty local queue alone is not evidence that the connection works.
    res.json({ ...(await cloudSync.statusWithHubProbe()), remoteMode });
  });
}
