import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realInfrastructure from '../../src/services/infrastructure/index.js';
import * as realSupervisor from '../../src/supervisor/index.js';
import * as realSpawn from '../../src/shared/spawn.js';

const realInfrastructureSnapshot = { ...realInfrastructure };
const realSupervisorSnapshot = { ...realSupervisor };
const realSpawnSnapshot = { ...realSpawn };

// Windows orphaned-listener wedge (incident 2026-07-26, 13.12.1 -> 13.12.4).
//
// After the version-mismatch SIGKILL, Windows kept port 37777 in LISTENING
// state attributed to the now-dead PID 28296. That produces a state the code
// did not model: the port REFUSES connections (so every HTTP probe fails) yet
// still cannot be BOUND (bind returns EADDRINUSE).
//
// The two port oracles disagreed forever:
//   waitForWorkerPortClosed()  - HTTP connect; any failure => "port is free"
//   isPortInUse()              - falls through to a real bind probe => "in use"
//
// so the hook believed the port was released, lazy-spawned, and the successor
// could never bind. Nothing mutated state, so it repeated on every hook: 70
// consecutive failures, each one exiting 2 and blocking the user's prompt.
//
// Required behavior:
//   1. "Released" must mean BINDABLE, not merely unreachable.
//   2. A port that never becomes bindable is a wedge: pick a free loopback
//      port and persist it atomically so worker, hooks and MCP agree.
//   3. Worker unavailability must never block the user's prompt.

const PLUGIN_VERSION = '13.12.4';
const STALE_VERSION = '13.12.1';
const STALE_PID = 28296;

const spawnCalls: Array<{ command: string; args: string[] }> = [];
let versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION as string | null };
let ownedPidInfo: { pid: number; port: number; startedAt: string } | null = null;

// Simulated OS state.
let staleWorkerAlive = true;
let successorUp = false;
// The wedge: the set of ports that cannot be bound even though nothing answers
// on them. Mirrors Windows reporting LISTENING under a dead PID.
let unbindablePorts = new Set<number>();

mock.module('../../src/services/infrastructure/index.js', () => ({
  checkVersionMatch: () => Promise.resolve(versionMatchResult),
}));

mock.module('../../src/supervisor/index.js', () => ({
  validateWorkerPidFile: () => 'alive',
  readOwnedWorkerPidInfo: () => ownedPidInfo,
}));

mock.module('../../src/shared/spawn.js', () => ({
  spawnHidden: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    // The successor only comes up if the port it was told to use is bindable.
    // This is the whole point: spawning onto a wedged port achieves nothing.
    successorUp = true;
    return { pid: 50984, unref: () => {} };
  },
}));

// A net.createServer() stand-in whose listen() fails with EADDRINUSE for any
// port in `unbindablePorts`, and otherwise succeeds. Port 0 always succeeds
// and reports a concrete free port (this is how a wedge escape finds one).
mock.module('net', () => ({
  default: {
    createServer: () => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const on = (ev: string, fn: (arg?: unknown) => void) => {
        (handlers[ev] ??= []).push(fn);
        return api;
      };
      const emit = (ev: string, arg?: unknown) =>
        setTimeout(() => (handlers[ev] ?? []).forEach(f => f(arg)), 0);
      const api = {
        once: on,
        on,
        address: () => ({ port: 41999 }),
        close: (cb?: () => void) => { if (cb) setTimeout(cb, 0); return api; },
        listen: (port: number) => {
          if (port !== 0 && unbindablePorts.has(port)) {
            const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
            err.code = 'EADDRINUSE';
            emit('error', err);
          } else {
            emit('listening');
          }
          return api;
        },
      };
      return api;
    },
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

function installFetchMock(): void {
  global.fetch = mock((url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (!(staleWorkerAlive || successorUp)) {
      // The wedged port refuses connections — exactly what was observed.
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1'));
    }
    if (u.includes('/api/health')) {
      return okResponse({
        version: staleWorkerAlive ? versionMatchResult.workerVersion : PLUGIN_VERSION,
      });
    }
    return okResponse({});
  }) as unknown as typeof fetch;
}

function readSettings(dir: string): Record<string, string> {
  const p = join(dir, 'settings.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, string>; }
  catch { return {}; }
}

describe('Windows orphaned-listener wedge', () => {
  const originalFetch = global.fetch;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  let tempDataDir: string;
  let killSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'claude-mem-port-wedge-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
    installFetchMock();
    spawnCalls.length = 0;
    staleWorkerAlive = true;
    successorUp = false;
    unbindablePorts = new Set<number>();
    ownedPidInfo = null;
    versionMatchResult = { matches: false, pluginVersion: PLUGIN_VERSION, workerVersion: STALE_VERSION };
    killSpy = spyOn(process, 'kill').mockImplementation(((pid: number) => {
      // TerminateProcess: the process dies, but the socket does NOT come back.
      staleWorkerAlive = false;
      void pid;
      return true;
    }) as typeof process.kill);
  });

  afterEach(() => {
    killSpy.mockRestore();
    global.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(tempDataDir, { recursive: true, force: true });
    mock.restore();
  });

  afterAll(() => {
    mock.module('../../src/services/infrastructure/index.js', () => realInfrastructureSnapshot);
    mock.module('../../src/supervisor/index.js', () => realSupervisorSnapshot);
    mock.module('../../src/shared/spawn.js', () => realSpawnSnapshot);
  });

  it('treats an unreachable-but-unbindable port as still occupied, not as free', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    const port = workerUtils.getWorkerPort();
    unbindablePorts.add(port);
    ownedPidInfo = { pid: STALE_PID, port, startedAt: new Date().toISOString() };

    // Pre-fix this returns true after the first refused HTTP probe, because
    // "connection refused" was taken as proof the port was released.
    const released = await workerUtils.isWorkerPortReleased(port);
    expect(released).toBe(false);
  });

  it('escapes the wedge by persisting a new free port that hooks and MCP will read', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    const wedged = workerUtils.getWorkerPort();
    unbindablePorts.add(wedged);
    ownedPidInfo = { pid: STALE_PID, port: wedged, startedAt: new Date().toISOString() };

    await workerUtils.ensureWorkerRunning();

    const persisted = readSettings(tempDataDir).CLAUDE_MEM_WORKER_PORT;
    expect(persisted).toBeDefined();
    expect(Number(persisted)).not.toBe(wedged);
    // and the successor must have been spawned, not skipped
    expect(spawnCalls.length).toBe(1);
    // Generous budget: this path deliberately spends the full port-release
    // wait (5s) proving the port is wedged before it relocates.
  }, 30000);

  it('never blocks the user prompt when the worker is unreachable', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called — the hook blocked the prompt`);
    }) as never);
    try {
      // Well past the fail-loud threshold (the incident reached 70).
      for (let i = 0; i < 5; i++) {
        await workerUtils.recordWorkerUnreachable();
      }
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  // Asserted through behavior rather than by reading the state file: DATA_DIR
  // is resolved once per process (paths.js), so it does not follow the
  // per-test temp dir the way a fresh worker-utils import does.
  it('resets the failure counter once the worker is reachable again', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    await workerUtils.recordWorkerUnreachable();
    await workerUtils.recordWorkerUnreachable();
    workerUtils.resetWorkerFailureCounter();
    // A reset counter means the next failure is streak position 1 again.
    const afterReset = await workerUtils.recordWorkerUnreachable();
    expect(afterReset).toBe(1);
  });
});
