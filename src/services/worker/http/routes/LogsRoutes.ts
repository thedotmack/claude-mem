
import express, { Request, Response } from 'express';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../../utils/logger.js';
import { paths } from '../../../../shared/paths.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { readLastLines } from '../../../../utils/log-tail.js';

export { readLastLines };

export class LogsRoutes extends BaseRouteHandler {
  // Same directory the logger writes to (src/utils/logger.ts).
  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return join(paths.logsDir(), `claude-mem-${date}.log`);
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/logs', this.handleGetLogs.bind(this));
    app.post('/api/logs/clear', this.handleClearLogs.bind(this));
  }

  private handleGetLogs = this.wrapHandler((req: Request, res: Response): void => {
    const rawLines = req.query.lines;
    const requestedLines = rawLines === undefined ? 1000
      : typeof rawLines === 'string' && /^\d+$/.test(rawLines) ? Number(rawLines) : NaN;
    if (!Number.isSafeInteger(requestedLines) || requestedLines < 0) {
      this.badRequest(res, 'lines must be a nonnegative safe integer');
      return;
    }

    const logFilePath = this.getLogFilePath();

    if (!existsSync(logFilePath)) {
      res.json({
        logs: '',
        path: logFilePath,
        exists: false
      });
      return;
    }

    const maxLines = Math.min(requestedLines, 10000); 

    const { lines: recentLines, totalEstimate } = readLastLines(logFilePath, maxLines);
    const returnedLines = recentLines === '' ? 0 : recentLines.split('\n').length;

    res.json({
      logs: recentLines,
      path: logFilePath,
      exists: true,
      totalLines: totalEstimate,
      returnedLines,
    });
  });

  private handleClearLogs = this.wrapHandler((req: Request, res: Response): void => {
    // Clearing logs is a destructive local action, so other localhost pages
    // may not trigger it (same rule as memory/save and the DELETE guard).
    // Origin-less clients (CLI, curl, the viewer's own origin) keep working.
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Log clears from a different localhost origin are not allowed' });
      return;
    }
    const logFilePath = this.getLogFilePath();

    if (!existsSync(logFilePath)) {
      res.json({
        success: true,
        message: 'Log file does not exist',
        path: logFilePath
      });
      return;
    }

    writeFileSync(logFilePath, '', 'utf-8');

    logger.info('SYSTEM', 'Log file cleared via UI', { path: logFilePath });

    res.json({
      success: true,
      message: 'Log file cleared',
      path: logFilePath
    });
  });
}
