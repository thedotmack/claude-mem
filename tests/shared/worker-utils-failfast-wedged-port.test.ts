import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import net from 'net';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realProcessManager from '../../src/services/infrastructure/ProcessManager.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';
import * as realWorkerSpawnGate from '../../src/shared/worker-spawn-gate.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realProcessManagerSnapshot = { ...realProcessManager };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };
const realWorkerSpawnGateSnapshot = { ...realWorkerSpawnGate };

const spawnHiddenMock = mock(() => ({ unref: mock(() => {}) }));
const validateWorkerPidFileMock = mock(() => 'missing');
const acquireSpawnLockMock = mock(() => true);
const isPortListeningMock = mock(isPortListening);

function isPortListening(port: number, host: string = '127.0.0.1', timeoutMs: number = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

mock.module('../../src/services/infrastructure/index.js', () => ({
  ...realInfrastructureSnapshot,
  checkVersionMatch: () => Promise.resolve({
    matches: true,
    pluginVersion: '13.4.0',
    workerVersion: '13.4.0',
  }),
  isPortListening: isPortListeningMock,
}));

mock.module('../../src/services/infrastructure/ProcessManager.js', () => ({
  ...realProcessManagerSnapshot,
  resolveWorkerRuntimePath: () => 'bun',
}));

mock.module('../../src/supervisor/index.js', () => ({
  ...realSupervisorSnapshot,
  validateWorkerPidFile: validateWorkerPidFileMock,
  readOwnedWorkerPidInfo: () => null,
}));

mock.module('../../src/shared/spawn.js', () => ({
  ...realSpawnSnapshot,
  spawnHidden: spawnHiddenMock,
}));

mock.module('../../src/shared/worker-spawn-gate.js', () => ({
  ...realWorkerSpawnGateSnapshot,
  acquireSpawnLock: acquireSpawnLockMock,
  releaseSpawnLock: () => {},
}));

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-failfast=${Date.now()}-${Math.random()}`);
}

function listenOnEphemeralPort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer(socket => socket.destroy());
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}

function waitForAbort(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (!init?.signal) {
      reject(new Error('missing abort signal'));
      return;
    }

    const abort = () => reject(new DOMException('timed out', 'TimeoutError'));
    if (init.signal.aborted) {
      abort();
      return;
    }

    init.signal.addEventListener('abort', abort, { once: true });
  });
}

describe('ensureWorkerRunning — fail fast on an unhealthy occupied port', () => {
  const originalFetch = global.fetch;
  const originalPort = process.env.CLAUDE_MEM_WORKER_PORT;
  const originalHost = process.env.CLAUDE_MEM_WORKER_HOST;
  const originalScript = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  const originalHealthTimeout = process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS;
  const originalReadinessTimeout = process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS;

  beforeEach(() => {
    spawnHiddenMock.mockClear();
    validateWorkerPidFileMock.mockClear();
    validateWorkerPidFileMock.mockImplementation(() => 'missing');
    acquireSpawnLockMock.mockClear();
    acquireSpawnLockMock.mockImplementation(() => true);
    isPortListeningMock.mockClear();
    isPortListeningMock.mockImplementation(isPortListening);
    process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = 'plugin/scripts/worker-service.cjs';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalPort === undefined) delete process.env.CLAUDE_MEM_WORKER_PORT;
    else process.env.CLAUDE_MEM_WORKER_PORT = originalPort;
    if (originalHost === undefined) delete process.env.CLAUDE_MEM_WORKER_HOST;
    else process.env.CLAUDE_MEM_WORKER_HOST = originalHost;
    if (originalScript === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalScript;
    if (originalHealthTimeout === undefined) delete process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = originalHealthTimeout;
    if (originalReadinessTimeout === undefined) delete process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = originalReadinessTimeout;
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/services/infrastructure/ProcessManager.js', () => realProcessManagerSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
    mock.module('../../src/shared/worker-spawn-gate.js', () => realWorkerSpawnGateSnapshot);
  });

  it('does not spawn when an unhealthy listener already owns the worker port', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    global.fetch = mock(() => {
      if (spawnHiddenMock.mock.calls.length === 0) return Promise.reject(new Error('health timeout'));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      expect(await ensureWorkerRunning()).toBe(false);
      expect(spawnHiddenMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('reuses a recovering worker when health fails once but readiness recovers before fallback', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    let requestCount = 0;
    global.fetch = mock(() => {
      requestCount++;
      if (requestCount === 1) return Promise.reject(new Error('health timeout'));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      expect(await ensureWorkerRunning()).toBe(true);
      expect(spawnHiddenMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('waits for an occupied worker to recover when another launcher already holds the spawn lock', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    acquireSpawnLockMock.mockImplementation(() => false);
    let requestCount = 0;
    global.fetch = mock(() => {
      requestCount++;
      if (requestCount < 3) return Promise.reject(new Error('health timeout'));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      expect(await ensureWorkerRunning()).toBe(true);
      expect(spawnHiddenMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('falls back to lazy-spawn when an occupied port is released while another launcher still holds the spawn lock', async () => {
    const { server, port } = await listenOnEphemeralPort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    let lockChecks = 0;
    acquireSpawnLockMock.mockImplementation(() => {
      lockChecks++;
      return lockChecks > 1;
    });
    let probeChecks = 0;
    isPortListeningMock.mockImplementation(() => {
      probeChecks++;
      return Promise.resolve(probeChecks === 1);
    });
    global.fetch = mock(() => {
      if (spawnHiddenMock.mock.calls.length === 0) return Promise.reject(new Error('health timeout'));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    const result = await ensureWorkerRunning();
    expect(acquireSpawnLockMock).toHaveBeenCalled();
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(true);
  });

  it('returns false when another launcher restores liveness but the worker never becomes ready', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '800';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '1000';
    acquireSpawnLockMock.mockImplementation(() => false);
    let requestCount = 0;
    global.fetch = mock((_url: string, init?: RequestInit) => {
      requestCount++;
      if (requestCount === 1) return Promise.reject(new Error('health timeout'));
      if (requestCount === 2) {
        return new Promise<Response>(resolve => setTimeout(() => resolve({ ok: true, status: 200 } as Response), 500));
      }
      return waitForAbort(init);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      const start = Date.now();
      expect(await ensureWorkerRunning()).toBe(false);
      const elapsed = Date.now() - start;
      expect(spawnHiddenMock).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(1100);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('caps occupied-port recovery waits to the grace budget when readiness hangs', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    let requestCount = 0;
    global.fetch = mock((_url: string, init?: RequestInit) => {
      requestCount++;
      if (requestCount === 1) return Promise.reject(new Error('health timeout'));
      return waitForAbort(init);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      const start = Date.now();
      expect(await ensureWorkerRunning()).toBe(false);
      const elapsed = Date.now() - start;
      expect(spawnHiddenMock).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(2500);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('does not run a trailing occupied-port probe after the lock-holder grace budget expires', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    let requestCount = 0;
    let portChecks = 0;
    isPortListeningMock.mockImplementation((_port: number, _host: string, timeoutMs: number = 500) => {
      portChecks++;
      if (portChecks === 1) return Promise.resolve(true);
      return new Promise(resolve => setTimeout(() => resolve(true), timeoutMs));
    });
    global.fetch = mock((_url: string, init?: RequestInit) => {
      requestCount++;
      if (requestCount === 1) return Promise.reject(new Error('health timeout'));
      return waitForAbort(init);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      const start = Date.now();
      expect(await ensureWorkerRunning()).toBe(false);
      const elapsed = Date.now() - start;
      expect(spawnHiddenMock).not.toHaveBeenCalled();
      expect(isPortListeningMock).toHaveBeenCalledTimes(1);
      expect(elapsed).toBeLessThan(900);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('lazy-spawns once when the occupied port releases during the lock-holder grace wait', async () => {
    process.env.CLAUDE_MEM_WORKER_PORT = '37777';
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    let portChecks = 0;
    isPortListeningMock.mockImplementation(() => Promise.resolve(portChecks++ === 0));
    global.fetch = mock((_url: string, init?: RequestInit) => {
      if (spawnHiddenMock.mock.calls.length > 0) return Promise.resolve({ ok: true, status: 200 } as Response);
      return Promise.reject(new Error('health timeout'));
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      expect(await ensureWorkerRunning()).toBe(true);
      expect(acquireSpawnLockMock).toHaveBeenCalledTimes(2);
      expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
    } finally {
    }
  });

  it('returns false within the occupied-port budget when another launcher holds the spawn lock and health hangs', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    acquireSpawnLockMock.mockImplementation(() => false);
    global.fetch = mock((_url: string, init?: RequestInit) => waitForAbort(init));

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      const start = Date.now();
      expect(await ensureWorkerRunning()).toBe(false);
      const elapsed = Date.now() - start;
      expect(spawnHiddenMock).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(1500);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('recomputes the remaining occupied-port grace budget after a slow TCP probe', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    acquireSpawnLockMock.mockImplementation(() => false);
    let requestCount = 0;
    let portChecks = 0;
    isPortListeningMock.mockImplementation((_port: number, _host: string, timeoutMs: number = 500) => {
      portChecks++;
      if (portChecks === 1) return Promise.resolve(true);
      return new Promise(resolve => setTimeout(() => resolve(true), Math.min(300, timeoutMs)));
    });
    global.fetch = mock((_url: string, init?: RequestInit) => {
      requestCount++;
      if (requestCount === 1) return Promise.reject(new Error('health timeout'));
      return waitForAbort(init);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      const start = Date.now();
      expect(await ensureWorkerRunning()).toBe(false);
      const elapsed = Date.now() - start;
      expect(spawnHiddenMock).not.toHaveBeenCalled();
      expect(isPortListeningMock).toHaveBeenCalledTimes(2);
      expect(elapsed).toBeLessThan(700);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('does not run a trailing occupied-port probe after the lock-loser grace budget expires', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    acquireSpawnLockMock.mockImplementation(() => false);
    let requestCount = 0;
    isPortListeningMock.mockImplementation((_port: number, _host: string, _timeoutMs: number = 500) => Promise.resolve(true));
    global.fetch = mock((_url: string, init?: RequestInit) => {
      requestCount++;
      if (requestCount === 1) return Promise.reject(new Error('health timeout'));
      return waitForAbort(init);
    });

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      const start = Date.now();
      expect(await ensureWorkerRunning()).toBe(false);
      const elapsed = Date.now() - start;
      expect(spawnHiddenMock).not.toHaveBeenCalled();
      expect(isPortListeningMock).toHaveBeenCalledTimes(2);
      expect(elapsed).toBeLessThan(900);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('re-probes a cached false after an occupied listener recovers', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    let recovered = false;
    let fetchCalls = 0;
    global.fetch = mock((_url: string, init?: RequestInit) => {
      fetchCalls++;
      if (recovered) return Promise.resolve({ ok: true, status: 200 } as Response);
      return waitForAbort(init);
    });

    try {
      const { ensureWorkerAliveOnce } = await importWorkerUtilsFresh();
      expect(await ensureWorkerAliveOnce()).toBe(false);
      const firstFetchCalls = fetchCalls;

      recovered = true;
      expect(await ensureWorkerAliveOnce()).toBe(true);
      expect(fetchCalls).toBeGreaterThan(firstFetchCalls);
      expect(spawnHiddenMock).not.toHaveBeenCalled();

      const recoveredFetchCalls = fetchCalls;
      expect(await ensureWorkerAliveOnce()).toBe(true);
      expect(fetchCalls).toBe(recoveredFetchCalls);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('keeps a cached false when the worker port remains free', async () => {
    const { server, port } = await listenOnEphemeralPort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    const fetchMock = mock(() => Promise.reject(new Error('health timeout')));
    global.fetch = fetchMock;
    spawnHiddenMock.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const { ensureWorkerAliveOnce } = await importWorkerUtilsFresh();
    expect(await ensureWorkerAliveOnce()).toBe(false);
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
    const firstFetchCalls = fetchMock.mock.calls.length;

    expect(await ensureWorkerAliveOnce()).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(firstFetchCalls);
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
  });

  it('retries lazy-spawn after an occupied-path false when the listener exits', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    let released = false;
    global.fetch = mock((_url: string, init?: RequestInit) => {
      if (!released && spawnHiddenMock.mock.calls.length === 0) {
        return waitForAbort(init);
      }
      if (released && spawnHiddenMock.mock.calls.length === 0) {
        return Promise.reject(new Error('health timeout'));
      }
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    const { ensureWorkerAliveOnce } = await importWorkerUtilsFresh();
    expect(await ensureWorkerAliveOnce()).toBe(false);
    expect(spawnHiddenMock).not.toHaveBeenCalled();

    released = true;
    await new Promise<void>(resolve => server.close(() => resolve()));

    expect(await ensureWorkerAliveOnce()).toBe(true);
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);

    expect(await ensureWorkerAliveOnce()).toBe(true);
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a released-port lock-loser failure retryable when the other launcher never opens the port', async () => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS = '500';
    process.env.CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS = '500';
    let lockCalls = 0;
    acquireSpawnLockMock.mockImplementation(() => {
      lockCalls++;
      return lockCalls !== 2;
    });
    global.fetch = mock(() => {
      if (spawnHiddenMock.mock.calls.length === 0) return Promise.reject(new Error('health timeout'));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    const { ensureWorkerAliveOnce } = await importWorkerUtilsFresh();
    expect(await ensureWorkerAliveOnce()).toBe(false);
    expect(spawnHiddenMock).not.toHaveBeenCalled();

    await new Promise<void>(resolve => server.close(() => resolve()));

    expect(await ensureWorkerAliveOnce()).toBe(false);
    expect(spawnHiddenMock).not.toHaveBeenCalled();

    expect(await ensureWorkerAliveOnce()).toBe(true);
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);

    expect(await ensureWorkerAliveOnce()).toBe(true);
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
  }, 20000);

  it('still spawns once when health fails and the port is actually free', async () => {
    const { server, port } = await listenOnEphemeralPort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    let healthCalls = 0;
    global.fetch = mock(() => {
      healthCalls++;
      if (healthCalls === 1) return Promise.reject(new Error('health timeout'));
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    expect(await ensureWorkerRunning()).toBe(true);
    expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
  });

  it('reuses a healthy worker without entering the new guard', async () => {
    process.env.CLAUDE_MEM_WORKER_PORT = '37777';
    global.fetch = mock(() => Promise.resolve({ ok: true, status: 200 } as Response));

    const { ensureWorkerRunning } = await importWorkerUtilsFresh();
    expect(await ensureWorkerRunning()).toBe(true);
    expect(spawnHiddenMock).not.toHaveBeenCalled();
  });

  it.each(['stale', 'invalid'] as const)('still spawns when health is ok but the pid file is %s', async (pidStatus) => {
    const { server, port } = await listenOnEphemeralPort();
    process.env.CLAUDE_MEM_WORKER_PORT = String(port);
    let pidChecks = 0;
    validateWorkerPidFileMock.mockImplementation(() => {
      pidChecks++;
      return pidChecks === 1 ? pidStatus : 'missing';
    });
    global.fetch = mock(() => Promise.resolve({ ok: true, status: 200 } as Response));

    try {
      const { ensureWorkerRunning } = await importWorkerUtilsFresh();
      expect(await ensureWorkerRunning()).toBe(true);
      expect(spawnHiddenMock).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
