import { describe, expect, it } from 'bun:test';
import {
  AUTO_UPDATE_INSTALLER_DEADLINE_MS,
  AUTO_UPDATE_SUPERVISOR_DEADLINE_MS,
  autoUpdateInstallerDeadlineMs,
  autoUpdateSupervisorDeadlineMs,
} from '../../../src/services/auto-update/auto-update-deadlines.js';
import { DEFAULT_INSTALL_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from '../../../src/npx-cli/install/setup-runtime.js';
import { getPlatformTimeout } from '../../../src/services/infrastructure/ProcessManager.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
// Worker readiness after the installer starts it, and the restart proof: both
// 30 s, doubled on Windows.
const READINESS_MS = getPlatformTimeout(30 * SECOND_MS);
const RESTART_PROOF_MS = getPlatformTimeout(30 * SECOND_MS);

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

  it('gives a supervisor two install-and-prove runs: 69 min 50 s with the defaults (POSIX)', () => {
    const installer = autoUpdateInstallerDeadlineMs(DEFAULT_INSTALL_TIMEOUT_MS);
    expect(autoUpdateSupervisorDeadlineMs(installer)).toBe(2 * (installer + RESTART_PROOF_MS));
    if (process.platform !== 'win32') expect(autoUpdateSupervisorDeadlineMs(installer)).toBe(69 * MINUTE_MS + 50 * SECOND_MS);
  });

  it('exports the values for this process\'s install budget', () => {
    expect(AUTO_UPDATE_INSTALLER_DEADLINE_MS).toBe(autoUpdateInstallerDeadlineMs(INSTALL_TIMEOUT_MS));
    expect(AUTO_UPDATE_SUPERVISOR_DEADLINE_MS).toBe(autoUpdateSupervisorDeadlineMs(AUTO_UPDATE_INSTALLER_DEADLINE_MS));
  });
});
