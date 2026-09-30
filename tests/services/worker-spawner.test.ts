import { describe, it, expect, mock, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HOOK_TIMEOUTS } from '../../src/shared/hook-constants.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realHealthMonitor from '../../src/services/infrastructure/HealthMonitor.js';
import * as realWorkerSpawnGate from '../../src/shared/worker-spawn-gate.js';
import * as realPortReclaim from '../../src/shared/port-reclaim.js';

/**
 * The whole suite runs in one bun process and `mock.module` mutates the shared
 * module registry, so the stubs below leak into every test file that loads
 * after this one (tests/infrastructure/{health-monitor,process-manager}.test.ts
 * import the same modules via src/services/infrastructure/index.js and would
 * silently exercise these fakes). Snapshot the real namespaces before the mocks
 * are installed and put them back in afterAll — same pattern as
 * tests/shared/worker-utils-version-recycle.test.ts.
 */
const realProcessManagerSnapshot = { ...realProcessManager };
const realHealthMonitorSnapshot = { ...realHealthMonitor };
const realWorkerSpawnGateSnapshot = { ...realWorkerSpawnGate };
const realPortReclaimSnapshot = { ...realPortReclaim };

const processManager = {
  cleanStalePidFile: mock(() => 'dead' as 'alive' | 'dead'),
  getPlatformTimeout: mock((timeout: number) => timeout),
  spawnDaemon: mock(() => 2147483647),
  touchPidFile: mock(() => {}),
  removePidFile: mock(() => {}),
  probeWorkerBootFailure: mock((): string | undefined => undefined),
};

const healthMonitor = {
  isPortInUse: mock(async () => false),
  waitForHealth: mock(async () => false),
  waitForReadiness: mock(async () => false),
};

const spawnGate = {
  acquireSpawnLock: mock(() => true),
  releaseSpawnLock: mock(() => {}),
};

// port-reclaim must be stubbed like the rest of the module graph: its
// production implementation shells out to netstat/Get-CimInstance/taskkill,
// which would run for real inside the "port in use" branch of every test
// below. The ghost-recovery behavior itself has dedicated unit coverage in
// tests/shared/port-reclaim.test.ts and a Windows integration gate.
const portReclaim = {
  reclaimGhostListeningPort: mock(async () => ({
    reclaimed: false,
    reason: 'not-supported',
    killedPids: [] as number[],
  })),
};

mock.module('../../src/services/infrastructure/ProcessManager.js', () => processManager);
mock.module('../../src/services/infrastructure/HealthMonitor.js', () => healthMonitor);
mock.module('../../src/shared/worker-spawn-gate.js', () => spawnGate);
mock.module('../../src/shared/port-reclaim.js', () => portReclaim);

afterAll(() => {
  mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
  mock.module('../../src/services/infrastructure/HealthMonitor.js', () => realHealthMonitorSnapshot);
  mock.module('../../src/shared/worker-spawn-gate.js', () => realWorkerSpawnGateSnapshot);
  mock.module('../../src/shared/port-reclaim.js', () => realPortReclaimSnapshot);
});

const { ensureWorkerStarted, getLastWorkerBootFailure } = await import('../../src/services/worker-spawner.js');

type TimedProbe = (port: number, timeout: number) => Promise<boolean>;

async function modelBaseLivePidResult(
  port: number,
  waitForHealthImpl: TimedProbe,
  waitForReadinessImpl: TimedProbe
): Promise<'ready' | 'warming'> {
  const healthy = await waitForHealthImpl(port, HOOK_TIMEOUTS.PORT_IN_USE_WAIT);
  if (!healthy) return 'warming';
  const ready = await waitForReadinessImpl(port, HOOK_TIMEOUTS.READINESS_WAIT);
  return ready ? 'ready' : 'warming';
}

async function modelBaseSpawnResult(
  port: number,
  waitForHealthImpl: TimedProbe,
  waitForReadinessImpl: TimedProbe
): Promise<'ready' | 'warming'> {
  const healthy = await waitForHealthImpl(port, HOOK_TIMEOUTS.POST_SPAWN_WAIT);
  if (!healthy) return 'warming';
  const ready = await waitForReadinessImpl(port, HOOK_TIMEOUTS.READINESS_WAIT);
  return ready ? 'ready' : 'warming';
}

function resetMocks(): void {
  processManager.cleanStalePidFile.mockReset();
  processManager.cleanStalePidFile.mockReturnValue('dead');
  processManager.getPlatformTimeout.mockClear();
  processManager.spawnDaemon.mockReset();
  processManager.spawnDaemon.mockReturnValue(2147483647);
  processManager.touchPidFile.mockClear();
  processManager.removePidFile.mockClear();
  processManager.probeWorkerBootFailure.mockReset();
  processManager.probeWorkerBootFailure.mockReturnValue(undefined);
  healthMonitor.isPortInUse.mockReset();
  healthMonitor.isPortInUse.mockResolvedValue(false);
  healthMonitor.waitForHealth.mockReset();
  healthMonitor.waitForHealth.mockResolvedValue(false);
  healthMonitor.waitForReadiness.mockReset();
  healthMonitor.waitForReadiness.mockResolvedValue(false);
  spawnGate.acquireSpawnLock.mockReset();
  spawnGate.acquireSpawnLock.mockReturnValue(true);
  spawnGate.releaseSpawnLock.mockReset();
}

describe('ensureWorkerStarted startup readiness', () => {
  it('returns ready for a live PID when base would have warmed after the old 3s gate', async () => {
    resetMocks();
    const port = 39001;
    const becomesReadyOnlyAtReadinessBudget: TimedProbe = async (_port, timeout) =>
      timeout >= HOOK_TIMEOUTS.READINESS_WAIT;

    processManager.cleanStalePidFile.mockReturnValue('alive');
    healthMonitor.waitForHealth.mockImplementation(becomesReadyOnlyAtReadinessBudget);
    healthMonitor.waitForReadiness.mockImplementation(becomesReadyOnlyAtReadinessBudget);

    const baseResult = await modelBaseLivePidResult(
      port,
      becomesReadyOnlyAtReadinessBudget,
      becomesReadyOnlyAtReadinessBudget
    );
    const result = await ensureWorkerStarted(port, import.meta.filename);

    expect(baseResult).toBe('warming');
    expect(result).toBe('ready');
    expect(healthMonitor.waitForHealth).not.toHaveBeenCalled();
    expect(healthMonitor.waitForReadiness).toHaveBeenCalledWith(port, HOOK_TIMEOUTS.READINESS_WAIT);
    expect(processManager.spawnDaemon).not.toHaveBeenCalled();
    expect(processManager.touchPidFile).not.toHaveBeenCalled();
  });

  it('returns ready after spawn when base would have warmed after the old 15s gate', async () => {
    resetMocks();
    const port = 39002;
    const becomesReadyOnlyAtReadinessBudget: TimedProbe = async (_port, timeout) =>
      timeout >= HOOK_TIMEOUTS.READINESS_WAIT;

    healthMonitor.waitForHealth.mockImplementation(becomesReadyOnlyAtReadinessBudget);
    healthMonitor.waitForReadiness.mockImplementation(becomesReadyOnlyAtReadinessBudget);

    const baseResult = await modelBaseSpawnResult(
      port,
      becomesReadyOnlyAtReadinessBudget,
      becomesReadyOnlyAtReadinessBudget
    );
    const result = await ensureWorkerStarted(port, import.meta.filename);

    expect(baseResult).toBe('warming');
    expect(result).toBe('ready');
    expect(healthMonitor.waitForHealth).toHaveBeenCalledWith(port, 1000);
    expect(healthMonitor.waitForReadiness).toHaveBeenCalledWith(port, HOOK_TIMEOUTS.READINESS_WAIT);
    expect(healthMonitor.waitForReadiness).toHaveBeenCalledTimes(1);
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(processManager.touchPidFile).toHaveBeenCalledTimes(1);
  });

  it('returns dead when a live PID disappears before readiness comes up', async () => {
    resetMocks();
    let cleanChecks = 0;
    processManager.cleanStalePidFile.mockImplementation(() => {
      cleanChecks += 1;
      return cleanChecks === 1 ? 'alive' : 'dead';
    });

    const result = await ensureWorkerStarted(39003, import.meta.filename);

    expect(result).toBe('dead');
    expect(healthMonitor.waitForReadiness).toHaveBeenCalledWith(39003, HOOK_TIMEOUTS.READINESS_WAIT);
    expect(processManager.spawnDaemon).not.toHaveBeenCalled();
    expect(processManager.touchPidFile).not.toHaveBeenCalled();
  });

  it('returns dead when the spawned worker never becomes ready and no live worker remains', async () => {
    resetMocks();

    const result = await ensureWorkerStarted(39004, import.meta.filename);

    expect(result).toBe('dead');
    expect(healthMonitor.waitForHealth).toHaveBeenCalledWith(39004, 1000);
    expect(healthMonitor.waitForReadiness).toHaveBeenCalledWith(39004, HOOK_TIMEOUTS.READINESS_WAIT);
    expect(processManager.touchPidFile).not.toHaveBeenCalled();
  });

  it('returns dead when the spawn-lock loser never sees a live worker', async () => {
    resetMocks();
    spawnGate.acquireSpawnLock.mockReturnValue(false);

    const result = await ensureWorkerStarted(39005, import.meta.filename);

    expect(result).toBe('dead');
    expect(processManager.spawnDaemon).not.toHaveBeenCalled();
    expect(processManager.touchPidFile).not.toHaveBeenCalled();
  });

  it('keeps unknown occupied ports on the short health path', async () => {
    resetMocks();
    healthMonitor.isPortInUse.mockResolvedValue(true);

    const result = await ensureWorkerStarted(39006, import.meta.filename);

    expect(result).toBe('dead');
    expect(healthMonitor.waitForHealth).toHaveBeenNthCalledWith(1, 39006, 1000);
    expect(healthMonitor.waitForHealth).toHaveBeenNthCalledWith(2, 39006, HOOK_TIMEOUTS.PORT_IN_USE_WAIT);
    expect(healthMonitor.waitForReadiness).not.toHaveBeenCalled();
    expect(processManager.spawnDaemon).not.toHaveBeenCalled();
  });

  it('starts a worker after reclaiming a ghost listener from a dead worker', async () => {
    resetMocks();
    healthMonitor.isPortInUse.mockResolvedValue(true);
    healthMonitor.waitForReadiness.mockResolvedValue(true);
    portReclaim.reclaimGhostListeningPort.mockResolvedValue({
      reclaimed: true,
      killedPids: [3001, 3002],
    });

    const result = await ensureWorkerStarted(39008, import.meta.filename);

    // The ghost is gone, so the launcher must NOT give up: it proceeds to the
    // spawn path like a free port would.
    expect(result).toBe('ready');
    expect(portReclaim.reclaimGhostListeningPort).toHaveBeenCalledWith(39008);
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(healthMonitor.waitForReadiness).toHaveBeenCalledWith(39008, HOOK_TIMEOUTS.READINESS_WAIT);
  });

  it('stays dead when the ghost port cannot be reclaimed', async () => {
    resetMocks();
    healthMonitor.isPortInUse.mockResolvedValue(true);
    portReclaim.reclaimGhostListeningPort.mockResolvedValue({
      reclaimed: false,
      reason: 'owner-alive',
      killedPids: [],
    });

    const result = await ensureWorkerStarted(39009, import.meta.filename);

    expect(result).toBe('dead');
    expect(processManager.spawnDaemon).not.toHaveBeenCalled();
  });

  it('keeps a live PID whose worker answers health but is not ready yet (#3224)', async () => {
    resetMocks();
    processManager.cleanStalePidFile.mockReturnValue('alive');
    healthMonitor.waitForHealth.mockResolvedValue(true);

    const result = await ensureWorkerStarted(39010, import.meta.filename);

    expect(result).toBe('warming');
    expect(processManager.removePidFile).not.toHaveBeenCalled();
    expect(processManager.spawnDaemon).not.toHaveBeenCalled();
  });

  it('clears a live PID that never answers health and spawns when nothing holds the port (#3224)', async () => {
    resetMocks();
    // A reused PID: the process is alive, but no worker answers and the port is free.
    processManager.cleanStalePidFile.mockReturnValue('alive');
    healthMonitor.waitForReadiness
      .mockResolvedValueOnce(false) // waiting on the live PID
      .mockResolvedValueOnce(true); // the freshly spawned worker

    const result = await ensureWorkerStarted(39011, import.meta.filename);

    // Before #3224 this returned 'warming' forever and never spawned.
    expect(result).toBe('ready');
    expect(processManager.removePidFile).toHaveBeenCalledTimes(1);
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('keeps the PID file as reclaim evidence when a live-but-silent worker holds the port (#3224)', async () => {
    resetMocks();
    // A wedged worker of ours: alive, holding the port, never answering health.
    processManager.cleanStalePidFile.mockReturnValue('alive');
    healthMonitor.isPortInUse.mockResolvedValue(true);
    healthMonitor.waitForReadiness
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    portReclaim.reclaimGhostListeningPort.mockResolvedValue({
      reclaimed: true,
      killedPids: [4242],
    });

    const result = await ensureWorkerStarted(39012, import.meta.filename);

    expect(result).toBe('ready');
    expect(portReclaim.reclaimGhostListeningPort).toHaveBeenCalledWith(39012);
    // The reclaim proves ownership through the PID file, so it must still be
    // there when the reclaim runs.
    expect(processManager.removePidFile).not.toHaveBeenCalled();
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('keeps spawn failures dead', async () => {
    resetMocks();
    processManager.spawnDaemon.mockReturnValue(undefined);

    const result = await ensureWorkerStarted(39007, import.meta.filename);

    expect(result).toBe('dead');
    expect(healthMonitor.waitForReadiness).not.toHaveBeenCalled();
    expect(processManager.touchPidFile).not.toHaveBeenCalled();
  });
});

describe('ensureWorkerStarted validation guards', () => {

  it('returns "dead" when workerScriptPath is empty string', async () => {
    const result = await ensureWorkerStarted(39001, '');
    expect(result).toBe('dead');
  });

  it('returns "dead" when workerScriptPath does not exist on disk', async () => {
    const bogusPath = '/tmp/__claude-mem-test-nonexistent-worker-script.cjs';
    const result = await ensureWorkerStarted(39002, bogusPath);
    expect(result).toBe('dead');
  });
});

/**
 * plan-15 step 7 (#2996): the Windows spawn cooldown is keyed to evidence, not
 * time. Only a worker this launcher started that provably crashed on boot (or
 * a launch that failed outright) cools later launchers down; a port-bound
 * failure, a lost spawn lock or an unexplained exit leaves the next launcher
 * free to retry at once. The marker is Windows-only, so the platform is faked.
 */
describe('Windows spawn cooldown keyed to a proven boot crash (plan-15 step 7)', () => {
  const originalPlatform = process.platform;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let dataDir: string;
  const marker = () => join(dataDir, '.worker-start-attempted');

  beforeEach(() => {
    resetMocks();
    portReclaim.reclaimGhostListeningPort.mockReset();
    portReclaim.reclaimGhostListeningPort.mockResolvedValue({ reclaimed: false, reason: 'not-supported', killedPids: [] });
    dataDir = mkdtempSync(join(tmpdir(), 'cmem-spawn-cooldown-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('cools down after the spawned worker provably crashed, and reports the recorded crash', async () => {
    processManager.probeWorkerBootFailure.mockReturnValue('SyntaxError: bad bundle');

    expect(await ensureWorkerStarted(39101, import.meta.filename)).toBe('dead');
    expect(existsSync(marker())).toBe(true);
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);

    // The next launcher inside the window stands down, and still says why.
    expect(await ensureWorkerStarted(39101, import.meta.filename)).toBe('dead');
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(getLastWorkerBootFailure()).toBe('SyntaxError: bad bundle');
  });

  it('cools down after the daemon launch itself failed', async () => {
    processManager.spawnDaemon.mockReturnValue(undefined);

    expect(await ensureWorkerStarted(39102, import.meta.filename)).toBe('dead');
    expect(existsSync(marker())).toBe(true);
  });

  it('retries at once when the worker exited without a reproducible crash', async () => {
    processManager.probeWorkerBootFailure.mockReturnValue(undefined);

    expect(await ensureWorkerStarted(39103, import.meta.filename)).toBe('dead');
    expect(existsSync(marker())).toBe(false);

    await ensureWorkerStarted(39103, import.meta.filename);
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(2);
  });

  it('does not cool down after a port-bound failure: once the port is free it spawns at once', async () => {
    healthMonitor.isPortInUse.mockResolvedValue(true);
    portReclaim.reclaimGhostListeningPort.mockResolvedValue({ reclaimed: false, reason: 'owner-alive', killedPids: [] });

    expect(await ensureWorkerStarted(39104, import.meta.filename)).toBe('dead');
    expect(existsSync(marker())).toBe(false);

    healthMonitor.isPortInUse.mockResolvedValue(false);
    healthMonitor.waitForReadiness.mockResolvedValue(true);
    expect(await ensureWorkerStarted(39104, import.meta.filename)).toBe('ready');
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('does not cool down when another launcher held the spawn lock', async () => {
    spawnGate.acquireSpawnLock.mockReturnValue(false);

    expect(await ensureWorkerStarted(39105, import.meta.filename)).toBe('dead');
    expect(existsSync(marker())).toBe(false);
  });

  it('clears a recorded crash once a reclaim frees the port', async () => {
    writeFileSync(marker(), 'SyntaxError: bad bundle');
    healthMonitor.isPortInUse.mockResolvedValue(true);
    healthMonitor.waitForReadiness.mockResolvedValue(true);
    portReclaim.reclaimGhostListeningPort.mockResolvedValue({ reclaimed: true, killedPids: [3001] });

    expect(await ensureWorkerStarted(39106, import.meta.filename)).toBe('ready');
    expect(processManager.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(existsSync(marker())).toBe(false);
  });
});
