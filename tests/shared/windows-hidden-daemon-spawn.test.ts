import { describe, it, expect } from 'bun:test';
import { buildDetachedWorkerDaemonSpawn } from '../../src/services/infrastructure/ProcessManager.js';
import { buildSpawnSyncInvocation } from '../../src/shared/spawn.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #5240 — Windows worker daemon launch under behaviour-blocking AV.
 *
 * The daemon used to launch as `powershell -NoProfile -WindowStyle Hidden
 * -EncodedCommand <base64 Start-Process>`. That command line is the
 * fileless-malware fingerprint Kaspersky (PDM:Exploit.Win32.Generic) and
 * BluePex killed, so the launcher's node.exe was blocked and the worker never
 * started (#3831, #5240).
 *
 * The contract now: a plain detached spawnHidden on win32 as well — no shell,
 * no base64, no powershell — with spawnHidden forcing windowsHide so the
 * daemon gets no console window (#3521).
 */
describe('Windows #5240 — worker daemon launch contract', () => {
  it('spawns the runtime directly on Windows, never through PowerShell', () => {
    const runtimePath = String.raw`C:\Users\Test User\.bun\bin\bun.exe`;
    const scriptPath = String.raw`C:\Users\Test User\.claude\plugins\marketplaces\thedotmack\plugin\scripts\worker-service.cjs`;

    const plan = buildDetachedWorkerDaemonSpawn(runtimePath, scriptPath, {}, 'win32');

    expect(plan.command).toBe(runtimePath);
    // Direct argv: a spaced script path stays one argument, so the old
    // PowerShell -ArgumentList quoting workaround (#3195) cannot recur.
    expect(plan.args).toEqual([scriptPath, '--daemon']);
    // Detached so the daemon outlives the hook or MCP server that launched it.
    expect(plan.options.detached).toBe(true);
    expect(plan.options.stdio).toBe('ignore');
  });

  it('never uses setsid on Windows even when /usr/bin/setsid exists', () => {
    const plan = buildDetachedWorkerDaemonSpawn('bun.exe', 'worker-service.cjs', {}, 'win32', true);

    expect(plan.command).toBe('bun.exe');
    expect(plan.args).toEqual(['worker-service.cjs', '--daemon']);
  });

  it('uses setsid on POSIX when it is available', () => {
    const plan = buildDetachedWorkerDaemonSpawn(
      '/home/me/.bun/bin/bun',
      '/plugin/worker-service.cjs',
      {},
      'linux',
      true,
    );

    expect(plan.command).toBe('/usr/bin/setsid');
    expect(plan.args).toEqual(['/home/me/.bun/bin/bun', '/plugin/worker-service.cjs', '--daemon']);
  });

  it('falls back to launching the runtime directly when setsid is absent', () => {
    const plan = buildDetachedWorkerDaemonSpawn(
      '/home/me/.bun/bin/bun',
      '/plugin/worker-service.cjs',
      {},
      'linux',
      false,
    );

    expect(plan.command).toBe('/home/me/.bun/bin/bun');
    expect(plan.args).toEqual(['/plugin/worker-service.cjs', '--daemon']);
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

  it('routes the hook lazy-spawn paths through spawnDetachedWorkerDaemon, never a raw detached spawn', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/shared/worker-utils.ts'), 'utf8');
    expect(source).not.toContain('spawnHidden(');
    expect(source).toContain('spawnDetachedWorkerDaemon(');
  });
});
