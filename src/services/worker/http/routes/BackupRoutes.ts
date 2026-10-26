import express, { Request, Response } from 'express';
import path from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { paths } from '../../../../shared/paths.js';
import { SNAPSHOT_FILE_PATTERN, readLastRestoreResult } from '../../../backup/snapshot-files.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';

/** Test seam: snapshot and restore-result locations default to the data dir. */
export interface BackupRoutesOptions {
  backupsDir?: string;
  lastRestorePath?: string;
}

/**
 * Local backup endpoints.
 *
 * Registered unconditionally (CloudSyncRoutes pattern): a disabled install
 * (CLAUDE_MEM_BACKUP_ENABLED !== 'true', so getBackupManager() is null) still
 * answers status with `{configured: false}`, and list works against whatever
 * snapshots exist on disk.
 *
 * GET  /api/backup/status - BackupManager status (or {configured: false}),
 *                           plus the outcome of the last restore
 * POST /api/backup/run    - one snapshot + retention cycle now (409 if busy)
 * GET  /api/backup/list   - snapshot files on disk, newest first
 *
 * There is no restore endpoint: `npx claude-mem restore` stages the restore
 * and restarts the worker, and the next worker applies it before it opens
 * the database (restore-swap.ts applyPendingRestore).
 */
export class BackupRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private options: BackupRoutesOptions = {},
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/backup/status', this.handleGetStatus.bind(this));
    app.post('/api/backup/run', this.handleRun.bind(this));
    app.get('/api/backup/list', this.handleList.bind(this));
  }

  private backupsDir(): string {
    return path.resolve(this.options.backupsDir ?? paths.backups());
  }

  private handleGetStatus = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const lastRestore = readLastRestoreResult(this.options.lastRestorePath);
    const backupManager = this.dbManager.getBackupManager();
    if (!backupManager) {
      logger.debug('BACKUP', 'Status requested but backups are not enabled');
      res.json({ configured: false, lastRestore });
      return;
    }
    res.json({ ...backupManager.status(), lastRestore });
  });

  private handleRun = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // A snapshot writes a full database copy to disk: refuse it from other
    // localhost pages, as settings writes are. Origin-less clients (the CLI,
    // curl) keep the loopback-trust model.
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Backup runs from a different localhost origin are not allowed' });
      return;
    }
    const backupManager = this.dbManager.getBackupManager();
    if (!backupManager) {
      res.status(400).json({ error: 'Backups are not enabled (set CLAUDE_MEM_BACKUP_ENABLED to "true" and restart the worker)' });
      return;
    }
    const snapshot = await backupManager.runNow();
    if (snapshot === null) {
      res.status(409).json({ error: 'A snapshot is already running' });
      return;
    }
    res.json({ success: true, snapshot });
  });

  private handleList = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const backupsDir = this.backupsDir();
    if (!existsSync(backupsDir)) {
      res.json({ backupsDir, snapshots: [] });
      return;
    }
    const snapshots = readdirSync(backupsDir)
      .filter(name => SNAPSHOT_FILE_PATTERN.test(name))
      .sort()
      .reverse() // sanitized ISO filenames: lexicographic order is timestamp order
      .map(name => {
        const stats = statSync(path.join(backupsDir, name));
        return { name, bytes: stats.size, mtime: stats.mtimeMs };
      });
    res.json({ backupsDir, snapshots });
  });
}
