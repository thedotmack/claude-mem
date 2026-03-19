/**
 * Logs Routes
 *
 * Handles fetching and clearing log files from ~/.claude-mem/logs/
 */

import express, { Request, Response } from 'express';
import { openSync, fstatSync, readSync, closeSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

/**
 * Read the last N lines from a file without loading the entire file into memory.
 * Reads backwards from the end of the file in chunks until enough lines are found.
 */
export function readLastLines(filePath: string, lineCount: number): { lines: string; totalEstimate: number } {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) {
      return { lines: '', totalEstimate: 0 };
    }

    // Start with a reasonable chunk size, expand if needed
    const INITIAL_CHUNK_SIZE = 64 * 1024; // 64KB
    const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB cap to prevent OOM on huge single-line files

    let readSize = Math.min(INITIAL_CHUNK_SIZE, fileSize);
    let content = '';
    let newlineCount = 0;

    while (readSize <= fileSize && readSize <= MAX_READ_SIZE) {
      const startPosition = Math.max(0, fileSize - readSize);
      const bytesToRead = fileSize - startPosition;
      const buffer = Buffer.alloc(bytesToRead);
      readSync(fd, buffer, 0, bytesToRead, startPosition);
      content = buffer.toString('utf-8');

      // Count newlines to see if we have enough
      newlineCount = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') newlineCount++;
      }

      // We need lineCount newlines to get lineCount full lines (trailing newline)
      if (newlineCount >= lineCount || startPosition === 0) {
        break;
      }

      // Double the read size for next attempt
      readSize = Math.min(readSize * 2, fileSize, MAX_READ_SIZE);
    }

    // Split and take the last N lines
    const allLines = content.split('\n');
    // Remove trailing empty element from final newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    const startIndex = Math.max(0, allLines.length - lineCount);
    const resultLines = allLines.slice(startIndex);

    // Estimate total lines: if we read the whole file, we know exactly; otherwise estimate
    let totalEstimate: number;
    if (fileSize <= readSize) {
      totalEstimate = allLines.length;
    } else {
      // Rough estimate based on average line length in the chunk we read
      const avgLineLength = content.length / Math.max(newlineCount, 1);
      totalEstimate = Math.round(fileSize / avgLineLength);
    }

    return {
      lines: resultLines.join('\n'),
      totalEstimate,
    };
  } finally {
    closeSync(fd);
  }
}

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
    app.get('/api/logs/live', this.handleGetLiveLogs.bind(this));
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

  /**
   * POST /api/logs/clear
   * Clears the current day's log file
   */
  /**
   * GET /api/logs/live
   * Returns recent lines from agent-specific live log files
   * Query params:
   *  - agent: 'claude-code' | 'codex' (required)
   *  - tail: number of lines (default: 200)
   */
  private handleGetLiveLogs = this.wrapHandler((req: Request, res: Response): void => {
    const agent = req.query.agent as string;
    if (!agent || !['claude-code', 'codex', 'claude-app'].includes(agent)) {
      res.status(400).json({ error: 'agent query param required (claude-code, codex, or claude-app)' });
      return;
    }

    const logsDir = this.getLogsDir();
    const logFile = join(logsDir, `${agent}-live.log`);
    const tail = Math.min(parseInt(req.query.tail as string || '200', 10), 2000);

    if (!existsSync(logFile)) {
      // Fall back to today's worker log filtered by agent
      const workerLog = this.getLogFilePath();
      if (!existsSync(workerLog)) {
        res.json({ lines: [], agent, exists: false });
        return;
      }
      const { lines: content } = readLastLines(workerLog, tail * 3);
      const filtered = content.split('\n')
        .filter(l => l.toLowerCase().includes(agent) || l.includes('[heartbeat]') || l.includes('[observation]'))
        .slice(-tail);
      res.json({ lines: filtered, agent, source: 'worker-log' });
      return;
    }

    const { lines: content } = readLastLines(logFile, tail);
    const lineArr = content.split('\n').filter(l => l.length > 0);
    res.json({ lines: lineArr, agent, source: 'live-log' });
  });

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
