import { afterAll, describe, expect, it, mock } from 'bun:test';

// The OpenCode integration distinguishes a hard failure (1) from a partial
// install (2: plugin + context written, MCP entry not). The CLI must not fold
// the partial code into a blanket "plugin installation failed" — it has to be
// recorded as a warning so the install still reports success with remediation.
let installResult = 0;
const OPENCODE_MCP_REGISTRATION_INCOMPLETE = 2;

mock.module('../../src/services/integrations/OpenCodeInstaller.js', () => ({
  installOpenCodeIntegration: async () => installResult,
  OPENCODE_MCP_REGISTRATION_INCOMPLETE,
}));

// Dynamic imports keep the module mock registered before install.ts (and its
// lazy OpenCodeInstaller import) is evaluated.
const { makeIDETask } = await import('../../src/npx-cli/commands/install.js');
const { createInstallSummary } = await import('../../src/npx-cli/install/error-reporter.js');

describe('OpenCode CLI install task', () => {
  afterAll(() => {
    mock.restore();
  });

  it('records a partial install as a warning, not a failed IDE', async () => {
    installResult = OPENCODE_MCP_REGISTRATION_INCOMPLETE;
    const summary = createInstallSummary();

    const descriptor = makeIDETask('opencode', summary);
    expect(descriptor).not.toBeNull();
    const line = await descriptor!.task(() => {});

    // A partial install must not fail the IDE (which would exit non-zero and
    // print "plugin installation failed").
    expect(summary.failedIDEs).toEqual([]);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]?.component).toBe('opencode');
    expect(summary.warnings[0]?.remediation).toContain('re-run');
    expect(line).toContain('MCP registration incomplete');
    expect(line).not.toContain('FAIL');
  });

  it('still records a hard failure for any other non-zero result', async () => {
    installResult = 1;
    const summary = createInstallSummary();

    const descriptor = makeIDETask('opencode', summary);
    const line = await descriptor!.task(() => {});

    expect(summary.failedIDEs).toEqual(['opencode']);
    expect(line).toContain('plugin installation failed');
  });

  it('reports a clean success when the MCP entry is registered', async () => {
    installResult = 0;
    const summary = createInstallSummary();

    const descriptor = makeIDETask('opencode', summary);
    const line = await descriptor!.task(() => {});

    expect(summary.failedIDEs).toEqual([]);
    expect(summary.warnings).toEqual([]);
    expect(line).toContain('OpenCode: plugin installed');
  });
});
