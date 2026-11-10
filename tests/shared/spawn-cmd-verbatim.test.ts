import { describe, it, expect } from 'bun:test';
import { buildSpawnSyncInvocation } from '../../src/shared/spawn.js';

describe('buildSpawnSyncInvocation Windows cmd.exe verbatim contract', () => {
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
