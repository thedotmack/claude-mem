import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as spawnModule from '../../src/shared/spawn.js';
import * as workerUtils from '../../src/shared/worker-utils.js';
import * as setupRuntime from '../../src/npx-cli/install/setup-runtime.js';
import * as cliPaths from '../../src/npx-cli/utils/paths.js';
import { runHookCommand } from '../../src/npx-cli/commands/runtime.js';

describe('hook installed worker resolution (#5464)', () => {
  const spies: Array<{ mockRestore(): void }> = [];
  const roots: string[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('forwards hooks to the installed plugin rather than a stale npm copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-worker-')); roots.push(root);
    const installed = join(root, 'installed plugin');
    const npm = join(root, 'npm');
    for (const path of [installed, join(npm, 'plugin')]) {
      mkdirSync(join(path, 'scripts'), { recursive: true });
      writeFileSync(join(path, 'scripts', 'worker-service.cjs'), '');
    }
    const child = new EventEmitter();
    const spawn = spyOn(spawnModule, 'spawnHidden').mockReturnValue(child as never);
    spies.push(spawn,
      spyOn(workerUtils, 'resolvePluginRoot').mockReturnValue({ root: installed, version: '15.12.0', missingDependencies: [] }),
      spyOn(cliPaths, 'npmPackageRootDirectory').mockReturnValue(npm),
      spyOn(setupRuntime, 'getBunPath').mockReturnValue('/test/bun'),
    );
    runHookCommand(['claude-code', 'session-init', '--cwd', '/project with spaces']);
    expect(spawn.mock.calls[0]?.[0]).toBe('/test/bun');
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      join(installed, 'scripts', 'worker-service.cjs'), 'hook',
      'claude-code', 'session-init', '--cwd', '/project with spaces',
    ]);
    expect(spawn.mock.calls[0]?.[2]?.cwd).toBe(process.cwd());
    expect(spawn.mock.calls[0]?.[2]?.stdio).toBe('inherit');
    const exit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
    spies.push(exit);
    expect(() => child.emit('close', 7)).toThrow('exit:7');
  });

  it('refuses a missing installed plugin instead of running the npm copy', () => {
    const spawn = spyOn(spawnModule, 'spawnHidden');
    const error = spyOn(console, 'error').mockImplementation(() => {});
    spies.push(spawn, error,
      spyOn(workerUtils, 'resolvePluginRoot').mockReturnValue(null),
      spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); }),
    );
    expect(() => runHookCommand(['claude-code', 'session-init'])).toThrow('exit:1');
    expect(error.mock.calls.some(([line]) => String(line).includes('not installed'))).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });
});
