import express, { Request, Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import AdmZip from 'adm-zip';
import { paths } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { RouteHandler } from '../../../server/Server.js';

export const BACKUP_ALLOWLIST = [
  'claude-mem.db',
  'claude-mem.db-shm',
  'claude-mem.db-wal',
  'settings.json',
  '.env',
] as const;

function pathForBasename(basename: string): string {
  const dbPath = paths.database();
  switch (basename) {
    case 'claude-mem.db': return dbPath;
    case 'claude-mem.db-shm': return `${dbPath}-shm`;
    case 'claude-mem.db-wal': return `${dbPath}-wal`;
    case 'settings.json': return paths.settings();
    case '.env': return paths.envFile();
    default: throw new Error(`pathForBasename: unmapped basename "${basename}"`);
  }
}

export class BackupRoutes extends BaseRouteHandler implements RouteHandler {
  constructor(private restartWorker: () => Promise<void>) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/backup/export', this.handleExport.bind(this));
  }

  private handleExport = this.wrapHandler((_req: Request, res: Response): void => {
    const zip = new AdmZip();

    for (const basename of BACKUP_ALLOWLIST) {
      const filePath = pathForBasename(basename);
      if (!existsSync(filePath)) continue;
      zip.addFile(basename, readFileSync(filePath));
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `claude-mem-backup-${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zip.toBuffer());

    logger.info('SYSTEM', 'Backup export downloaded', { filename });
  });
}
