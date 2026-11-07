import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Server as HttpServer } from 'node:http';
import { WorkerService } from '../../src/services/worker-service.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { DB_PATH } from '../../src/shared/paths.js';
import * as preflight from '../../src/services/worker/dependency-preflight.js';
import * as provisioning from '../../src/services/worker/tree-sitter-cli-provisioning.js';
import * as restore from '../../src/services/backup/restore-swap.js';
import * as processManager from '../../src/services/infrastructure/ProcessManager.js';
import * as cleanup from '../../src/services/infrastructure/CleanupV12_4_3.js';
import * as fts from '../../src/services/infrastructure/FtsMaintenance.js';
import * as adoption from '../../src/services/infrastructure/WorktreeAdoption.js';
import * as graceful from '../../src/services/infrastructure/GracefulShutdown.js';
import { logger } from '../../src/utils/logger.js';

// tests/preload.ts sets CLAUDE_MEM_DATA_DIR before these modules load. All
// database connections below use that disposable directory, never user data.
let worker: any;
let http: HttpServer | undefined;
let origin: string;
let reads: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;

beforeEach(async () => {
  const settings = { ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_CHROMA_ENABLED: 'false' };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(settings);
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  errors = spyOn(logger, 'error').mockImplementation(() => {});
  // Seed an empty, real SQLite schema so the pre-init read is observable even
  // on machines where a clean read-only/read-write pair does not cause IOERR.
  const seed = new DatabaseManager();
  await seed.initialize();
  await seed.close();
  spyOn(WorkerService.prototype as any, 'registerSignalHandlers').mockImplementation(() => {});
  spyOn(preflight, 'runWorkerDependencyPreflight').mockReturnValue({ degraded: false, statuses: [] } as any);
  spyOn(provisioning, 'provisionTreeSitterCliForPluginRoot').mockResolvedValue('no-package');
  spyOn(restore, 'applyPendingRestore').mockResolvedValue(undefined as any);
  spyOn(processManager, 'runOneTimeCwdRemap').mockImplementation(() => {});
  spyOn(cleanup, 'runOneTimeV12_4_3Cleanup').mockImplementation(() => {});
  spyOn(fts, 'scheduleOneTimeFtsBloatReclaim').mockImplementation(() => {});
  spyOn(adoption, 'adoptMergedWorktreesForAllKnownRepos').mockResolvedValue([]);
  // Keep real refresh database reads and timers, but never launch a paid agent.
  spyOn(AutoRefreshWorker.prototype, 'run').mockResolvedValue('idle');
  reads = spyOn(AutoRefreshWorker.prototype, 'readNeeds');
  worker = new WorkerService();
  spyOn(worker, 'startHookSpoolDrain').mockImplementation(() => {});
  spyOn(worker, 'startTranscriptWatcher').mockResolvedValue(undefined);
  spyOn(worker, 'runMcpSelfCheck').mockResolvedValue(undefined);
  spyOn(worker, 'startIdleExitMonitor').mockImplementation(() => {});
  await new Promise<void>(resolve => { http = worker.server.app.listen(0, '127.0.0.1', resolve); });
  const address = http!.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  // Exercise the real worker's pre-shutdown cleanup without invoking process
  // supervisor/daemon handoff. Close the real test DB and HTTP server ourselves.
  spyOn(graceful, 'performGracefulShutdown').mockResolvedValue(undefined);
  if (worker) {
    await worker.shutdown('stop');
    await worker.dbManager.close();
  }
  if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
  http = undefined;
  worker = undefined;
  mock.restore();
});

describe('Work View startup ordering', () => {
  it('does not construct Work View or read its database before initialization', async () => {
    expect(worker.workViewRoutes).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect((await fetch(`${origin}/api/work-view`)).status).toBe(503);
    expect(worker.initializationCompleteFlag).toBe(false);
  });

  it('waits for database initialization, then starts refresh and becomes ready', async () => {
    const initialize = worker.dbManager.initialize.bind(worker.dbManager);
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    spyOn(worker.dbManager, 'initialize').mockImplementation(async () => {
      entered();
      await pending;
      await initialize();
    });
    const initializing = worker.initializeBackground();
    await reached;
    const before = reads.mock.calls.length;
    const gated = (await fetch(`${origin}/api/work-view`)).status;
    release();
    await initializing;
    expect(before).toBe(0);
    expect(gated).toBe(503);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(worker.initPhaseTracker.getInitPhase()).toEqual({ phase: 'ready' });
    expect(worker.initializationCompleteFlag).toBe(true);
    expect((await fetch(`${origin}/api/work-view`)).status).toBe(200);
    expect((await fetch(`${origin}/api/readiness`)).status).toBe(200);
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps failed initialization gated and reports code, stack and database context', async () => {
    // Inject the reported error to test diagnostics, not to claim reproduction
    // of the reporter's particular Windows WAL/mapping state.
    const error = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_TRUNCATE', errno: 1546 });
    spyOn(worker.dbManager, 'initialize').mockRejectedValue(error);
    await worker.initializeBackground();
    expect(worker.workViewRoutes).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(worker.initializationCompleteFlag).toBe(false);
    expect(worker.initPhaseTracker.getInitPhase()).toEqual({ phase: 'failed', message: error.message });
    expect((await fetch(`${origin}/api/work-view`)).status).toBe(503);
    expect(errors).toHaveBeenCalledWith('SYSTEM', 'Background initialization failed',
      expect.objectContaining({ code: error.code, errno: 1546, stack: error.stack, databasePath: DB_PATH }), error);
  });

  it('does not create Work View if shutdown occurs while database initialization is pending', async () => {
    spyOn(worker.dbManager, 'initialize').mockImplementation(async () => { worker.isShuttingDown = true; });
    await worker.initializeBackground();
    expect(worker.workViewRoutes).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(worker.initializationCompleteFlag).toBe(false);
    // Let afterEach exercise cleanup, rather than bypassing its shutdown guard.
    worker.isShuttingDown = false;
  });

  it('closes the refresh timer and read-only source before closing the shared database', async () => {
    await worker.initializeBackground();
    const routes = worker.workViewRoutes;
    expect(routes).not.toBeNull();
    // A normal read opens the persistent WorkStateSource read-only handle.
    expect((await fetch(`${origin}/api/work-view`)).status).toBe(200);
    const refresh = routes.autoRefresh;
    const source = routes.source;
    const close = spyOn(routes, 'close');
    spyOn(graceful, 'performGracefulShutdown').mockImplementation(async () => {
      expect(close).toHaveBeenCalledTimes(1);
      expect(refresh.closed).toBe(true);
      expect(source.database).toBeNull();
    });
    await worker.shutdown('stop');
    expect(worker.workViewRoutes).toBeNull();
    expect(await refresh.check()).toBe('closed');
  });
});
