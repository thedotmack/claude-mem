import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realKillProcessTree from '../../src/shared/kill-process-tree.js';
import { logger } from '../../src/utils/logger.js';

// Windows orphaned-listener wedge (incident 2026-07-26, 13.12.1 -> 13.12.4).
//
// After the version-mismatch kill, Windows kept the worker port LISTENING
// under the now-dead PID. That port REFUSES connections (every HTTP probe
// fails) yet still cannot be BOUND (bind returns EADDRINUSE). The release
// check used an HTTP connect, so it read "refused" as "released", lazy-spawned
// a successor that could never listen, and repeated that on every hook.
//
// Required: "released" means BINDABLE. A port that stays unbindable after the
// kill is an orphaned socket: never spawn onto it, and name the fix.

const PLUGIN_VERSION = '13.12.4';
const STALE_VERSION = '13.12.1';
const STALE_PID = 28296;

const spawnCalls: string[] = [];
const killCalls: number[] = [];
let versionMatch = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION as string | null };
let ownedPidInfo: { pid: number; port: number; startedAt: string } | null = null;
let staleWorkerAlive = true;
let successorUp = false;
// What a bind probe on the worker port reports after the kill.
let portAfterKill: 'free' | 'occupied' = 'occupied';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realSupervisorSnapshot = { ...realSupervisor };
const realProcessManagerSnapshot = { ...realProcessManager };
const realKillProcessTreeSnapshot = { ...realKillProcessTree };

mock.module('../../src/services/infrastructure/index.js', () => ({
  ...realInfrastructureSnapshot,
  checkVersionMatch: () => Promise.resolve(versionMatch),
  isPortInUse: () => Promise.resolve(true),
}));
// The barrel re-exports HealthMonitor's bindings, so its stubs repeat here.
mock.module('../../src/services/infrastructure/HealthMonitor.js', () => ({
  ...realHealthMonitorSnapshot,
  checkVersionMatch: () => Promise.resolve(versionMatch),
  isPortInUse: () => Promise.resolve(true),
  classifyPortOccupancy: () => Promise.resolve(staleWorkerAlive ? 'occupied' : portAfterKill),
}));
mock.module('../../src/supervisor/index.js', () => ({
  ...realSupervisorSnapshot,
  validateWorkerPidFile: () => 'alive',
  readOwnedWorkerPidInfo: () => ownedPidInfo,
}));
mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  ...realProcessManagerSnapshot,
  spawnDetachedWorkerDaemon: (runtimePath: string) => {
    spawnCalls.push(runtimePath);
    successorUp = true;
    return 4343;
  },
}));
mock.module('../../src/shared/kill-process-tree.js', () => ({
  ...realKillProcessTreeSnapshot,
  // TerminateProcess: the worker dies; whether its socket comes back is the
  // test's portAfterKill.
  killProcessTree: (pid: number) => {
    killCalls.push(pid);
    staleWorkerAlive = false;
    return Promise.resolve();
  },
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?windows-port-wedge=${Date.now()}-${Math.random()}`);
}

function okResponse(body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe('Windows orphaned-listener wedge after the version recycle (#3416)', () => {
  const originalFetch = global.fetch;
  const originalScript = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  let scriptDir: string;

  beforeEach(() => {
    spawnCalls.length = 0;
    killCalls.length = 0;
    staleWorkerAlive = true;
    successorUp = false;
    portAfterKill = 'occupied';
    versionMatch = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    scriptDir = mkdtempSync(join(tmpdir(), 'claude-mem-port-wedge-'));
    const scriptPath = join(scriptDir, 'worker-service.cjs');
    writeFileSync(scriptPath, '');
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = scriptPath;
    global.fetch = mock((url: string | URL | Request) => {
      // The wedged port refuses connections once the stale worker is gone —
      // exactly what was observed.
      if (!(staleWorkerAlive || successorUp)) {
        return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' }));
      }
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/health')) {
        return okResponse({ version: staleWorkerAlive ? STALE_VERSION : PLUGIN_VERSION });
      }
      return okResponse({});
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalScript === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalScript;
    rmSync(scriptDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
    mock.module('../../src/shared/kill-process-tree.js', () => realKillProcessTreeSnapshot);
  });

  it('treats an unreachable-but-unbindable port as still held: no successor spawn, and the fix is named', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };
    const errorSpy = spyOn(logger, 'error');
    try {
      // Pre-fix, the first refused HTTP probe counted as "released" and the
      // successor was spawned onto a port it could never bind.
      expect(await workerUtils.ensureWorkerRunning()).toBe(false);
      expect(killCalls).toEqual([STALE_PID]);
      expect(spawnCalls).toHaveLength(0);
      const stillOpen = errorSpy.mock.calls.find(([, message]) => String(message).includes('still open after SIGKILL'));
      expect(stillOpen?.[2]).toMatchObject({ fix: expect.any(String) });
    } finally {
      errorSpy.mockRestore();
    }
  }, 15000);

  it('spawns the successor once the killed worker\'s port is bindable again', async () => {
    portAfterKill = 'free';
    const workerUtils = await importWorkerUtilsFresh();
    ownedPidInfo = { pid: STALE_PID, port: workerUtils.getWorkerPort(), startedAt: new Date().toISOString() };

    expect(await workerUtils.ensureWorkerRunning()).toBe(true);
    expect(killCalls).toEqual([STALE_PID]);
    expect(spawnCalls).toHaveLength(1);
  });
});
