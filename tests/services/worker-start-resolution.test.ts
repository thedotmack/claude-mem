import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureWorkerStarted } from '../../src/services/worker-service.js';
import * as spawner from '../../src/services/worker-spawner.js';
import * as workerUtils from '../../src/shared/worker-utils.js';

describe('worker-service start script resolution (#6228)', () => {
  let root: string;
  const savedOverride = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-start-resolution-'));
    delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  });

  afterEach(() => {
    mock.restore();
    rmSync(root, { recursive: true, force: true });
    if (savedOverride === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = savedOverride;
  });

  it('starts the dependency-complete cache worker instead of the invoking marketplace copy', async () => {
    const cacheRoot = join(root, 'cache', 'thedotmack', 'claude-mem');
    const cachePlugin = join(cacheRoot, '15.3.0');
    const marketplaceRoot = join(root, 'marketplaces', 'thedotmack');
    const marketplacePlugin = join(marketplaceRoot, 'plugin');
    const cacheScript = join(cachePlugin, 'scripts', 'worker-service.cjs');
    const marketplaceScript = join(marketplacePlugin, 'scripts', 'worker-service.cjs');
    for (const plugin of [cachePlugin, marketplacePlugin]) {
      mkdirSync(join(plugin, 'scripts'), { recursive: true });
      writeFileSync(join(plugin, 'scripts', 'worker-service.cjs'), '// fake worker\n');
      writeFileSync(join(plugin, 'package.json'), JSON.stringify({ dependencies: { 'test-dep': '*' } }));
    }
    writeFileSync(join(marketplaceRoot, 'package.json'), JSON.stringify({ version: '15.3.0' }));
    mkdirSync(join(cachePlugin, 'node_modules', 'test-dep'), { recursive: true });
    writeFileSync(join(cachePlugin, 'node_modules', 'test-dep', 'package.json'), '{}');

    // Keep the real resolver and its dependency checks; only replace its search
    // roots so this test cannot discover the user's installed worker.
    spyOn(workerUtils, 'resolveWorkerScriptPath').mockImplementation(() => workerUtils.resolveWorkerScript({
      cacheRoot, marketplaceRoot, cwd: marketplaceRoot, runningModuleFile: marketplaceScript,
    })?.scriptPath ?? null);
    const start = spyOn(spawner, 'ensureWorkerStarted').mockResolvedValue('warming');

    expect(await ensureWorkerStarted(39001)).toBe('warming');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(39001, cacheScript);
  });

  it('falls back to the current script when no installed worker can be resolved', async () => {
    spyOn(workerUtils, 'resolveWorkerScriptPath').mockReturnValue(null);
    const start = spyOn(spawner, 'ensureWorkerStarted').mockResolvedValue('ready');

    expect(await ensureWorkerStarted(39002)).toBe('ready');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(39002, join(import.meta.dir, '../../src/services/worker-service.ts'));
  });
});
