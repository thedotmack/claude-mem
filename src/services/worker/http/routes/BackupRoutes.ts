
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { flushResponseThen } from '../../../server/flushResponseThen.js';
import { swapDatabaseFromSnapshot } from '../../../backup/restore-swap.js';
import { DB_PATH, paths } from '../../../../shared/paths.js';
import { SNAPSHOT_FILE_PATTERN } from '../../../backup/BackupManager.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

const runBackupSchema = z.object({
  uploadNow: z.boolean().optional(),
}).passthrough();

const restoreSchema = z.object({
  file: z.string().min(1),
  confirm: z.literal(true),
});

/** Test seam: snapshot/DB locations default to the shared data dir. */
export interface BackupRoutesOptions {
  backupsDir?: string;
  dbPath?: string;
}

/**
 * Local backup endpoints (pro-backup plan Phase 2).
 *
 * Registered unconditionally (CloudSyncRoutes pattern): a disabled install
 * (CLAUDE_MEM_BACKUP_ENABLED !== 'true' → getBackupManager() returns null)
 * still answers 200 with `{configured: false}` on status, and list/restore
 * keep working against whatever snapshots exist on disk.
 *
 * GET  /api/backup/status  - BackupManager status or {configured: false}
 * POST /api/backup/run     - one snapshot + retention cycle now (409 if busy)
 * GET  /api/backup/list    - snapshot files on disk, newest first
 * POST /api/backup/restore - replace claude-mem.db from a snapshot, then
 *                            self-recycle (flushResponseThen → process.exit(0),
 *                            same idiom as POST /api/admin/restart) so the
 *                            supervisor restarts the worker on the restored DB.
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
    app.post('/api/backup/run', validateBody(runBackupSchema), this.handleRun.bind(this));
    app.get('/api/backup/list', this.handleList.bind(this));
    app.post('/api/backup/restore', validateBody(restoreSchema), this.handleRestore.bind(this));
  }

  private backupsDir(): string {
    return path.resolve(this.options.backupsDir ?? paths.backups());
  }

  private dbPath(): string {
    return this.options.dbPath ?? DB_PATH;
  }

  private handleGetStatus = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const backupManager = this.dbManager.getBackupManager();
    if (!backupManager) {
      logger.debug('BACKUP', 'Status requested but backups are not enabled');
      res.json({ configured: false });
      return;
    }
    res.json(backupManager.status());
  });

  private handleRun = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
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

  private handleRestore = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { file } = req.body as z.infer<typeof restoreSchema>;

    // Path-traversal guard: the requested file must resolve to a path INSIDE
    // the backups dir (resolve + prefix check), so `../../etc/passwd` or an
    // absolute path outside the dir is rejected before any fs action.
    const backupsDir = this.backupsDir();
    const snapshotPath = path.resolve(backupsDir, file);
    if (!snapshotPath.startsWith(backupsDir + path.sep)) {
      res.status(400).json({ error: 'Invalid file: must be a snapshot inside the backups directory' });
      return;
    }
    if (!existsSync(snapshotPath)) {
      this.notFound(res, `Snapshot not found: ${path.basename(snapshotPath)}`);
      return;
    }

    const dbPath = this.dbPath();
    logger.info('BACKUP', 'Restore requested', { snapshot: snapshotPath });

    // Same self-recycle idiom as POST /api/admin/restart: flush the response,
    // then swap the DB and process.exit(0) so the supervisor restarts the
    // worker on the restored database.
    flushResponseThen(
      res,
      { success: true, restoring: path.basename(snapshotPath), status: 'restarting' },
      async () => {
        try {
          // Close the live DB cleanly BEFORE touching files so the WAL is
          // checkpointed and the pre-restore copy is complete.
          await this.dbManager.close();

          const { preRestoreCopy } = swapDatabaseFromSnapshot(dbPath, snapshotPath);
          logger.info('BACKUP', 'Restore complete; exiting for supervisor restart', {
            snapshot: snapshotPath,
            preRestoreCopy,
          });
        } catch (error) {
          // flushResponseThen's finally exits the process either way; log so
          // a failed swap is diagnosable after the restart.
          const normalized = error instanceof Error ? error : new Error(String(error));
          logger.error('BACKUP', 'Restore failed while swapping database files', { snapshot: snapshotPath }, normalized);
        }
      },
    );
  });
}
