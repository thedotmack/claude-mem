import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realKillProcessTree from '../../src/shared/kill-process-tree.js';
import * as realPortReclaim from '../../src/shared/port-reclaim.js';
import * as realSpawnGate from '../../src/shared/worker-spawn-gate.js';
import { DATA_DIR } from '../../src/shared/paths.js';
import { isWorkerAutostartDisabled } from '../../src/shared/worker-autostart.js';

/**
 * CLAUDE_MEM_WORKER_AUTOSTART=false: the worker is managed externally. Hooks
 * must still USE a running worker, must never launch, kill or recycle one, and
 * a down worker must not feed the fail-loud counter.
 */

const realHookSettingsSnapshot = { ...realHookSettings };
const realInfrastructureSnapshot = { ...realInfrastructure };
const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realSupervisorSnapshot = { ...realSupervisor };
const realProcessManagerSnapshot = { ...realProcessManager };
const realKillProcessTreeSnapshot = { ...realKillProcessTree };
const realPortReclaimSnapshot = { ...realPortReclaim };
const realSpawnGateSnapshot = { ...realSpawnGate };

let settings: Record<string, unknown> = {};
let workerUp = true;
let versionMatch = { matches: true, pluginVersion: '13.4.1', workerVersion: '13.4.1' };
const spawnCalls: string[] = [];
const killCalls: number[] = [];

mock.module('../../src/shared/hook-settings.js', () => ({
  ...realHookSettingsSnapshot,
  loadFromFileOnce: () => settings,
}));
mock.module('../../src/services/infrastructure/index.js', () => ({
  ...realInfrastructureSnapshot,
  checkVersionMatch: () => Promise.resolve(versionMatch),
  isPortInUse: () => Promise.resolve(false),
}));
mock.module('../../src/services/infrastructure/HealthMonitor.js', () => ({
  ...realHealthMonitorSnapshot,
  // The pre-spawn port gate (#3171): report the port free so the default path
  // reaches the spawn.
  classifyPortOccupancy: () => Promise.resolve('free'),
}));
mock.module('../../src/supervisor/index.js', () => ({
  ...realSupervisorSnapshot,
  validateWorkerPidFile: () => 'alive',
  readOwnedWorkerPidInfo: () => ({ pid: 4242, port: 0, startedAt: new Date(0).toISOString() }),
}));
mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  ...realProcessManagerSnapshot,
  spawnDetachedWorkerDaemon: (runtimePath: string) => {
    spawnCalls.push(runtimePath);
    workerUp = true;
    return 4343;
  },
}));
mock.module('../../src/shared/kill-process-tree.js', () => ({
  ...realKillProcessTreeSnapshot,
  killProcessTree: (pid: number) => {
    killCalls.push(pid);
    return Promise.resolve();
  },
}));
mock.module('../../src/shared/port-reclaim.js', () => ({
  ...realPortReclaimSnapshot,
  reclaimGhostListeningPort: () => Promise.resolve({ reclaimed: false, reason: 'not-supported', killedPids: [] }),
}));
mock.module('../../src/shared/worker-spawn-gate.js', () => ({
  ...realSpawnGateSnapshot,
  acquireSpawnLock: () => true,
  releaseSpawnLock: () => {},
}));

afterAll(() => {
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
  mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
  mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
  mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
  mock.module('../../src/shared/kill-process-tree.js', () => realKillProcessTreeSnapshot);
  mock.module('../../src/shared/port-reclaim.js', () => realPortReclaimSnapshot);
  mock.module('../../src/shared/worker-spawn-gate.js', () => realSpawnGateSnapshot);
});

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-autostart=${Date.now()}-${Math.random()}`);
}

function jsonResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function hookFailureCount(): number {
  const statePath = join(DATA_DIR, 'state', 'hook-failures.json');
  if (!existsSync(statePath)) return 0;
  try {
    return Number((JSON.parse(readFileSync(statePath, 'utf-8')) as { consecutiveFailures?: unknown }).consecutiveFailures ?? 0);
  } catch {
    return 0;
  }
}

describe('isWorkerAutostartDisabled', () => {
  it('is disabled only by an explicit false', () => {
    expect(isWorkerAutostartDisabled({ CLAUDE_MEM_WORKER_AUTOSTART: 'false' })).toBe(true);
    expect(isWorkerAutostartDisabled({ CLAUDE_MEM_WORKER_AUTOSTART: ' FALSE ' })).toBe(true);
    expect(isWorkerAutostartDisabled({ CLAUDE_MEM_WORKER_AUTOSTART: 'true' })).toBe(false);
    expect(isWorkerAutostartDisabled({ CLAUDE_MEM_WORKER_AUTOSTART: '' })).toBe(false);
    expect(isWorkerAutostartDisabled({})).toBe(false);
  });
});

describe('CLAUDE_MEM_WORKER_AUTOSTART opt-out in the hook path', () => {
  const originalFetch = global.fetch;
  const originalScript = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  let scriptDir: string;

  beforeEach(() => {
    settings = {};
    workerUp = true;
    versionMatch = { matches: true, pluginVersion: '13.4.1', workerVersion: '13.4.1' };
    spawnCalls.length = 0;
    killCalls.length = 0;
    scriptDir = mkdtempSync(join(tmpdir(), 'claude-mem-autostart-'));
    const scriptPath = join(scriptDir, 'worker-service.cjs');
    writeFileSync(scriptPath, '');
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = scriptPath;
    global.fetch = mock((url: string | URL | Request) => {
      if (!workerUp) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/health')) return Promise.resolve(jsonResponse({ version: versionMatch.workerVersion, uptime: 10 }));
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalScript === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalScript;
    rmSync(scriptDir, { recursive: true, force: true });
  });

  it('still uses a worker that is already running', async () => {
    settings = { CLAUDE_MEM_WORKER_AUTOSTART: 'false' };
    const workerUtils = await importWorkerUtilsFresh();

    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(true);
    expect(spawnCalls).toHaveLength(0);
  });

  it('never lazy-spawns, and a down worker skips quietly without feeding the fail-loud counter', async () => {
    settings = { CLAUDE_MEM_WORKER_AUTOSTART: 'false' };
    workerUp = false;
    const before = hookFailureCount();
    const workerUtils = await importWorkerUtilsFresh();

    const result = await workerUtils.executeWithWorkerFallback('/api/sessions/observations', 'POST', {});

    expect(workerUtils.isWorkerFallback(result)).toBe(true);
    expect((result as { reason?: string }).reason).toBe('worker_autostart_disabled');
    expect(spawnCalls).toHaveLength(0);
    expect(hookFailureCount()).toBe(before);
  });

  it('never recycles a mismatched worker it did not start; it uses it as is', async () => {
    settings = { CLAUDE_MEM_WORKER_AUTOSTART: 'false' };
    versionMatch = { matches: false, pluginVersion: '13.4.1', workerVersion: '13.3.0' };
    const workerUtils = await importWorkerUtilsFresh();

    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(true);
    expect(killCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it('keeps the default: with AUTOSTART unset a down worker is lazy-spawned', async () => {
    settings = {};
    workerUp = false;
    const workerUtils = await importWorkerUtilsFresh();

    expect(await workerUtils.ensureWorkerAliveOnce()).toBe(true);
    expect(spawnCalls).toHaveLength(1);
  });
});
