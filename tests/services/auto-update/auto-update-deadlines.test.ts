import { describe, expect, it } from 'bun:test';
import {
  INSTALLER_EXIT_AFTER_KILL_WAIT_MS,
  autoUpdateInstallerDeadlineMs,
  autoUpdateSupervisorDeadlineMs,
  autoUpdateWorkerStartupCeilingMs,
} from '../../../src/services/auto-update/auto-update-deadlines.js';
import { DEFAULT_INSTALL_TIMEOUT_MS } from '../../../src/npx-cli/install/setup-runtime.js';
import { getPlatformTimeout, WORKER_BOOT_BIND_DEADLINE_MS } from '../../../src/services/infrastructure/ProcessManager.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../src/services/sqlite/connection.js';
import { WEDGED_WORKER_UPTIME_DEFAULT_S } from '../../../src/shared/hook-constants.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
// Worker readiness after the installer starts it: 30 s, doubled on Windows.
const READINESS_MS = getPlatformTimeout(30 * SECOND_MS);

describe('auto-update deadlines', () => {
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

  it('keeps its copy of SQLite\'s busy timeout equal to connection.ts, and the post-kill wait to the supervisor shutdown\'s 1 s', () => {
    // The supervisor deadline counts the copy; this pins it to the source.
    const installer = autoUpdateInstallerDeadlineMs(DEFAULT_INSTALL_TIMEOUT_MS);
    const withoutSchemaRead = 2 * (2 * SECOND_MS + installer + INSTALLER_EXIT_AFTER_KILL_WAIT_MS + 2 * SECOND_MS + READINESS_MS + MINUTE_MS) + 10 * SECOND_MS;
    expect(autoUpdateSupervisorDeadlineMs(installer, MINUTE_MS) - withoutSchemaRead).toBe(4 * SQLITE_BUSY_TIMEOUT_MS);
    expect(INSTALLER_EXIT_AFTER_KILL_WAIT_MS).toBe(SECOND_MS);
  });
});
