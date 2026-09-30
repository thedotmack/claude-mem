import { describe, it, expect } from 'bun:test';
import { buildSpawnSyncInvocation } from '../../src/shared/spawn.js';

// Regression for the Windows codex.cmd spawn failure (issue #2695 follow-up):
// buildSpawnSyncInvocation builds ONE pre-quoted `cmd.exe /d /s /c "<shim>" ...`
// payload string. Two invariants keep that payload intact end-to-end:
//   1. windowsVerbatimArguments — without it Node re-applies its own argv
//      escaping, turning the leading `"` into `\"`, so cmd.exe tries to run a
//      program literally named `\"C:\...\codex.cmd\"` and dies.
//   2. an outer quote pair around the whole command line — `cmd /s /c` strips
//      the outermost quotes, so without the wrap it eats the real per-arg quotes
//      and mangles the command line (breaking any arg that contains spaces).
// This file only imports src/shared/spawn.ts (no heavy deps), so it runs even in
// a minimal checkout, unlike tests/services/integrations/spawn-contract-windows.

describe('buildSpawnSyncInvocation Windows cmd.exe verbatim contract', () => {
  it('outer-wraps the pre-quoted cmd.exe payload and marks it verbatim', () => {
    const invocation = buildSpawnSyncInvocation(
      'C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs\\codex.cmd',
      ['--version'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      'win32',
    );

    // command is process.env.ComSpec ?? 'cmd.exe' — a full path on a real box.
    expect(invocation.command.toLowerCase().endsWith('cmd.exe')).toBe(true);
    expect(invocation.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs\\codex.cmd" "--version""',
    ]);
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
  });

  it('does NOT force verbatim args for directly-spawned native executables', () => {
    // .exe is spawned directly with its own arg array; forcing verbatim here
    // would break normal Node quoting for args that contain spaces.
    const invocation = buildSpawnSyncInvocation(
      'C:\\Tools\\codex.exe',
      ['run', 'C:\\Path With Spaces'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      'win32',
    );

    expect(invocation.command).toBe('C:\\Tools\\codex.exe');
    expect(invocation.args).toEqual(['run', 'C:\\Path With Spaces']);
    expect(invocation.options.windowsVerbatimArguments).not.toBe(true);
  });
});
