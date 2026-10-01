import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';
import * as realHookIo from '../../src/shared/hook-io.js';
import * as realCliTelemetry from '../../src/services/telemetry/cli-telemetry.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realPortReclaim from '../../src/shared/port-reclaim.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realPortReclaimSnapshot = { ...realPortReclaim };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };
// emitDiagnostic is mocked to a collector below; restoring it in afterAll
// keeps a silenced fail-loud path from leaking into other suites sharing this
// process.
const realHookIoSnapshot = { ...realHookIo };
const realCliTelemetrySnapshot = { ...realCliTelemetry };

// Two states share one signature — port occupied, no owned PID file — and
// must NOT be conflated:
//
//   1. A warming worker. server.listen() runs BEFORE writePidFile(), so a
//      worker that is mid-boot legitimately holds the port with no PID file.
//      It becomes healthy shortly and must be waited for, not written off.
//   2. An orphaned OS socket. Nothing behind the port will ever answer
//      (Windows can leave a LISTEN socket owned by a dead PID). Every spawn
//      is silently refused by the new daemon's duplicate-gate, so hooks loop
//      forever on "worker unreachable".
//
// The only thing separating them is time, so the zombie diagnosis must live
// AFTER the cold-boot wait, never before it.

const spawnCalls: Array<{ command: string; args: string[] }> = [];
let portOccupied = true;
// Health responses to serve in order; the last entry repeats once exhausted.
// `false` = connection refused, `true` = healthy worker.
let healthSequence: boolean[] = [];

// The pre-spawn check is the one place ensureWorkerRunning touches a real port:
// a bind probe (classifyPortOccupancy), then a reclaim attempt when the probe
// finds it held. Unmocked, the outcome depended on whatever held the port, and
// the reclaim could aim at a live worker. Here the port is free, as on a clean
// CI runner, and nothing is ever reclaimed.
//
// One set of probe mocks serves both entry points: infrastructure/index.js
// re-exports HealthMonitor.js, and patching HealthMonitor.js re-links those
// re-exports, so a mock missing from either one would fall back to the real
// probe.
const portProbes = {
  checkVersionMatch: () => Promise.resolve({ matches: true, pluginVersion: '13.16.0', workerVersion: '13.16.0' }),
  isPortInUse: () => Promise.resolve(portOccupied),
  classifyPortOccupancy: () => Promise.resolve('free'),
};

mock.module('../../src/services/infrastructure/index.js', () => portProbes);

mock.module('../../src/services/infrastructure/HealthMonitor.js', () => ({
  ...realHealthMonitorSnapshot,
  ...portProbes,
}));

mock.module('../../src/shared/port-reclaim.js', () => ({
  ...realPortReclaimSnapshot,
  reclaimGhostListeningPort: () => Promise.resolve({ reclaimed: false, reason: 'owner-alive', killedPids: [] }),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'missing',
  readOwnedWorkerPidInfo: () => null,
}));

mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return { pid: 5151, unref: () => {}, on: () => {} };
  },
}));

// The fail-loud diagnostic goes through emitDiagnostic (stderr, never exits);
// the user sees the same text via consumeWorkerOutageNotice's systemMessage.
const failLoudDiagnostics: string[] = [];
mock.module('../../src/shared/hook-io.js', () => ({
  emitDiagnostic: (line: string) => {
    failLoudDiagnostics.push(line);
  },
}));

mock.module('../../src/services/telemetry/cli-telemetry.js', () => ({
  captureCliEvent: () => Promise.resolve(),
}));

/**
 * A port the OS just handed out and nothing holds, so no path in this test can
 * target the default worker port (37700 + uid % 100), which is the machine's
 * real worker whenever one runs. Nothing binds it for real: the port probes
 * above are mocked, so it is never raced either.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-zombie-port=${Date.now()}-${Math.random()}`);
}

function nextHealthy(): boolean {
  if (healthSequence.length === 0) return false;
  return healthSequence.length === 1 ? healthSequence[0] : healthSequence.shift()!;
}

function installFetchMock(): void {
  global.fetch = mock(() => {
    if (!nextHealthy()) {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1'));
    }
    const body = { version: '13.16.0', ready: true, status: 'ok' };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('ensureWorkerRunning — occupied port with no owned PID file', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const originalWorkerPort = process.env.CLAUDE_MEM_WORKER_PORT;
  let tempDataDir: string;

  beforeEach(async () => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-zombie-port-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    process.env.CLAUDE_MEM_WORKER_PORT = String(await freePort());
    spawnCalls.length = 0;
    failLoudDiagnostics.length = 0;
    portOccupied = true;
    healthSequence = [false];
    installFetchMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    }
    if (originalWorkerPort === undefined) {
      delete process.env.CLAUDE_MEM_WORKER_PORT;
    } else {
      process.env.CLAUDE_MEM_WORKER_PORT = originalWorkerPort;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
    mock.module('../../src/shared/hook-io.js', () => realHookIoSnapshot);
    mock.module('../../src/services/telemetry/cli-telemetry.js', () => realCliTelemetrySnapshot);
    mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
    mock.module('../../src/shared/port-reclaim.js', () => realPortReclaimSnapshot);
  });

  // Regression guard for the warming-worker race: a worker that has bound the
  // port but not yet written its PID file must be waited for and reported
  // available, NOT short-circuited as an unrecoverable occupied port.
  it('waits for a warming worker that has bound the port but not yet written its PID file', async () => {
    // Refused on the first probes (still booting), healthy afterwards.
    healthSequence = [false, false, true];

    const workerUtils = await importWorkerUtilsFresh();
    // Every probe below targets the port this test was handed, never a live worker's.
    expect(workerUtils.getWorkerPort()).toBe(Number(process.env.CLAUDE_MEM_WORKER_PORT));
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(true);
  }, 30000);

  it('gives up without spawning again when the port stays occupied and unreachable', async () => {
    healthSequence = [false];

    const workerUtils = await importWorkerUtilsFresh();
    const result = await workerUtils.ensureWorkerRunning();

    expect(result).toBe(false);
  }, 30000);

  // The log file is not where a user looks when their prompts start getting
  // blocked. Once the orphaned-port condition is diagnosed, the fail-loud
  // message must name the port and the fix, not just a failure count.
  it('surfaces the port and its remediation on the fail-loud channel, not only in the log', async () => {
    healthSequence = [false];

    const workerUtils = await importWorkerUtilsFresh();
    expect(await workerUtils.ensureWorkerRunning()).toBe(false);

    // Threshold is 3 consecutive failures before the fail-loud path fires.
    await workerUtils.recordWorkerUnreachable();
    await workerUtils.recordWorkerUnreachable();
    await workerUtils.recordWorkerUnreachable();

    const diagnostic = failLoudDiagnostics.find(line => line.includes('consecutive hooks'));
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain(String(workerUtils.getWorkerPort()));
    expect(diagnostic).toContain('CLAUDE_MEM_WORKER_PORT');

    // The user-visible notice (a synchronous hook's systemMessage) names the fix too.
    const notice = await workerUtils.consumeWorkerOutageNotice('session-zombie-port');
    expect(notice).toContain(String(workerUtils.getWorkerPort()));
    expect(notice).toContain('CLAUDE_MEM_WORKER_PORT');
  }, 30000);
});
