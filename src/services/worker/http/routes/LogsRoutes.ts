
import express, { Request, Response } from 'express';
import { openSync, fstatSync, readSync, closeSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../../../utils/logger.js';
import { paths } from '../../../../shared/paths.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';

export function readLastLines(filePath: string, lineCount: number): { lines: string; totalEstimate: number } {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) {
      return { lines: '', totalEstimate: 0 };
    }

    const INITIAL_CHUNK_SIZE = 64 * 1024; 
    const MAX_READ_SIZE = 10 * 1024 * 1024; 

    let readSize = Math.min(INITIAL_CHUNK_SIZE, fileSize);
    let content = '';
    let newlineCount = 0;

    while (readSize <= fileSize && readSize <= MAX_READ_SIZE) {
      const startPosition = Math.max(0, fileSize - readSize);
      const bytesToRead = fileSize - startPosition;
      const buffer = Buffer.alloc(bytesToRead);
      readSync(fd, buffer, 0, bytesToRead, startPosition);
      content = buffer.toString('utf-8');

      newlineCount = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') newlineCount++;
      }

      // A trailing newline terminates the last line; it is not the boundary
      // before the first requested line when the chunk starts mid-line.
      const requiredNewlines = lineCount + (content.endsWith('\n') ? 1 : 0);
      if (newlineCount >= requiredNewlines || startPosition === 0 || readSize === MAX_READ_SIZE) {
        break;
      }

      readSize = Math.min(readSize * 2, fileSize, MAX_READ_SIZE);
    }

    const allLines = content.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    const startIndex = Math.max(0, allLines.length - lineCount);
    const resultLines = allLines.slice(startIndex);

    let totalEstimate: number;
    if (fileSize <= readSize) {
      totalEstimate = allLines.length;
    } else {
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
