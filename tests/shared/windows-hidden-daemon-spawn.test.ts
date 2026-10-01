import { describe, it, expect } from 'bun:test';
import {
  buildWindowsDaemonStartCommand,
  buildWindowsHiddenDaemonPowerShellArgs,
  resolveWindowsPowerShellPath,
  WINDOWS_HIDDEN_DAEMON_SPAWN_TIMEOUT_MS,
  windowsDaemonLaunchTimeoutMs,
} from '../../src/services/infrastructure/ProcessManager.js';
import { buildSpawnSyncInvocation } from '../../src/shared/spawn.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #3521 — Windows console flash from detached / shell-string daemon spawns.
 * Contract: Windows daemon launch must go through Start-Process -WindowStyle
 * Hidden via powershell argv (never Node detached:true, never
 * execSync('powershell ...') shell string).
 */
describe('Windows #3521 — hidden daemon spawn contract', () => {
  it('Start-Process script keeps -WindowStyle Hidden', () => {
    const command = buildWindowsDaemonStartCommand(
      String.raw`C:\bun\bun.exe`,
      String.raw`C:\plugin\worker-service.cjs`,
    );
    expect(command).toContain('-WindowStyle Hidden');
    expect(command).toContain('Start-Process');
  });

  it('powershell argv includes -WindowStyle Hidden and -EncodedCommand (no shell string)', () => {
    const args = buildWindowsHiddenDaemonPowerShellArgs(
      String.raw`C:\Users\Test\.bun\bin\bun.exe`,
      String.raw`C:\Users\Test\plugin\scripts\worker-service.cjs`,
    );

    expect(args[0]).toBe('-NoProfile');
    expect(args[1]).toBe('-WindowStyle');
    expect(args[2]).toBe('Hidden');
    expect(args[3]).toBe('-EncodedCommand');
    expect(args[4]).toMatch(/^[A-Za-z0-9+/=]+$/);

    const decoded = Buffer.from(args[4], 'base64').toString('utf16le');
    expect(decoded).toBe(
      buildWindowsDaemonStartCommand(
        String.raw`C:\Users\Test\.bun\bin\bun.exe`,
        String.raw`C:\Users\Test\plugin\scripts\worker-service.cjs`,
      ),
    );
  });

  it('resolves System32 powershell when SystemRoot is set', () => {
    expect(
      resolveWindowsPowerShellPath({ SystemRoot: 'C:\\Windows' }),
    ).toBe(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  });

  it('buildSpawnSyncInvocation forces windowsHide even when options try to disable it', () => {
    const invocation = buildSpawnSyncInvocation(
      String.raw`C:\Tools\bin\tool.exe`,
      ['run'],
      { encoding: 'utf-8', stdio: 'ignore', windowsHide: false },
      'win32',
    );
    expect(invocation.options.windowsHide).toBe(true);
  });

  it('Windows daemon spawnSync uses a bounded timeout (Greptile P1)', () => {
    expect(WINDOWS_HIDDEN_DAEMON_SPAWN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(windowsDaemonLaunchTimeoutMs()).toBe(WINDOWS_HIDDEN_DAEMON_SPAWN_TIMEOUT_MS);
    const source = readFileSync(
      join(import.meta.dir, '../../src/services/infrastructure/ProcessManager.ts'),
      'utf8',
    );
    expect(source).toContain('const launchTimeoutMs = windowsDaemonLaunchTimeoutMs(launchCapMs);');
    expect(source).toContain('timeout: launchTimeoutMs');
  });

  it('cuts the Windows launch to what is left of a hook budget, never past its own bound', () => {
    // A synchronous PowerShell Start-Process that ignored the hook budget could
    // push UserPromptSubmit past Claude Code's 15 s timeout.
    expect(windowsDaemonLaunchTimeoutMs(2_500)).toBe(2_500);
    expect(windowsDaemonLaunchTimeoutMs(60_000)).toBe(WINDOWS_HIDDEN_DAEMON_SPAWN_TIMEOUT_MS);
    expect(windowsDaemonLaunchTimeoutMs(0)).toBe(1);
  });

  it('keeps the daemon cwd pinned: the encoded Start-Process carries -WorkingDirectory (#3706)', () => {
    const args = buildWindowsHiddenDaemonPowerShellArgs(
      String.raw`C:\bun\bun.exe`,
      String.raw`C:\plugin\worker-service.cjs`,
      String.raw`C:\Users\Test\.claude-mem`,
    );
    const decoded = Buffer.from(args[4], 'base64').toString('utf16le');
    expect(decoded).toContain(String.raw`-WorkingDirectory 'C:\Users\Test\.claude-mem'`);
  });

  it('routes the hook lazy-spawn paths through spawnDetachedWorkerDaemon, never a raw detached spawn', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/shared/worker-utils.ts'), 'utf8');
    expect(source).not.toContain('spawnHidden(');
    expect(source).toContain('spawnDetachedWorkerDaemon(');
  });
});
