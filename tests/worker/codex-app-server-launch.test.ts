import { describe, expect, it } from 'bun:test';
import { buildCodexAppServerLaunch } from '../../src/services/worker/CodexAppServerClient.js';

describe('Codex app-server launch', () => {
  it('launches Windows command shims through cmd.exe without shell mode', () => {
    const launch = buildCodexAppServerLaunch('codex', 'win32', () => 'C:\\Program Files\\Codex\\codex.cmd');
    expect(launch.command).toBe(process.env.ComSpec ?? 'cmd.exe');
    expect(launch.args).toEqual([
      '/d', '/s', '/c',
      '""C:\\Program Files\\Codex\\codex.cmd" "app-server" "--listen" "stdio://""',
    ]);
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(buildCodexAppServerLaunch('codex', 'win32', () => null).args[3]).toContain('codex.cmd');
    expect(buildCodexAppServerLaunch('C:\\Codex\\codex.exe', 'win32').command).toBe('C:\\Codex\\codex.exe');
  });
});
