import { afterAll, describe, expect, it, mock } from 'bun:test';
import { stripVTControlCharacters } from 'util';
import * as realCodexCliInstallerModule from '../../src/services/integrations/CodexCliInstaller.js';

// Codex runs a hook only after the user trusts it, and skips an untrusted one
// without a message. The installer's own text with that step is buffered away
// when the install succeeds, so the task's result line has to carry it (#6419).

// bun test runs every file in one process, and mock.restore() does not undo a
// module mock: put the real installer back after this file.
const realCodexCliInstallerSnapshot = { ...realCodexCliInstallerModule };

mock.module('../../src/services/integrations/CodexCliInstaller.js', () => ({
  ...realCodexCliInstallerSnapshot,
  installCodexCli: async () => 0,
}));

// Dynamic imports keep the module mock registered before install.ts (and its
// lazy CodexCliInstaller import) is evaluated.
const { makeIDETask } = await import('../../src/npx-cli/commands/install.js');
const { createInstallSummary } = await import('../../src/npx-cli/install/error-reporter.js');

describe('Codex CLI install task', () => {
  afterAll(() => {
    mock.module('../../src/services/integrations/CodexCliInstaller.js', () => realCodexCliInstallerSnapshot);
  });

  it('tells the user to trust the hooks once with /hooks, since codex exec skips untrusted hooks', async () => {
    const summary = createInstallSummary();

    const descriptor = makeIDETask('codex-cli', summary);
    expect(descriptor).not.toBeNull();
    const line = stripVTControlCharacters(await descriptor!.task(() => {}));

    expect(summary.failedIDEs).toEqual([]);
    expect(line).toContain('OK');
    expect(line).toContain('/hooks');
    expect(line).toContain('codex exec skips untrusted hooks');
  });
});
