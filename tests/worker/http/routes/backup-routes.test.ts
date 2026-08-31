
// Pro-backup plan Phase 2 verification for /api/backup/*: status answers
// {configured: false} when backups are disabled, run triggers a snapshot
// (409 when one is already in flight), list returns snapshots newest first,
// and restore rejects a missing confirm and path traversal. The restore
// success path ends in process.exit(0) (flushResponseThen self-recycle) and
// is deliberately NOT exercised in-process — assertions stop at the response.
// Harness copied from cloud-sync-routes.test.ts.

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../../../src/utils/logger.js';
import { BackupRoutes } from '../../../../src/services/worker/http/routes/BackupRoutes.js';
import type { BackupStatus } from '../../../../src/services/backup/BackupManager.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempRoot: string | undefined;

function createMockReqRes(path: string, body: unknown = {}): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { path, query: {}, body } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

type RouteFn = (req: Request, res: Response, next?: () => void) => void;

/**
 * Capture every registered handler chain (middleware + handler), keyed by
 * "METHOD path". validateBody registers as a leading chain element on the
 * POST routes, so invokeChain runs it for real.
 */
function buildChains(routes: BackupRoutes): Record<string, RouteFn[]> {
  const chains: Record<string, RouteFn[]> = {};
  const record = (method: string) =>
    mock((path: string, ...chain: RouteFn[]) => {
      chains[`${method} ${path}`] = chain;
    });
  const mockApp: any = {
    get: record('GET'),
    post: record('POST'),
    delete: mock(() => {}),
    use: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  return chains;
}

async function invokeChain(
  chain: RouteFn[],
  req: Partial<Request>,
  res: Partial<Response>,
  jsonSpy: ReturnType<typeof mock>,
): Promise<void> {
  expect(chain.length).toBeGreaterThan(0);
  for (let index = 0; index < chain.length; index++) {
    const fn = chain[index];
    if (index < chain.length - 1) {
      let nextCalled = false;
      fn(req as Request, res as Response, () => { nextCalled = true; });
      if (!nextCalled) break; // middleware rejected the request
    } else {
      fn(req as Request, res as Response);
    }
  }
  for (let index = 0; index < 100 && jsonSpy.mock.calls.length === 0; index++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

describe('BackupRoutes', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
    if (tempRoot) {
      try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
    tempRoot = undefined;
  });

  describe('GET /api/backup/status', () => {
    it('returns {configured: false} with 200 (not 500) when backups are disabled', async () => {
      const mockDbManager = { getBackupManager: () => null };
      const chains = buildChains(new BackupRoutes(mockDbManager as any));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/status');
      await invokeChain(chains['GET /api/backup/status'], req, res, jsonSpy);

      expect(jsonSpy).toHaveBeenCalledTimes(1);
      expect(jsonSpy).toHaveBeenCalledWith({ configured: false });
      expect(statusSpy).not.toHaveBeenCalled(); // no error status set
    });

    it('returns BackupManager.status() when configured', async () => {
      const status: BackupStatus = {
        configured: true,
        lastSnapshotAt: 1751990400000,
        lastSnapshotBytes: 4096,
        snapshotCount: 3,
        lastError: null,
        nextRunAt: 1752076800000,
      };
      const mockDbManager = { getBackupManager: () => ({ status: () => status }) };
      const chains = buildChains(new BackupRoutes(mockDbManager as any));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/status');
      await invokeChain(chains['GET /api/backup/status'], req, res, jsonSpy);

      expect(jsonSpy).toHaveBeenCalledWith(status);
      expect(statusSpy).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/backup/run', () => {
    it('triggers a snapshot and returns the result', async () => {
      const snapshot = { path: '/tmp/claude-mem-x.db', bytes: 4096, createdAt: 1751990400000, method: 'vacuum-into' };
      const runNow = mock(async () => snapshot);
      const mockDbManager = { getBackupManager: () => ({ runNow }) };
      const chains = buildChains(new BackupRoutes(mockDbManager as any));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/run');
      await invokeChain(chains['POST /api/backup/run'], req, res, jsonSpy);

      expect(runNow).toHaveBeenCalledTimes(1);
      expect(jsonSpy).toHaveBeenCalledWith({ success: true, snapshot });
      expect(statusSpy).not.toHaveBeenCalled();
    });

    it('returns 409 when a snapshot is already running (single-flight guard)', async () => {
      const runNow = mock(async () => null);
      const mockDbManager = { getBackupManager: () => ({ runNow }) };
      const chains = buildChains(new BackupRoutes(mockDbManager as any));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/run');
      await invokeChain(chains['POST /api/backup/run'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(409);
      expect(jsonSpy).toHaveBeenCalledWith({ error: 'A snapshot is already running' });
    });

    it('returns 400 when backups are not enabled', async () => {
      const mockDbManager = { getBackupManager: () => null };
      const chains = buildChains(new BackupRoutes(mockDbManager as any));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/run');
      await invokeChain(chains['POST /api/backup/run'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /api/backup/list', () => {
    it('lists snapshots newest first with name, bytes, and mtime', async () => {
      tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-routes-'));
      const older = 'claude-mem-2026-01-01T00-00-00-000Z.db';
      const middle = 'claude-mem-2026-02-01T00-00-00-000Z.db';
      const newest = 'claude-mem-2026-03-01T00-00-00-000Z.db';
      // Write out of order; also drop a non-snapshot file that must be ignored.
      for (const name of [middle, newest, older]) {
        writeFileSync(join(tempRoot, name), 'snapshot-bytes');
        utimesSync(join(tempRoot, name), new Date(), new Date());
      }
      writeFileSync(join(tempRoot, 'notes.txt'), 'not a snapshot');

      const mockDbManager = { getBackupManager: () => null };
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: tempRoot }));

      const { req, res, jsonSpy } = createMockReqRes('/api/backup/list');
      await invokeChain(chains['GET /api/backup/list'], req, res, jsonSpy);

      const payload = (jsonSpy.mock.calls[0] as unknown[])[0] as { snapshots: Array<{ name: string; bytes: number; mtime: number }> };
      expect(payload.snapshots.map(s => s.name)).toEqual([newest, middle, older]);
      for (const snapshot of payload.snapshots) {
        expect(snapshot.bytes).toBeGreaterThan(0);
        expect(snapshot.mtime).toBeGreaterThan(0);
      }
    });

    it('returns an empty list when the backups dir does not exist', async () => {
      const mockDbManager = { getBackupManager: () => null };
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: join(tmpdir(), 'claude-mem-does-not-exist') }));

      const { req, res, jsonSpy } = createMockReqRes('/api/backup/list');
      await invokeChain(chains['GET /api/backup/list'], req, res, jsonSpy);

      const payload = (jsonSpy.mock.calls[0] as unknown[])[0] as { snapshots: unknown[] };
      expect(payload.snapshots).toEqual([]);
    });
  });

  describe('POST /api/backup/restore', () => {
    it('rejects a body without confirm: true (validateBody 400)', async () => {
      const close = mock(async () => {});
      const mockDbManager = { getBackupManager: () => null, close };
      tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-routes-'));
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: tempRoot }));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/restore', { file: 'claude-mem-x.db' });
      await invokeChain(chains['POST /api/backup/restore'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(400);
      const payload = (jsonSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(payload.error).toBe('ValidationError');
      expect(close).not.toHaveBeenCalled();
    });

    it('rejects path traversal (../../etc/passwd) before touching anything', async () => {
      const close = mock(async () => {});
      const mockDbManager = { getBackupManager: () => null, close };
      tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-routes-'));
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: tempRoot }));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/restore', {
        file: '../../etc/passwd',
        confirm: true,
      });
      await invokeChain(chains['POST /api/backup/restore'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(400);
      const payload = (jsonSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(String(payload.error)).toContain('backups directory');
      expect(close).not.toHaveBeenCalled();
    });

    it('rejects an absolute path outside the backups dir', async () => {
      const close = mock(async () => {});
      const mockDbManager = { getBackupManager: () => null, close };
      tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-routes-'));
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: tempRoot }));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/restore', {
        file: '/etc/passwd',
        confirm: true,
      });
      await invokeChain(chains['POST /api/backup/restore'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(close).not.toHaveBeenCalled();
    });

    it('returns 404 for a well-formed file that does not exist', async () => {
      const close = mock(async () => {});
      const mockDbManager = { getBackupManager: () => null, close };
      tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-routes-'));
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: tempRoot }));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/restore', {
        file: 'claude-mem-2026-01-01T00-00-00-000Z.db',
        confirm: true,
      });
      await invokeChain(chains['POST /api/backup/restore'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(404);
      expect(close).not.toHaveBeenCalled();
    });

    it('rejects files that are not listed backup snapshots', async () => {
      const close = mock(async () => {});
      const mockDbManager = { getBackupManager: () => null, close };
      tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-routes-'));
      writeFileSync(join(tempRoot, 'notes.txt'), 'not a sqlite snapshot');
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: tempRoot }));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/restore', {
        file: 'notes.txt',
        confirm: true,
      });
      await invokeChain(chains['POST /api/backup/restore'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(close).not.toHaveBeenCalled();
    });

    it('rejects a snapshot-named symlink instead of following it', async () => {
      if (process.platform === 'win32') return;
      const close = mock(async () => {});
      const mockDbManager = { getBackupManager: () => null, close };
      tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-routes-'));
      const target = join(tempRoot, 'notes.txt');
      writeFileSync(target, 'not a snapshot');
      symlinkSync(target, join(tempRoot, 'claude-mem-2026-01-01T00-00-00-000Z.db'));
      const chains = buildChains(new BackupRoutes(mockDbManager as any, { backupsDir: tempRoot }));

      const { req, res, jsonSpy, statusSpy } = createMockReqRes('/api/backup/restore', {
        file: 'claude-mem-2026-01-01T00-00-00-000Z.db',
        confirm: true,
      });
      await invokeChain(chains['POST /api/backup/restore'], req, res, jsonSpy);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(close).not.toHaveBeenCalled();
    });
  });
});
