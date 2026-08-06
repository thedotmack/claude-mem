import express, { Request, Response } from 'express';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { paths } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { RouteHandler } from '../../../server/Server.js';
import { requireLocalhost } from '../middleware.js';
import { flushResponseThen } from '../../../server/flushResponseThen.js';
import { stagePendingSwap } from '../../../infrastructure/PendingSwap.js';

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
    // requireLocalhost on all three: export streams the `.env` (ANTHROPIC_API_KEY
    // et al) to the caller, and both import routes grant full db/.env overwrite
    // plus a forced restart. These are strictly more powerful than
    // /api/admin/restart|shutdown|doctor, which are already localhost-gated.
    app.get('/api/backup/export', requireLocalhost, this.handleExport.bind(this));
    app.post(
      '/api/backup/import',
      requireLocalhost,
      express.raw({ type: 'application/zip', limit: '50mb' }),
      this.handleImport.bind(this)
    );
    app.post(
      '/api/backup/import/file',
      requireLocalhost,
      express.raw({ type: 'application/octet-stream', limit: '5mb' }),
      this.handleImportFile.bind(this)
    );
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

  private handleImport = this.wrapHandler((req: Request, res: Response): void => {
    let zip: AdmZip;
    try {
      zip = new AdmZip(req.body as Buffer);
    } catch {
      res.status(400).json({ error: 'not a valid zip file' });
      return;
    }

    const matched = zip.getEntries().filter(entry =>
      (BACKUP_ALLOWLIST as readonly string[]).includes(path.basename(entry.entryName))
    );

    if (matched.length === 0) {
      res.status(400).json({ error: "zip doesn't contain a recognized claude-mem backup file" });
      return;
    }

    this.backupExistingFiles(matched.map(e => path.basename(e.entryName)));

    for (const entry of matched) {
      const basename = path.basename(entry.entryName);
      stagePendingSwap(basename, entry.getData());
    }

    logger.info('SYSTEM', 'Backup import staged, triggering restart', {
      staged: matched.map(e => path.basename(e.entryName)),
    });

    // Same contract as /api/admin/restart: defer the restart until the response
    // is provably flushed (res 'finish'). Firing it inline would let
    // performGracefulShutdown's closeAllConnections() race the still-in-flight
    // response socket, so the UI would see a failed fetch for a restore that
    // actually succeeded.
    flushResponseThen(
      res,
      { success: true, staged: matched.map(e => path.basename(e.entryName)) },
      () => this.restartWorker()
    );
  });

  private handleImportFile = this.wrapHandler((req: Request, res: Response): void => {
    const name = this.toStringParam(req.query.name as string | string[] | undefined);

    if (name !== 'settings.json' && name !== '.env') {
      res.status(400).json({ error: 'name must be "settings.json" or ".env"' });
      return;
    }

    const body = req.body as Buffer;

    if (name === 'settings.json') {
      try {
        JSON.parse(body.toString('utf-8'));
      } catch {
        res.status(400).json({ error: 'settings.json content is not valid JSON' });
        return;
      }
    }

    const targetPath = name === 'settings.json' ? paths.settings() : paths.envFile();
    writeFileSync(targetPath, body, name === '.env' ? { mode: 0o600 } : undefined);
    if (name === '.env') {
      // `mode` only applies on create — an existing `.env` keeps its old mode,
      // so re-assert 0600 to match EnvManager.saveEnvFile()'s guarantee.
      chmodSync(targetPath, 0o600);
    }

    logger.info('SYSTEM', 'Standalone file import written', { name });
    res.json({ success: true, name });
  });

  private backupExistingFiles(basenames: string[]): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(paths.dataDir(), 'backups', `backup-restore-${timestamp}`);
    let createdDir = false;

    for (const basename of basenames) {
      const sourcePath = pathForBasename(basename);
      if (!existsSync(sourcePath)) continue;
      if (!createdDir) {
        mkdirSync(backupDir, { recursive: true });
        createdDir = true;
      }
      copyFileSync(sourcePath, path.join(backupDir, basename));
    }
  }
}
