import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };

// Reproduces the "worker unreachable for N consecutive hooks" loop: the
// health check never succeeds (nothing answers /api/health), the PID file
// can't name an owner to kill, but a raw socket probe says the port is
// occupied — a zombie OS-level LISTEN socket left behind by a dead process
// (observed on Windows: Get-NetTCPConnection reports an owning PID that
// Get-Process/taskkill both say does not exist). Lazy-spawning here is
// doomed forever: the new daemon's own duplicate-gate would see the same
// occupied port and immediately exit(0) without binding.

const spawnCalls: Array<{ command: string; args: string[] }> = [];
let portOccupied = true;

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve({ matches: true, pluginVersion: '13.16.0', workerVersion: '13.16.0' }),
  isPortInUse: () => Promise.resolve(portOccupied),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'missing',
  readOwnedWorkerPidInfo: () => null,
}));

mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return { pid: 5151, unref: () => {} };
  },
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-zombie-port=${Date.now()}-${Math.random()}`);
}

function installUnreachableFetchMock(): void {
  global.fetch = mock(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1'))) as unknown as typeof fetch;
}

describe('ensureWorkerRunning — zombie port guard', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-zombie-port-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    installUnreachableFetchMock();
    spawnCalls.length = 0;
    portOccupied = true;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
  });

  it('returns false without spawning when the port is occupied but unowned and unreachable', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(false);
    expect(spawnCalls.length).toBe(0);
  });
});
