import { describe, it, expect, afterAll, afterEach, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import { paths } from '../../src/shared/paths.js';

// I-4 (bwrap --unshare-pid): process.kill(hostPid, 0) throws ESRCH for a
// perfectly healthy host worker once the caller is inside a PID namespace,
// so validateWorkerPidFile reports 'stale' for a pid file that names a
// process which is really alive — just not visible from here. A caller who
// has already proven the worker healthy over HTTP must not delete that pid
// file out from under the host worker.
//
// Unlike tests/services/worker-spawner.test.ts (which stubs the whole
// ProcessManager module), these tests exercise the REAL cleanStalePidFile /
// validateWorkerPidFile against a real pid file on disk, because the bug is
// a real fs side effect (rmSync) that a fully-mocked cleanStalePidFile can't
// reproduce. Only HealthMonitor (the network probe) is faked.

const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realProcessManagerSnapshot = { ...realProcessManager };

const healthMonitor = {
  isPortInUse: mock(async () => false),
  waitForHealth: mock(async () => false),
  waitForReadiness: mock(async () => false),
};

// cleanStalePidFile/getPlatformTimeout/touchPidFile stay REAL (delegated to
// the snapshot) — the bug under test is a real fs side effect on the real
// validateWorkerPidFile. Only spawnDaemon is stubbed, so the "port genuinely
// down" branch below never actually spawns a bun daemon.
const spawnDaemonMock = mock(() => undefined as number | undefined);
const processManager = {
  ...realProcessManagerSnapshot,
  spawnDaemon: spawnDaemonMock,
};

mock.module('../../src/services/infrastructure/HealthMonitor.js', () => healthMonitor);
mock.module('../../src/services/infrastructure/ProcessManager.js', () => processManager);

afterAll(() => {
  mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
  mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
});

async function importWorkerSpawnerFresh() {
  return import(`../../src/services/worker-spawner.js?worker-spawner-pidns=${Date.now()}-${Math.random()}`);
}

// Non-existent (well out of the kernel's pid range) so a real (non-namespaced)
// verifyPidFileOwnership also reports it dead — the same fixture the
// pre-existing supervisor test at tests/supervisor/index.test.ts uses for
// "returns 'stale' when PID file references a dead process". Under a real
// pid namespace the *live* host pid would ALSO read back as ESRCH-dead here;
// this fixture stands in for that without needing an actual namespace.
const DEAD_PID = 2147483647;

function writePidFile(port: number): void {
  const pidFilePath = paths.workerPid();
  mkdirSync(require('path').dirname(pidFilePath), { recursive: true });
  writeFileSync(pidFilePath, JSON.stringify({
    pid: DEAD_PID,
    port,
    startedAt: new Date().toISOString(),
  }));
}

describe('ensureWorkerStarted — stale pid file but healthy port (I-4)', () => {
  afterEach(() => {
    healthMonitor.isPortInUse.mockReset();
    healthMonitor.isPortInUse.mockResolvedValue(false);
    healthMonitor.waitForHealth.mockReset();
    healthMonitor.waitForHealth.mockResolvedValue(false);
    healthMonitor.waitForReadiness.mockReset();
    healthMonitor.waitForReadiness.mockResolvedValue(false);
    const pidFilePath = paths.workerPid();
    if (existsSync(pidFilePath)) rmSync(pidFilePath, { force: true });
  });

  it('keeps the pid file when the pid is unreachable but the port is healthy', async () => {
    const port = 48123;
    writePidFile(port);
    healthMonitor.waitForHealth.mockResolvedValue(true);
    healthMonitor.waitForReadiness.mockResolvedValue(true);

    const { ensureWorkerStarted } = await importWorkerSpawnerFresh();
    const result = await ensureWorkerStarted(port, import.meta.filename);

    expect(result).toBe('ready');
    expect(existsSync(paths.workerPid())).toBe(true);
  });

  it('still removes the pid file when the pid is unreachable and the port is genuinely down', async () => {
    const port = 48124;
    writePidFile(port);
    healthMonitor.waitForHealth.mockResolvedValue(false);
    healthMonitor.waitForReadiness.mockResolvedValue(false);
    healthMonitor.isPortInUse.mockResolvedValue(false);

    const { ensureWorkerStarted } = await importWorkerSpawnerFresh();
    await ensureWorkerStarted(port, import.meta.filename);

    expect(existsSync(paths.workerPid())).toBe(false);
  });
});
