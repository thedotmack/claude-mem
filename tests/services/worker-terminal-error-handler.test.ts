// The worker installs the shared terminal handlers last: `notFoundHandler` and
// `errorHandler` from services/server/ErrorHandler.ts, mounted by
// initializeBackground() after the routes it registers late (search, Work View,
// sync, backups). Without them the worker answers an unknown route, and an
// error forwarded with next(err) such as a malformed JSON body, with Express's
// default HTML page, which carries a stack trace and absolute filesystem paths.
// Mounted too early, they answer every late route with a 404. The handler
// behaviour itself is covered in tests/server/error-handler.test.ts; this
// proves the worker wires it in at the right point.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Server as HttpServer } from 'node:http';
import { WorkerService } from '../../src/services/worker-service.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { AutoRefreshWorker } from '../../src/services/work-view/auto-refresh-worker.mjs';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import * as preflight from '../../src/services/worker/dependency-preflight.js';
import * as provisioning from '../../src/services/worker/tree-sitter-cli-provisioning.js';
import * as restore from '../../src/services/backup/restore-swap.js';
import * as processManager from '../../src/services/infrastructure/ProcessManager.js';
import * as cleanup from '../../src/services/infrastructure/CleanupV12_4_3.js';
import * as fts from '../../src/services/infrastructure/FtsMaintenance.js';
import * as adoption from '../../src/services/infrastructure/WorktreeAdoption.js';
import * as graceful from '../../src/services/infrastructure/GracefulShutdown.js';
import { logger } from '../../src/utils/logger.js';

// tests/preload.ts sets CLAUDE_MEM_DATA_DIR before these modules load, so the
// database below lives in a disposable directory, never user data.
let worker: any;
let http: HttpServer | undefined;
let origin: string;

beforeEach(async () => {
  const settings = { ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_CHROMA_ENABLED: 'false' };
  spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(settings);
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  spyOn(logger, 'error').mockImplementation(() => {});
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
  // Never launch a paid agent from the Work View refresh.
  spyOn(AutoRefreshWorker.prototype, 'run').mockResolvedValue('idle');
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

async function expectJsonNotFound(path: string): Promise<void> {
  const response = await fetch(`${origin}${path}`);
  expect(response.status).toBe(404);
  expect(response.headers.get('content-type') ?? '').toContain('application/json');
  expect((await response.json() as { error?: string }).error).toBe('NotFound');
}

describe('worker terminal handlers', () => {
  it('serves the late routes and answers unknown paths and bad bodies with JSON once initialized', async () => {
    await worker.initializeBackground();
    expect(worker.initializationCompleteFlag).toBe(true);

    // Registered in initializeBackground(), after the constructor's routes.
    expect((await fetch(`${origin}/api/search?query=x`)).status).not.toBe(404);
    expect((await fetch(`${origin}/api/backup/list`)).status).not.toBe(404);

    await expectJsonNotFound('/definitely-not-a-route');

    const malformed = await fetch(`${origin}/api/memory/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"text": ',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type') ?? '').toContain('application/json');
    const raw = await malformed.text();
    expect(JSON.parse(raw)).not.toHaveProperty('stack');
    expect(raw).not.toContain(process.cwd());
    expect(raw).not.toContain('node_modules');
  });

  it('still installs the JSON handlers when initialization fails', async () => {
    spyOn(worker.dbManager, 'initialize').mockRejectedValue(new Error('disk I/O error'));
    await worker.initializeBackground();
    expect(worker.initializationCompleteFlag).toBe(false);

    await expectJsonNotFound('/definitely-not-a-route');
    // The init gate still answers the API with 503 rather than a 404.
    expect((await fetch(`${origin}/api/search?query=x`)).status).toBe(503);
  });
});
