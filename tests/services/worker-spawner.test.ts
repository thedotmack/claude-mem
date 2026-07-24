import { describe, it, expect, mock } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HOOK_TIMEOUTS } from '../../src/shared/hook-constants.js';

// Isolate the Windows spawn-cooldown marker (.worker-start-attempted) from the
// real ~/.claude-mem so spawning in one test cannot cooldown-block the next.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-spawner-test-'));
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

const processManager = {
  cleanStalePidFile: mock(() => 'dead' as 'alive' | 'dead'),
  getPlatformTimeout: mock((timeout: number) => timeout),
  spawnDaemon: mock(() => 2147483647),
  removePidFile: mock(() => {}),
  touchPidFile: mock(() => {}),
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

mock.module('../../src/services/infrastructure/ProcessManager.js', () => processManager);
mock.module('../../src/services/infrastructure/HealthMonitor.js', () => healthMonitor);
mock.module('../../src/shared/worker-spawn-gate.js', () => spawnGate);

const { ensureWorkerStarted } = await import('../../src/services/worker-spawner.js');

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
  processManager.removePidFile.mockClear();
  processManager.touchPidFile.mockClear();
  healthMonitor.isPortInUse.mockReset();
  healthMonitor.isPortInUse.mockResolvedValue(false);
  healthMonitor.waitForHealth.mockReset();
  healthMonitor.waitForHealth.mockResolvedValue(false);
  healthMonitor.waitForReadiness.mockReset();
  healthMonitor.waitForReadiness.mockResolvedValue(false);
  spawnGate.acquireSpawnLock.mockReset();
  spawnGate.acquireSpawnLock.mockReturnValue(true);
  spawnGate.releaseSpawnLock.mockReset();
  rmSync(join(TEST_DATA_DIR, '.worker-start-attempted'), { force: true });
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

  it('self-heals when a live PID never becomes ready before timeout (#3224)', async () => {
    resetMocks();
    // 'alive' once for the initial PID-file check; after removePidFile() the
    // post-spawn readiness-timeout re-check sees the cleared file as 'dead'.
    processManager.cleanStalePidFile.mockReturnValueOnce('alive');

    const result = await ensureWorkerStarted(39003, import.meta.filename);

    expect(processManager.removePidFile).toHaveBeenCalled();
    expect(healthMonitor.waitForReadiness).toHaveBeenCalledWith(39003, HOOK_TIMEOUTS.READINESS_WAIT);
    // After clearing the stale PID claim, spawn proceeds instead of stuck warming.
    expect(processManager.spawnDaemon).toHaveBeenCalled();
    expect(result).toBe('dead');
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

const WORKER_SPAWNER_PATH = join(import.meta.dir, '../../src/services/worker-spawner.ts');
const workerSpawnerSource = readFileSync(WORKER_SPAWNER_PATH, 'utf-8');

describe('ensureWorkerStarted stale PID self-heal (#3224)', () => {
  it('clears the PID file and continues spawn when a live PID never becomes healthy', () => {
    expect(workerSpawnerSource).toContain('removePidFile()');
    expect(workerSpawnerSource).toContain(
      'PID file claims a live process but worker port never became healthy'
    );
    // Regression: the old branch returned warming and permanently blocked
    // lazy-spawn / self-heal when worker.pid was stale or PID-reused.
    expect(workerSpawnerSource).not.toContain(
      'Live PID detected but worker did not become ready before timeout'
    );
  });
});
