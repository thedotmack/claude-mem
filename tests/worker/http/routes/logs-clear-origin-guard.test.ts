import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LogsRoutes } from '../../../../src/services/worker/http/routes/LogsRoutes.js';

function createMockRes(): {
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureClearLogsHandler(routes: LogsRoutes): (req: Request, res: Response) => void {
  let handler!: (req: Request, res: Response) => void;
  const mockApp: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/logs/clear') {
        handler = handlers[handlers.length - 1];
      }
    }),
  };
  routes.setupRoutes(mockApp);
  return (req: Request, res: Response): void => handler(req, res);
}

/**
 * The pass-through cases run the real registered handler, which ends in
 * writeFileSync. Point getLogFilePath at a file in a fresh temporary directory
 * so no run — including one against a working installation where
 * CLAUDE_MEM_DATA_DIR is already set — can truncate the developer's daily log
 * (tests/preload.ts only defaults that variable when it is unset).
 */
function withIsolatedLog(run: (routes: LogsRoutes, logFile: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'logs-clear-origin-guard-'));
  const logFile = join(dir, 'claude-mem-test.log');
  try {
    const routes = new LogsRoutes();
    (routes as unknown as { getLogFilePath: () => string }).getLogFilePath = () => logFile;
    run(routes, logFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('POST /api/logs/clear origin guard', () => {
  it('rejects a clear from a different localhost origin without touching the log', () => {
    withIsolatedLog((routes, logFile) => {
      writeFileSync(logFile, 'existing log line\n', 'utf-8');
      const handler = captureClearLogsHandler(routes);

      const { res, statusSpy, jsonSpy } = createMockRes();
      handler({
        headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' },
      } as unknown as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(403);
      expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('origin'),
      }));
      expect(readFileSync(logFile, 'utf-8')).toBe('existing log line\n');
    });
  });

  it('allows an Origin-less clear and a same-port browser clear', () => {
    withIsolatedLog((routes, logFile) => {
      const handler = captureClearLogsHandler(routes);

      writeFileSync(logFile, 'first line\n', 'utf-8');
      const originless = createMockRes();
      handler({ headers: {} } as unknown as Request, originless.res as Response);
      expect(originless.statusSpy).not.toHaveBeenCalled();
      expect(originless.jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, message: 'Log file cleared' }));
      expect(readFileSync(logFile, 'utf-8')).toBe('');

      writeFileSync(logFile, 'second line\n', 'utf-8');
      const samePort = createMockRes();
      handler({
        headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' },
      } as unknown as Request, samePort.res as Response);
      expect(samePort.statusSpy).not.toHaveBeenCalled();
      expect(samePort.jsonSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true, message: 'Log file cleared' }));
      expect(readFileSync(logFile, 'utf-8')).toBe('');
    });
  });
});