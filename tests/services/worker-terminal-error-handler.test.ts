// The worker installs the shared terminal handlers last, after its routes:
// `notFoundHandler` and `errorHandler` from services/server/ErrorHandler.ts.
// Without that call the worker answers an unknown route (and a thrown route
// error) with Express's default HTML page, which carries a stack trace and
// absolute filesystem paths. The handler behaviour itself is covered in
// tests/server/error-handler.test.ts; this proves the worker wires it in.

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

describe('worker terminal handlers', () => {
  let worker: WorkerService | undefined;
  let http: HttpServer | undefined;

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
    spyOn(AutoRefreshWorker.prototype, 'run').mockResolvedValue('idle');
    spyOn(graceful, 'performGracefulShutdown').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (worker) {
      await worker.shutdown('stop');
      await worker.dbManager.close();
    }
    if (http) await new Promise<void>((resolve, reject) => http!.close(error => error ? reject(error) : resolve()));
    http = undefined;
    worker = undefined;
    mock.restore();
  });

  it('answers an unknown worker route with a JSON 404, not Express HTML', async () => {
    worker = new WorkerService();
    spyOn(worker, 'startHookSpoolDrain').mockImplementation(() => {});
    spyOn(worker, 'startTranscriptWatcher').mockResolvedValue(undefined);
    spyOn(worker, 'runMcpSelfCheck').mockResolvedValue(undefined);
    spyOn(worker, 'startIdleExitMonitor').mockImplementation(() => {});

    http = worker.server.app.listen(0, '127.0.0.1');
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const response = await fetch(`http://127.0.0.1:${address.port}/definitely-not-a-route`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').toContain('application/json');
    const body = await response.json() as { error?: string; message?: string };
    expect(body.error).toBe('NotFound');
  });
});