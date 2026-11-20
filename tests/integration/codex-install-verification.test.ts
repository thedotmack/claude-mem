import { describe, expect, it } from 'bun:test';
import type { SpawnSyncReturns } from 'child_process';

import { verifyCodexPluginLoaded } from '../../src/services/integrations/CodexCliInstaller.js';

// performCodexInstall gates its exit code on this result, so a plugin Codex
// never loaded no longer reports a successful install. The spawn is injected
// rather than faked on PATH: bun's spawnSync ignores a mutated process.env.PATH
// and would run the real codex, and driving the full installer would write to
// the developer's real ~/.codex/config.toml.
function spawnResult(overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

describe('verifyCodexPluginLoaded', () => {
  it('reports failure when Codex lists plugins but not claude-mem', () => {
    const listing = 'Marketplace `openai-bundled`\nsites@openai-bundled  installed, enabled\n';

    expect(verifyCodexPluginLoaded(() => spawnResult({ stdout: listing }))).toBe(false);
  });

  it('reports success when Codex lists claude-mem', () => {
    const listing = 'Marketplace `claude-mem-local`\nclaude-mem@claude-mem-local  installed, enabled  13.13.1\n';

    expect(verifyCodexPluginLoaded(() => spawnResult({ stdout: listing }))).toBe(true);
  });

  it('does not fail the install when the listing exits non-zero', () => {
    // Unknown state, not a broken one: the install steps themselves succeeded,
    // so an unrelated CLI hiccup must not fail an otherwise-good install.
    const failed = spawnResult({ status: 1, stderr: 'failed to load configured marketplace snapshot(s)' });

    expect(verifyCodexPluginLoaded(() => failed)).toBe(true);
  });

  it('does not fail the install when the listing cannot be spawned', () => {
    const errored = spawnResult({ status: null, error: new Error('spawn codex ENOENT') });

    expect(verifyCodexPluginLoaded(() => errored)).toBe(true);
  });

  it('passes the plugin list subcommand to codex', () => {
    const calls: string[][] = [];
    verifyCodexPluginLoaded((args) => {
      calls.push(args);
      return spawnResult({ stdout: 'claude-mem@claude-mem-local' });
    });

    expect(calls).toEqual([['plugin', 'list']]);
  });
});
