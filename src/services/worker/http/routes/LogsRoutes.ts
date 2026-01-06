/**
 * Logs Routes
 *
 * Handles fetching and clearing log files from ~/.claude-mem/logs/
 */

import express, { Request, Response } from 'express';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class LogsRoutes extends BaseRouteHandler {
  private getLogFilePath(): string {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const logsDir = join(dataDir, 'logs');
    const date = new Date().toISOString().split('T')[0];
    return join(logsDir, `claude-mem-${date}.log`);
  }

  private getLogsDir(): string {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    return join(dataDir, 'logs');
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/logs', this.handleGetLogs.bind(this));
    app.post('/api/logs/clear', this.handleClearLogs.bind(this));
  }

  /**
   * GET /api/logs
   * Returns the current day's log file contents
   * Query params:
   *  - lines: number of lines to return (default: 1000, max: 10000)
   */
  private handleGetLogs = this.wrapHandler((req: Request, res: Response): void => {
    const logFilePath = this.getLogFilePath();

    if (!existsSync(logFilePath)) {
      res.json({
        logs: '',
        path: logFilePath,
        exists: false
      });
      return;
    }

    const requestedLines = parseInt(req.query.lines as string || '1000', 10);
    const maxLines = Math.min(requestedLines, 10000); // Cap at 10k lines

    const content = readFileSync(logFilePath, 'utf-8');
    const lines = content.split('\n');

    // Return the last N lines
    const startIndex = Math.max(0, lines.length - maxLines);
    const recentLines = lines.slice(startIndex).join('\n');

    res.json({
      logs: recentLines,
      path: logFilePath,
      exists: true,
      totalLines: lines.length,
      returnedLines: lines.length - startIndex
    });
  });

  /**
   * POST /api/logs/clear
   * Clears the current day's log file
   */
  private handleClearLogs = this.wrapHandler((req: Request, res: Response): void => {
    const logFilePath = this.getLogFilePath();

    if (!existsSync(logFilePath)) {
      res.json({
        success: true,
        message: 'Log file does not exist',
        path: logFilePath
      });
      return;
    }

    // Clear the log file by writing empty string
    writeFileSync(logFilePath, '', 'utf-8');

    logger.info('SYSTEM', 'Log file cleared via UI', { path: logFilePath });

    res.json({
      success: true,
      message: 'Log file cleared',
      path: logFilePath
    });
  });
}
