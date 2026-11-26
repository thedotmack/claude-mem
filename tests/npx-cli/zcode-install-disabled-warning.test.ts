import { afterAll, describe, expect, it, mock } from 'bun:test';
import { stripVTControlCharacters } from 'util';
import * as realZCodeInstallerModule from '../../src/services/integrations/ZCodeHooksInstaller.js';
import type { ZCodeStatus } from '../../src/services/integrations/ZCodeHooksInstaller.js';

// ZCode has one switch for all hooks. With it off, the install succeeds and
// ZCode runs nothing, so the install task has to say so. A run without a
// terminal (CI, a script, this test) buffers no installer output, so the task
// must ask the status function instead of matching the printed text.

// bun test runs every file in one process, and mock.restore() does not undo a
// module mock: put the real installer back after this file.
const realZCodeInstallerSnapshot = { ...realZCodeInstallerModule };

let statusAfterInstall: ZCodeStatus = 'installed';

// The mocked install writes nothing, so the real ~/.zcode is never touched.
mock.module('../../src/services/integrations/ZCodeHooksInstaller.js', () => ({
  ...realZCodeInstallerSnapshot,
  installZCode: () => 0,
  readZCodeStatus: () => ({ status: statusAfterInstall }),
}));

// Dynamic imports keep the module mock registered before install.ts (and its
// lazy ZCodeHooksInstaller import) is evaluated.
const { makeIDETask } = await import('../../src/npx-cli/commands/install.js');
const { createInstallSummary } = await import('../../src/npx-cli/install/error-reporter.js');

describe('ZCode install task', () => {
  afterAll(() => {
    mock.module('../../src/services/integrations/ZCodeHooksInstaller.js', () => realZCodeInstallerSnapshot);
  });

  it('warns that ZCode will run nothing when the status after install is disabled', async () => {
    statusAfterInstall = 'disabled';
    const summary = createInstallSummary();

    const descriptor = makeIDETask('zcode', summary);
    expect(descriptor).not.toBeNull();
    const line = stripVTControlCharacters(await descriptor!.task(() => {}));

    expect(line).toContain('hooks.enabled is false');
    expect(line).not.toContain('OK');
    expect(summary.failedIDEs).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]!.component).toBe('zcode');
    expect(summary.warnings[0]!.remediation).toContain('hooks.enabled');
  });

  it('reports OK with no warning when the status after install is installed', async () => {
    statusAfterInstall = 'installed';
    const summary = createInstallSummary();

    const descriptor = makeIDETask('zcode', summary);
    expect(descriptor).not.toBeNull();
    const line = stripVTControlCharacters(await descriptor!.task(() => {}));

    expect(line).toContain('OK');
    expect(line).not.toContain('hooks.enabled');
    expect(summary.failedIDEs).toEqual([]);
    expect(summary.warnings).toEqual([]);
  });
});
