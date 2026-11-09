import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Server as HttpServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { WorkerService } from '../../../src/services/worker-service.js';
import { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { AutoRefreshWorker } from '../../../src/services/work-view/auto-refresh-worker.mjs';
import { autoUpdateStatePath, defaultAutoUpdateState, type AutoUpdateState } from '../../../src/services/auto-update/auto-update-state.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import * as workerUtils from '../../../src/shared/worker-utils.js';
import * as preflight from '../../../src/services/worker/dependency-preflight.js';
import * as provisioning from '../../../src/services/worker/tree-sitter-cli-provisioning.js';
import * as restore from '../../../src/services/backup/restore-swap.js';
import * as processManager from '../../../src/services/infrastructure/ProcessManager.js';
import * as cleanup from '../../../src/services/infrastructure/CleanupV12_4_3.js';
import * as fts from '../../../src/services/infrastructure/FtsMaintenance.js';
import * as adoption from '../../../src/services/infrastructure/WorktreeAdoption.js';
import * as graceful from '../../../src/services/infrastructure/GracefulShutdown.js';
import { logger } from '../../../src/utils/logger.js';

// The worker marks an auto-update failure resolved when it finishes starting
// (worker-service.ts resolveAutoUpdateFailuresNowThatThisWorkerIsReady), run
// here through the real initializeBackground with the same stand-ins as
// tests/services/worker-work-view-init.test.ts. tests/preload.ts points the
// data dir, so the database and the state file, at a disposable directory,
// and the resolver is stubbed, so nothing reads the real install.

/**
 * The worker's own version under `bun test`: the build-time define
 * __DEFAULT_PACKAGE_VERSION__ is absent, so worker-service.ts packageVersion
 * falls back to this.
 */
const WORKER_VERSION_UNDER_TEST = '0.0.0-dev';
const NOW_ISH = Date.UTC(2026, 10, 8, 12, 0, 0);
const MINUTE_MS = 60_000;

let worker: any;
let http: HttpServer | undefined;
let statePathBefore: string | null;

const statePath = autoUpdateStatePath();
const restoreFailed: AutoUpdateState['lastAttemptOutcome'] = {
  result: 'restore_failed',
  targetVersion: '15.13.0',
  previousVersion: '15.12.0',
  finishedAt: NOW_ISH - 30 * MINUTE_MS,
  failureStage: 'installer-exit',
  message: 'Nothing switched ... but no worker on 15.12.0 finished starting. Run: npx claude-mem@15.12.0 update',
  fixCommand: 'npx claude-mem@15.12.0 update',
  fixCommandWhen: 'now',
};

function writeState(fields: Partial<AutoUpdateState>): void {
  writeFileSync(statePath, JSON.stringify({ ...defaultAutoUpdateState(), ...fields }));
}

function resolvesTo(version: string | null): void {
  spyOn(workerUtils, 'resolvePluginRoot').mockReturnValue(version === null ? null : { root: '/stub/plugin', version, missingDependencies: [] });
}

beforeEach(async () => {
  statePathBefore = existsSync(statePath) ? readFileSync(statePath, 'utf-8') : null;
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
  // Never launch a paid agent.
  spyOn(AutoRefreshWorker.prototype, 'run').mockResolvedValue('idle');
  worker = new WorkerService();
  spyOn(worker, 'startHookSpoolDrain').mockImplementation(() => {});
  spyOn(worker, 'startTranscriptWatcher').mockResolvedValue(undefined);
  spyOn(worker, 'runMcpSelfCheck').mockResolvedValue(undefined);
  spyOn(worker, 'startIdleExitMonitor').mockImplementation(() => {});
  await new Promise<void>(resolve => { http = worker.server.app.listen(0, '127.0.0.1', resolve); });
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
  if (statePathBefore === null) rmSync(statePath, { force: true });
  else writeFileSync(statePath, statePathBefore);
});

describe('the worker resolves an auto-update failure once it has finished starting', () => {
  it('a restore_failed outcome, on a worker that runs the version the install resolves to: resolved with the time and that version, once ready', async () => {
    writeState({ lastAttemptOutcome: restoreFailed });
    resolvesTo(WORKER_VERSION_UNDER_TEST);
    const before = Date.now();

    await worker.initializeBackground();

    expect(worker.initPhaseTracker.getInitPhase()).toEqual({ phase: 'ready' });
    const outcome = JSON.parse(readFileSync(statePath, 'utf-8')).lastAttemptOutcome;
    expect(outcome).toMatchObject({ ...restoreFailed, resolvedWithWorkerVersion: WORKER_VERSION_UNDER_TEST });
    expect(outcome.resolvedAt).toBeGreaterThanOrEqual(before);
  });

  it('a worker on another version than the install resolves to: nothing marked, the file left as it was', async () => {
    writeState({ lastAttemptOutcome: restoreFailed });
    const raw = readFileSync(statePath, 'utf-8');
    resolvesTo('15.12.0');

    await worker.initializeBackground();

    expect(worker.initPhaseTracker.getInitPhase()).toEqual({ phase: 'ready' });
    expect(readFileSync(statePath, 'utf-8')).toBe(raw);
  });

  it('never while an attempt\'s supervisor is alive: this worker may be the one its installer started', async () => {
    writeState({
      lastAttemptOutcome: restoreFailed,
      // This test's own process stands in for a live supervisor.
      inFlightAttempt: { targetVersion: '15.14.0', previousVersion: '15.12.0', startedAt: Date.now() - MINUTE_MS, supervisorPid: process.pid, supervisorDeadlineMs: 90 * MINUTE_MS },
    });
    const raw = readFileSync(statePath, 'utf-8');
    resolvesTo(WORKER_VERSION_UNDER_TEST);

    await worker.initializeBackground();

    expect(readFileSync(statePath, 'utf-8')).toBe(raw);
  });

  it('a state file it cannot read is logged and never fails the start', async () => {
    rmSync(statePath, { force: true });
    const { mkdirSync } = await import('fs');
    mkdirSync(statePath);
    resolvesTo(WORKER_VERSION_UNDER_TEST);
    const warned = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await worker.initializeBackground();
      expect(worker.initPhaseTracker.getInitPhase()).toEqual({ phase: 'ready' });
      expect(warned.mock.calls.map((call) => String(call[1]))).toContain('Could not mark auto-update failures resolved after this worker finished starting; the notice and doctor may still show them until the next start');
    } finally {
      rmSync(statePath, { recursive: true, force: true });
    }
  });
});
