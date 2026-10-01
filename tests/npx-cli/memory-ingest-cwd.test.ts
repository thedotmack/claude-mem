// R5-5: the npx CLI runs the worker script from the plugin root, so
// `npx claude-mem memory ingest` must pass the directory the user ran it in,
// as `adopt` does. Before, the default source was the plugin root's memory dir
// and every run failed with "source not found".
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as spawnModule from '../../src/shared/spawn.js';
import * as workerUtils from '../../src/shared/worker-utils.js';
import * as setupRuntime from '../../src/npx-cli/install/setup-runtime.js';
import { runMemoryIngestCommand } from '../../src/npx-cli/commands/runtime.js';

describe('npx claude-mem memory ingest', () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let pluginRoot: string | undefined;

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    if (pluginRoot) rmSync(pluginRoot, { recursive: true, force: true });
    pluginRoot = undefined;
  });

  it('passes the directory the user ran it in as --cwd (R5-5)', () => {
    pluginRoot = mkdtempSync(join(tmpdir(), 'claude-mem-plugin-root-'));
    const workerScript = join(pluginRoot, 'scripts', 'worker-service.cjs');
    mkdirSync(join(pluginRoot, 'scripts'));
    writeFileSync(workerScript, '');
    const spawned: Array<{ args: readonly string[] | undefined; cwd: unknown }> = [];
    spies.push(
      spyOn(workerUtils, 'resolvePluginRoot').mockReturnValue({
        root: pluginRoot,
        version: 'test',
        missingDependencies: [],
      } as unknown as ReturnType<typeof workerUtils.resolvePluginRoot>),
      spyOn(setupRuntime, 'getBunPath').mockReturnValue('/usr/local/bin/bun'),
      spyOn(spawnModule, 'spawnHidden').mockImplementation(((
        _command: string,
        args?: readonly string[],
        options?: { cwd?: unknown },
      ) => {
        spawned.push({ args, cwd: options?.cwd });
        return new EventEmitter();
      }) as unknown as typeof spawnModule.spawnHidden),
    );

    runMemoryIngestCommand(['--dry-run']);

    expect(spawned).toEqual([{
      args: [workerScript, 'memory', 'ingest', '--dry-run', '--cwd', process.cwd()],
      cwd: pluginRoot,
    }]);
  });
});
