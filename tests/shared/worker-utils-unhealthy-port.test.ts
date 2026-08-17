import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };
const spawnCalls: string[] = [];
let occupancy: 'free' | 'occupied' | 'indeterminate' = 'occupied';

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve({ matches: true, pluginVersion: '13.15.2', workerVersion: '13.15.2' }),
  classifyPortOccupancy: () => Promise.resolve(occupancy),
}));
mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'missing',
  readOwnedWorkerPidInfo: () => null,
}));
mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string) => {
    spawnCalls.push(command);
    return { unref: () => {} };
  },
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?unhealthy-port=${Date.now()}-${Math.random()}`);
}

describe('ensureWorkerRunning — unhealthy port guard', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const originalScript = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  let dataDir: string;
  let scriptPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-unhealthy-port-'));
    scriptPath = join(dataDir, 'worker-service.cjs');
    writeFileSync(scriptPath, '');
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = scriptPath;
    spawnCalls.length = 0;
    occupancy = 'occupied';
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') } as unknown as Response));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    if (originalScript === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalScript;
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
  });

  it('wedged listener returns fallback without spawn', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();
    expect(result).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it('proven-free bind reaches the existing spawn gate once', async () => {
    occupancy = 'free';
    let healthCalls = 0;
    global.fetch = mock(() => {
      healthCalls += 1;
      return Promise.resolve({ ok: healthCalls > 1, status: healthCalls > 1 ? 200 : 503, text: () => Promise.resolve('') } as unknown as Response);
    });
    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();
    expect(result).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });

  it('indeterminate bind and an expired budget do not spawn', async () => {
    occupancy = 'indeterminate';
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerRunning()).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });

  it('caches the failed fallback for later calls in the same hook process', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(false);
    occupancy = 'free';
    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(false);
    expect(spawnCalls).toHaveLength(0);
  });
});
