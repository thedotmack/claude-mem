import { describe, expect, it } from 'bun:test';
import {
  AUTO_UPDATE_INSTALLER_DEADLINE_MS,
  AUTO_UPDATE_SUPERVISOR_DEADLINE_MS,
  AUTO_UPDATE_WORKER_STARTUP_CEILING_MS,
  INSTALLER_EXIT_AFTER_KILL_WAIT_MS,
  autoUpdateInstallerDeadlineMs,
  autoUpdateSupervisorDeadlineMs,
  autoUpdateWorkerStartupCeilingMs,
} from '../../../src/services/auto-update/auto-update-deadlines.js';
import { DEFAULT_INSTALL_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from '../../../src/npx-cli/install/setup-runtime.js';
import { getPlatformTimeout, WORKER_BOOT_BIND_DEADLINE_MS } from '../../../src/services/infrastructure/ProcessManager.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../src/services/sqlite/connection.js';
import { WEDGED_WORKER_UPTIME_DEFAULT_S } from '../../../src/shared/hook-constants.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
// Worker readiness after the installer starts it: 30 s, doubled on Windows.
const READINESS_MS = getPlatformTimeout(30 * SECOND_MS);

describe('auto-update deadlines', () => {
  it('gives one installer run the sum of its step budgets, both worker stops included: 34 min 25 s with the 5-minute default (POSIX)', () => {
    // Tree-sitter CLI, the spawn-lock wait, and the two 10 s worker stops
    // (install.ts pre-overwrite and provider-cutover).
    const fixedSteps = 2 * MINUTE_MS + 95 * SECOND_MS + 2 * 10 * SECOND_MS;
    expect(autoUpdateInstallerDeadlineMs(5 * MINUTE_MS)).toBe(6 * 5 * MINUTE_MS + fixedSteps + READINESS_MS);
    if (process.platform !== 'win32') expect(autoUpdateInstallerDeadlineMs(5 * MINUTE_MS)).toBe(34 * MINUTE_MS + 25 * SECOND_MS);
  });

  it('scales with CLAUDE_MEM_INSTALL_TIMEOUT_MS, and stays finite when the installer\'s timers are turned off', () => {
    expect(autoUpdateInstallerDeadlineMs(60 * SECOND_MS) - autoUpdateInstallerDeadlineMs(30 * SECOND_MS)).toBe(6 * 30 * SECOND_MS);
    expect(autoUpdateInstallerDeadlineMs(0)).toBe(autoUpdateInstallerDeadlineMs(DEFAULT_INSTALL_TIMEOUT_MS));
  });

  it('waits for a worker to finish starting as long as the worker\'s own startup bounds allow: the 60 s bind deadline plus the 300 s booting grace', () => {
    expect(WORKER_BOOT_BIND_DEADLINE_MS).toBe(60 * SECOND_MS);
    expect(WEDGED_WORKER_UPTIME_DEFAULT_S).toBe(300);
    expect(autoUpdateWorkerStartupCeilingMs({})).toBe(6 * MINUTE_MS);
    // A user who gave a booting worker more time (CLAUDE_MEM_WEDGED_WORKER_UPTIME_S) gives the proof that time too.
    expect(autoUpdateWorkerStartupCeilingMs({ CLAUDE_MEM_WEDGED_WORKER_UPTIME_S: '900' })).toBe(WORKER_BOOT_BIND_DEADLINE_MS + 900 * SECOND_MS);
    // An out-of-range value falls back to the default, as it does for the port reclaim.
    expect(autoUpdateWorkerStartupCeilingMs({ CLAUDE_MEM_WEDGED_WORKER_UPTIME_S: '5' })).toBe(6 * MINUTE_MS);
  });

  it('gives a supervisor two pid-read, install, exit-wait, worker-start and startup runs, the schema read and the previous version\'s npm check: 82 min 30 s with the defaults (POSIX)', () => {
    const installer = autoUpdateInstallerDeadlineMs(DEFAULT_INSTALL_TIMEOUT_MS);
    const startupCeiling = autoUpdateWorkerStartupCeilingMs({});
    // The restart CLI's 2 s pid read, the 1 s wait for a killed installer, the
    // 2 s read of whether a worker runs and the start's readiness wait before each
    // proof, four statements that may each wait out SQLite's 5 s busy timeout,
    // and one 10 s fetch.
    expect(autoUpdateSupervisorDeadlineMs(installer, startupCeiling))
      .toBe(2 * (2 * SECOND_MS + installer + SECOND_MS + 2 * SECOND_MS + READINESS_MS + startupCeiling) + 4 * 5 * SECOND_MS + 10 * SECOND_MS);
    if (process.platform !== 'win32') expect(autoUpdateSupervisorDeadlineMs(installer, startupCeiling)).toBe(82 * MINUTE_MS + 30 * SECOND_MS);
  });

  it('keeps its copy of SQLite\'s busy timeout equal to connection.ts, and the post-kill wait to the supervisor shutdown\'s 1 s', () => {
    // The supervisor deadline counts the copy; this pins it to the source.
    const installer = autoUpdateInstallerDeadlineMs(DEFAULT_INSTALL_TIMEOUT_MS);
    const withoutSchemaRead = 2 * (2 * SECOND_MS + installer + INSTALLER_EXIT_AFTER_KILL_WAIT_MS + 2 * SECOND_MS + READINESS_MS + MINUTE_MS) + 10 * SECOND_MS;
    expect(autoUpdateSupervisorDeadlineMs(installer, MINUTE_MS) - withoutSchemaRead).toBe(4 * SQLITE_BUSY_TIMEOUT_MS);
    expect(INSTALLER_EXIT_AFTER_KILL_WAIT_MS).toBe(SECOND_MS);
  });

  it('exports the values for this process\'s install budget and env', () => {
    expect(AUTO_UPDATE_INSTALLER_DEADLINE_MS).toBe(autoUpdateInstallerDeadlineMs(INSTALL_TIMEOUT_MS));
    expect(AUTO_UPDATE_WORKER_STARTUP_CEILING_MS).toBe(autoUpdateWorkerStartupCeilingMs(process.env));
    expect(AUTO_UPDATE_SUPERVISOR_DEADLINE_MS).toBe(autoUpdateSupervisorDeadlineMs(AUTO_UPDATE_INSTALLER_DEADLINE_MS, AUTO_UPDATE_WORKER_STARTUP_CEILING_MS));
  });
});
