
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { importWorkspacePrompts } from '../../../prompt-import/workspace-sync.js';
import { requireWorkViewOrigin, workViewLoopbackOnly } from './WorkViewRoutes.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import type { ViewerSyncService } from '../../../sync/ViewerSyncService.js';

/**
 * Cloud sync status endpoint (cmem.ai Pro).
 *
 * Registered unconditionally: an unconfigured install (no token/user id →
 * DatabaseManager.getCloudSync() returns null) still answers 200 with
 * `{configured: false}` so callers (the /cloud-sync skill, dashboards) can
 * distinguish "not set up" from "worker down" without special-casing a 404/500.
 */
export class CloudSyncRoutes extends BaseRouteHandler {
  private importing: { workspace: string; account: string; result: ReturnType<typeof importWorkspacePrompts> } | null = null;

  constructor(private dbManager: DatabaseManager, private viewerSync?: Pick<ViewerSyncService, 'statusWithProbe'>) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/sync/status', this.handleGetStatus.bind(this));
    app.post('/api/sync/setup/import-prompts', workViewLoopbackOnly, requireWorkViewOrigin, this.importPrompts);
  }

  private importPrompts = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const input = z.object({ workspace: z.string().min(1).max(4096), expectedAccount: z.string().uuid() }).strict().safeParse(req.body);
    if (!input.success) {
      this.badRequest(res, 'An absolute workspace path and the approved Cloud Sync account ID are required.');
      return;
    }
    const sync = this.dbManager.getCloudSync();
    const plan = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true }).CLAUDE_MEM_PRO_PLAN;
    if (!sync || !['cloud_sync', 'pro', 'trial'].includes(plan)) {
      res.status(409).json({ error: 'Pair this device with a personal Cloud Sync account first.' });
      return;
    }
    const { workspace, expectedAccount } = input.data;
    if (this.importing && (this.importing.workspace !== workspace || this.importing.account !== expectedAccount)) {
      res.status(409).json({ error: 'Another workspace is importing. Retry after it finishes.' });
      return;
    }
    const result = this.importing?.result ?? importWorkspacePrompts(workspace, expectedAccount, this.dbManager.getSessionStore(), sync);
    this.importing = { workspace, account: expectedAccount, result };
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await result);
    } finally {
      if (this.importing?.result === result) this.importing = null;
    }
  });

  private handleGetStatus = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const cloudSync = this.dbManager.getCloudSync();
    if (!cloudSync) {
      logger.debug('CLOUD_SYNC', 'Status requested but cloud sync is not configured');
      res.json({ configured: false });
      return;
    }
    // Always performs an authenticated, read-only SyncHub status GET. An
    // empty local queue alone is not evidence that the connection works.
    res.setHeader('Cache-Control', 'no-store');
    res.json(this.viewerSync ? await this.viewerSync.statusWithProbe() : await cloudSync.statusWithHubProbe());
  });
}
