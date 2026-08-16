import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realLogger from '../../../src/utils/logger.js';
import * as realSupervisor from '../../../src/supervisor/index.ts';
import * as realEnvSanitizer from '../../../src/supervisor/env-sanitizer.js';
import * as realSdkClientStdio from '@modelcontextprotocol/sdk/client/stdio.js';
import * as realSdkClientIndex from '@modelcontextprotocol/sdk/client/index.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realLoggerSnapshot = { ...realLogger };
const realSupervisorSnapshot = { ...realSupervisor };
const realEnvSanitizerSnapshot = { ...realEnvSanitizer };
const realSdkClientStdioSnapshot = { ...realSdkClientStdio };
const realSdkClientIndexSnapshot = { ...realSdkClientIndex };
const realChildProcess = require('node:child_process');
const realProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalPrewarmTimeout = process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS;
const tempRoots: string[] = [];
let mockedChromaDir = '';
let mockedCombinedCertPath = '';
let mockedSettings: Record<string, string> = {};

function resetMockedChromaPaths(): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-chroma-manager-'));
  tempRoots.push(root);
  mockedChromaDir = path.join(root, 'chroma');
  mockedCombinedCertPath = path.join(root, 'combined-certs.pem');
}

resetMockedChromaPaths();

// Singleton enforcement regression coverage for issue #2313.
//
// Hypothesis under test: prior to the fix, ChromaMcpManager could leak its
// chroma-mcp subprocess tree on every reconnect / transport error, accumulating
// 20+ instances per session on Linux because the MCP SDK's transport.close()
// only signals the direct child (uvx). The fix routes every "abandon current
// transport" path through disposeCurrentSubprocess(), which tree-kills via
// killProcessTree() before nulling the handles.

let transportCount = 0;
const transportInstances: Array<FakeTransport> = [];

let nextFakePid = 100_000;
let prewarmKillEmitsClose = true;
let transportCloseEmitsOnclose = false;
let transportKillEmitsOnclose = false;
let rejectPendingConnectOnTransportClose = false;
let pendingConnectReject: ((error: Error) => void) | null = null;

class FakeChildProcess extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.pid = nextFakePid++;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (prewarmKillEmitsClose) {
      this.finish(null, typeof signal === 'string' ? signal : null);
    }
    return true;
  }
}

class FakeTransport {
  onclose: (() => void) | null = null;
  closed = false;
  // Mimic StdioClientTransport's internal `_process` field that the manager
  // pokes into via `(this.transport as unknown as { _process })._process`.
  _process: FakeChildProcess;

  constructor(_opts: { command: string; args: string[] }) {
    transportCount += 1;
    this._process = new FakeChildProcess();
    transportInstances.push(this);
  }

  get stderr(): PassThrough {
    return this._process.stderr;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (transportCloseEmitsOnclose) {
      this.onclose?.();
    }
    if (rejectPendingConnectOnTransportClose && pendingConnectReject) {
      const reject = pendingConnectReject;
      pendingConnectReject = null;
      queueMicrotask(() => reject(new Error('Connection closed')));
    }
  }
}

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeTransport,
}));

let connectImpl: (transport: FakeTransport) => Promise<void> = async () => {};
let callToolImpl: (request?: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown> = async () => ({
  content: [{ type: 'text', text: '{}' }],
});

class FakeClient {
  closed = false;
  async connect(transport: FakeTransport): Promise<void> {
    await connectImpl(transport);
  }
  async callTool(request?: { name: string; arguments?: Record<string, unknown> }): Promise<unknown> {
    return await callToolImpl(request);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: () => '',
    getInt: () => 0,
    loadFromFile: () => ({
      CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS: '5000',
      ...mockedSettings,
    }),
  },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
  paths: {
    chroma: () => mockedChromaDir,
    combinedCerts: () => mockedCombinedCertPath,
  },
}));

const logEntries: Array<{
  level: 'info' | 'debug' | 'warn' | 'error' | 'failure';
  area: string;
  message: string;
  meta?: Record<string, unknown>;
  error?: unknown;
}> = [];

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: (area: string, message: string, meta?: Record<string, unknown>, error?: unknown) => {
      logEntries.push({ level: 'info', area, message, meta, error });
    },
    debug: (area: string, message: string, meta?: Record<string, unknown>, error?: unknown) => {
      logEntries.push({ level: 'debug', area, message, meta, error });
    },
    warn: (area: string, message: string, meta?: Record<string, unknown>, error?: unknown) => {
      logEntries.push({ level: 'warn', area, message, meta, error });
    },
    error: (area: string, message: string, meta?: Record<string, unknown>, error?: unknown) => {
      logEntries.push({ level: 'error', area, message, meta, error });
    },
    failure: (area: string, message: string, meta?: Record<string, unknown>, error?: unknown) => {
      logEntries.push({ level: 'failure', area, message, meta, error });
    },
  },
}));

// Track tree-kill invocations and the transport whose subprocess was killed.
const killTreeCalls: number[] = [];
const deadPids = new Set<number>();
let execSyncCalls = 0;
const prewarmSpawnCalls: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
let prewarmSpawnBehavior: 'success' | 'timeout' | 'failure' = 'success';
let prewarmStdout = '';
let prewarmStderr = '';

// Cross-generation reap fixtures (#3270): entries the mocked supervisor
// registry reports, plus a recorder for unregister calls.
let mockSupervisorRegistryEntries: Array<Record<string, unknown>> = [];
let supervisorUnregisterCalls: string[] = [];

mock.module('../../../src/supervisor/index.ts', () => ({
  getSupervisor: () => ({
    assertCanSpawn: () => {},
    registerProcess: () => {},
    unregisterProcess: (id: string) => {
      supervisorUnregisterCalls.push(id);
      mockSupervisorRegistryEntries = mockSupervisorRegistryEntries.filter(entry => entry.id !== id);
    },
    getRegistry: () => ({
      getAll: () => [...mockSupervisorRegistryEntries],
    }),
  }),
}));

mock.module('../../../src/supervisor/env-sanitizer.js', () => ({
  sanitizeEnv: (env: NodeJS.ProcessEnv) => env,
}));

// Replace child_process.execFile so the static killProcessTree implementation
// can be observed without actually shelling out. We feed pgrep an empty stdout
// (no descendants) so the only signal target is the root pid.
mock.module('child_process', () => {
  const original = require('node:child_process');
  return {
    ...original,
    spawn: (command: string, args: string[]) => {
      const child = new FakeChildProcess();
      prewarmSpawnCalls.push({ command, args, child });
      queueMicrotask(() => {
        if (prewarmStdout) child.stdout.write(prewarmStdout);
        if (prewarmStderr) child.stderr.write(prewarmStderr);
        if (prewarmSpawnBehavior === 'success') {
          child.finish(0);
        } else if (prewarmSpawnBehavior === 'failure') {
          child.finish(1);
        }
      });
      return child;
    },
    execFile: (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: { stdout: string; stderr: string }) => void
    ) => {
      // Bun's promisify path will call this as if it were a Node-style callback.
      if (cmd === 'pgrep') {
        cb(null, { stdout: '', stderr: '' } as any);
      } else {
        cb(null, { stdout: '', stderr: '' } as any);
      }
    },
    execSync: () => {
      execSyncCalls += 1;
      return '';
    },
  };
});

// Stub process.kill so the tree-kill path can record targets without crashing
// the test runner if the synthetic PID happens to collide with a real one.
const realProcessKill = process.kill.bind(process);
const stubbedProcessKill = ((pid: number, signal?: string | number) => {
  if (signal === 0 && deadPids.has(pid)) {
    const error = new Error('ESRCH') as NodeJS.ErrnoException;
    error.code = 'ESRCH';
    throw error;
  }
  if (signal === 0) {
    return true;
  }
  killTreeCalls.push(pid);
  if (transportKillEmitsOnclose) {
    const transport = transportInstances.find(instance => instance._process.pid === pid);
    if (transport && transport._process.exitCode === null && transport._process.signalCode === null) {
      transport._process.finish(null, typeof signal === 'string' ? signal : null);
      transport.onclose?.();
    }
  }
  return true;
}) as typeof process.kill;
process.kill = stubbedProcessKill;

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import {
  getDependencyStatus,
  resetDependencyStatusesForTesting,
} from '../../../src/shared/dependency-health.js';

afterAll(() => {
  ChromaMcpManager.setUvxAvailabilityProbeForTesting(null);
  process.kill = realProcessKill;
  if (originalPrewarmTimeout === undefined) {
    delete process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS;
  } else {
    process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS = originalPrewarmTimeout;
  }
  if (realProcessPlatform) {
    Object.defineProperty(process, 'platform', realProcessPlatform);
  }
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../../src/supervisor/index.ts', () => realSupervisorSnapshot);
  mock.module('../../../src/supervisor/env-sanitizer.js', () => realEnvSanitizerSnapshot);
  mock.module('child_process', () => realChildProcess);
  // The MCP SDK mocks must be re-registered too: leaking FakeClient (no
  // listTools, canned callTool) breaks tests/server/mcp/recall-mcp-server.test.ts
  // whenever the readdir-dependent file order runs it after this file.
  mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => realSdkClientStdioSnapshot);
  mock.module('@modelcontextprotocol/sdk/client/index.js', () => realSdkClientIndexSnapshot);
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function resetState(): void {
  transportCount = 0;
  transportInstances.length = 0;
  prewarmSpawnCalls.length = 0;
  killTreeCalls.length = 0;
  deadPids.clear();
  mockSupervisorRegistryEntries = [];
  supervisorUnregisterCalls = [];
  ChromaMcpManager.setChromaLauncherIdentityProbeForTesting(null);
  logEntries.length = 0;
  execSyncCalls = 0;
  nextFakePid = 100_000;
  prewarmSpawnBehavior = 'success';
  prewarmStdout = '';
  prewarmStderr = '';
  prewarmKillEmitsClose = true;
  transportCloseEmitsOnclose = false;
  transportKillEmitsOnclose = false;
  rejectPendingConnectOnTransportClose = false;
  pendingConnectReject = null;
  connectImpl = async () => {};
  callToolImpl = async () => ({ content: [{ type: 'text', text: '{}' }] });
  mockedSettings = {};
  resetMockedChromaPaths();
  ChromaMcpManager.setUvxAvailabilityProbeForTesting(() => true);
  resetDependencyStatusesForTesting();
  if (originalPrewarmTimeout === undefined) {
    delete process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS;
  } else {
    process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS = originalPrewarmTimeout;
  }
  if (realProcessPlatform) {
    Object.defineProperty(process, 'platform', realProcessPlatform);
  }
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for test condition');
}

function chromaWriterLockPath(): string {
  return path.join(mockedChromaDir, '.claude-mem-chroma-writer.lock');
}

function writeChromaWriterLock(pid: number, ownerId: string): void {
  mkdirSync(mockedChromaDir, { recursive: true });
  writeFileSync(chromaWriterLockPath(), JSON.stringify({
    pid,
    ownerId,
    dataDir: mockedChromaDir,
    acquiredAt: new Date().toISOString(),
    startToken: null,
  }, null, 2));
}

describe('ChromaMcpManager singleton enforcement (#2313)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    resetState();
  });

  it('serializes concurrent ensureConnected() calls into one spawn', async () => {
    const mgr = ChromaMcpManager.getInstance();

    // Five parallel callers race ensureConnected via callTool — only one
    // chroma-mcp subprocess (one transport) should be spawned.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        mgr.callTool('chroma_list_collections', { limit: 1 })
      )
    );

    expect(transportCount).toBe(1);
    expect(prewarmSpawnCalls.length).toBe(1);
  });

  it('serializes Chroma mutations while leaving read-only queries responsive', async () => {
    const mgr = ChromaMcpManager.getInstance();
    const mutationReleases: Array<() => void> = [];
    let activeMutations = 0;
    let maxActiveMutations = 0;

    callToolImpl = async request => {
      if (request?.name === 'chroma_add_documents') {
        activeMutations += 1;
        maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
        await new Promise<void>(resolve => mutationReleases.push(resolve));
        activeMutations -= 1;
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    const firstMutation = mgr.callTool('chroma_add_documents', { ids: ['one'] });
    await waitForCondition(() => mutationReleases.length === 1);
    const secondMutation = mgr.callTool('chroma_add_documents', { ids: ['two'] });
    await Promise.resolve();

    expect(mutationReleases.length).toBe(1);
    await expect(mgr.callTool('chroma_query_documents', { query_texts: ['still responsive'] })).resolves.toEqual({});

    mutationReleases[0]();
    await waitForCondition(() => mutationReleases.length === 2);
    mutationReleases[1]();
    await Promise.all([firstMutation, secondMutation]);

    expect(maxActiveMutations).toBe(1);
  });

  it('bounds the pending mutation queue and leaves rejected writes for backfill', async () => {
    mockedSettings = {
      CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS: '2',
    };
    const mgr = ChromaMcpManager.getInstance();
    const mutationReleases: Array<() => void> = [];

    callToolImpl = async request => {
      if (request?.name === 'chroma_add_documents') {
        await new Promise<void>(resolve => mutationReleases.push(resolve));
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    const firstMutation = mgr.callTool('chroma_add_documents', { ids: ['one'] });
    await waitForCondition(() => mutationReleases.length === 1);
    const secondMutation = mgr.callTool('chroma_add_documents', { ids: ['two'] });

    await expect(mgr.callTool('chroma_add_documents', { ids: ['three'] })).rejects.toThrow('mutation queue is full (2/2)');

    mutationReleases[0]();
    await waitForCondition(() => mutationReleases.length === 2);
    mutationReleases[1]();
    await Promise.all([firstMutation, secondMutation]);
  });

  it('reaps an orphaned chroma-mcp registry entry left by a prior worker generation (#3270)', async () => {
    const orphanPid = 99_777;
    mockSupervisorRegistryEntries = [{
      id: 'chroma-mcp',
      pid: orphanPid,
      type: 'chroma',
      startedAt: '2026-01-01T00:00:00.000Z',
      pgid: orphanPid,
    }];
    // The identity probe shells out to `ps` against a synthetic PID that does
    // not exist on the test host, so stub it the same way the uvx probe is
    // stubbed in resetState().
    const probedPids: number[] = [];
    ChromaMcpManager.setChromaLauncherIdentityProbeForTesting(async (pid) => {
      probedPids.push(pid);
      return true;
    });

    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    // The orphan from the previous generation was tree-killed, its registry
    // entry dropped, and the fresh spawn still proceeded normally.
    expect(probedPids).toContain(orphanPid);
    expect(killTreeCalls).toContain(orphanPid);
    expect(supervisorUnregisterCalls).toContain('chroma-mcp');
    expect(transportCount).toBe(1);
  });

  it('drops a recycled-PID registry entry without signaling the impostor process', async () => {
    const recycledPid = 99_778;
    mockSupervisorRegistryEntries = [{
      id: 'chroma-mcp',
      pid: recycledPid,
      type: 'chroma',
      startedAt: '2026-01-01T00:00:00.000Z',
    }];
    ChromaMcpManager.setChromaLauncherIdentityProbeForTesting(async () => false);

    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(killTreeCalls).not.toContain(recycledPid);
    expect(supervisorUnregisterCalls).toContain('chroma-mcp');
    expect(transportCount).toBe(1);
  });

  it('clears a dead-PID chroma registry entry without probing or signaling it', async () => {
    const deadPid = 99_779;
    deadPids.add(deadPid);
    mockSupervisorRegistryEntries = [{
      id: 'chroma-mcp',
      pid: deadPid,
      type: 'chroma',
      startedAt: '2026-01-01T00:00:00.000Z',
    }];

    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(killTreeCalls).not.toContain(deadPid);
    expect(supervisorUnregisterCalls).toContain('chroma-mcp');
    expect(transportCount).toBe(1);
  });

  it('kills the prior subprocess tree before a reconnect spawn', async () => {
    const mgr = ChromaMcpManager.getInstance();

    // First call: opens transport #1.
    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);
    const firstPid = transportInstances[0]._process.pid;

    // Second call: rig callTool to throw a transport error on the FIRST attempt
    // so the manager runs its reconnect-and-retry path. The retry should
    // dispose the prior subprocess tree (firstPid) before spawning a new one.
    let invocations = 0;
    callToolImpl = async () => {
      invocations += 1;
      if (invocations === 1) {
        throw new Error('Connection closed');
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(transportInstances.length).toBe(2);
    // The first transport's pid must have been signaled by killProcessTree
    // before the second transport spawned.
    expect(killTreeCalls).toContain(firstPid);
  });

  it('ignores kill-triggered onclose while retrying after a transport error', async () => {
    transportKillEmitsOnclose = true;
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);

    let invocations = 0;
    callToolImpl = async () => {
      invocations += 1;
      if (invocations === 1) {
        throw new Error('Connection closed');
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(transportInstances.length).toBe(2);
    expect(logEntries.some(entry => entry.message === 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff')).toBe(false);
  });

  it('stop() disposes state including any pending connecting promise', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);
    const subprocessPid = transportInstances[0]._process.pid;

    await mgr.stop();

    // After stop(), every internal handle should be cleared and the prior
    // subprocess tree must have been signaled.
    expect(killTreeCalls).toContain(subprocessPid);

    // A subsequent ensureConnected must spawn a fresh transport (not reuse
    // a stale one).
    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(2);
  });

  it('does not reconnect an active mutation after shutdown starts', async () => {
    const mgr = ChromaMcpManager.getInstance();
    let rejectMutation: ((error: Error) => void) | null = null;
    callToolImpl = async request => {
      if (request?.name === 'chroma_add_documents') {
        return new Promise((_resolve, reject) => {
          rejectMutation = reject;
        });
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    const pendingMutation = mgr.callTool('chroma_add_documents', { ids: ['one'] });
    await waitForCondition(() => rejectMutation !== null && transportInstances.length === 1);

    await mgr.stop();
    rejectMutation?.(new Error('Connection closed'));

    await expect(pendingMutation).rejects.toThrow('call cancelled during shutdown');
    expect(transportInstances.length).toBe(1);
  });

  it('rejects local mutations that arrive after shutdown without reconnecting', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.stop();
    await expect(mgr.callTool('chroma_add_documents', { ids: ['late'] }))
      .rejects.toThrow('unavailable after shutdown begins');

    expect(transportInstances.length).toBe(0);
    expect(prewarmSpawnCalls.length).toBe(0);
  });

  // The worker's shutdown paths exit the process moments after stopping chroma.
  // #3462's connectionGeneration guards cancel calls that were already in flight
  // when stop() bumped the generation, and acceptingLocalMutations rejects late
  // mutations in local mode — but a READ arriving after the bump captures the new
  // generation, so it passes every guard and reaches connectInternal(), spawning a
  // REPLACEMENT tree that process.exit() then orphans to init. The terminal latch
  // closes that remaining path.
  it('stop({ terminal: true }) refuses to spawn a replacement tree afterwards', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);

    await mgr.stop({ terminal: true });

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow(
      /shutting down/
    );
    // The critical assertion: no second subprocess tree was spawned.
    expect(transportInstances.length).toBe(1);
  });

  // The latch check on entry to ensureConnected() is separated from the spawn by
  // `await waitForUnexpectedCloseCleanup()`. A terminal stop landing inside that
  // window leaves the call resuming with a stale "not stopped" reading, and
  // connectInternal() then captures the POST-bump generation, so #3462's
  // cancellation guards pass too — a replacement tree gets spawned for
  // process.exit() to orphan. Parking the cleanup makes that race deterministic.
  it('stop({ terminal: true }) landing mid-ensureConnected still blocks the spawn', async () => {
    const managerForTesting = ChromaMcpManager as unknown as typeof ChromaMcpManager & {
      killProcessTree: (pid: number) => Promise<void>;
    };
    const originalKillProcessTree = managerForTesting.killProcessTree;
    const cleanupStartedForPids: number[] = [];
    let finishCleanup: (() => void) | null = null;

    managerForTesting.killProcessTree = async (pid: number) => {
      cleanupStartedForPids.push(pid);
      await new Promise<void>(resolve => {
        finishCleanup = resolve;
      });
    };

    try {
      const mgr = ChromaMcpManager.getInstance();

      await mgr.callTool('chroma_list_collections', { limit: 1 });
      expect(transportInstances.length).toBe(1);

      // Unexpected close parks a cleanup promise that ensureConnected() awaits.
      const firstPid = transportInstances[0]._process.pid;
      transportInstances[0].onclose?.();
      await waitForCondition(() => cleanupStartedForPids.includes(firstPid));

      // This call passes the entry check (nothing has latched yet), then blocks
      // on the parked cleanup.
      const reconnecting = mgr.callTool('chroma_list_collections', { limit: 1 });

      // Teardown lands while it is parked. stop() latches synchronously, so
      // firing it un-awaited models the race without deadlocking on the same
      // parked cleanup.
      void mgr.stop({ terminal: true });

      // The unexpected close also armed the 10s reconnect backoff, which would
      // reject the resumed call before it ever reaches the spawn guard under
      // test. Clearing it simulates that backoff having expired, without making
      // the test sleep for 10s — a reachable state, since a session drain
      // outlasts the backoff several times over.
      (mgr as unknown as { lastConnectionFailureTimestamp: number }).lastConnectionFailureTimestamp = 0;

      finishCleanup?.();

      await expect(reconnecting).rejects.toThrow(/shutting down/);
      // The critical assertion: the resumed call spawned no replacement tree.
      expect(transportInstances.length).toBe(1);
    } finally {
      finishCleanup?.();
      managerForTesting.killProcessTree = originalKillProcessTree;
    }
  });

  it('concurrent stop() calls share a single teardown', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    logEntries.length = 0;

    // The worker's shutdown backstop can call stop() while the abandoned
    // performGracefulShutdown reaches the same call. Unmemoized, two disposers
    // interleave over the same client/transport/writer-lock fields.
    await Promise.all([mgr.stop(), mgr.stop(), mgr.stop()]);

    expect(
      logEntries.filter(entry => entry.message === 'Stopping chroma-mcp MCP connection').length
    ).toBe(1);
  });

  it('stop() ignores close-triggered onclose from an intentionally closed transport', async () => {
    transportCloseEmitsOnclose = true;
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);

    await mgr.stop();

    expect(transportInstances[0].closed).toBe(true);
    expect(logEntries.some(entry => entry.message === 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff')).toBe(false);

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(2);
  });

  it('stop() during a hanging prewarm does not record uvx unavailable or apply reconnect backoff', async () => {
    process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS = '25';
    prewarmSpawnBehavior = 'timeout';
    prewarmKillEmitsClose = false;
    const mgr = ChromaMcpManager.getInstance();

    const pendingCall = mgr.callTool('chroma_list_collections', { limit: 1 });
    await waitForCondition(() => prewarmSpawnCalls.length === 1);

    const prewarmChild = prewarmSpawnCalls[0].child;
    const stopPromise = mgr.stop();

    await expect(pendingCall).rejects.toThrow('connection cancelled during shutdown');
    await stopPromise;

    expect(killTreeCalls).toContain(prewarmChild.pid);
    expect(prewarmChild.killed).toBe(true);
    expect(transportInstances.length).toBe(0);
    expect(transportCount).toBe(0);
    expect(getDependencyStatus('uvx')).toBeNull();
    expect(logEntries.some(entry => entry.message === 'chroma-mcp uvx prewarm failed')).toBe(false);

    prewarmSpawnBehavior = 'success';
    prewarmKillEmitsClose = true;
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(prewarmSpawnCalls.length).toBe(2);
    expect(transportInstances.length).toBe(1);
    expect(getDependencyStatus('uvx')).toBeNull();
  });

  it('stop() during MCP handshake treats SDK Connection closed rejection as cancellation', async () => {
    rejectPendingConnectOnTransportClose = true;
    let connectStarted = false;
    connectImpl = async () => new Promise<void>((_resolve, reject) => {
      connectStarted = true;
      pendingConnectReject = reject;
    });
    const mgr = ChromaMcpManager.getInstance();

    const pendingCall = mgr.callTool('chroma_list_collections', { limit: 1 });
    await waitForCondition(() => connectStarted && pendingConnectReject !== null && transportInstances.length === 1);

    const stopPromise = mgr.stop();

    await expect(pendingCall).rejects.toThrow('connection cancelled during shutdown');
    await stopPromise;

    expect(getDependencyStatus('uvx')).toBeNull();
    expect(logEntries.some(entry => entry.message === 'Connection failed, killing subprocess tree to prevent zombie')).toBe(false);
    expect(logEntries.some(entry => entry.message === 'Connection attempt failed')).toBe(false);

    rejectPendingConnectOnTransportClose = false;
    connectImpl = async () => {};
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(transportInstances.length).toBe(2);
  });

  it('classifies missing uvx before spawning chroma-mcp transport', async () => {
    ChromaMcpManager.setUvxAvailabilityProbeForTesting(() => false);
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow('uvx executable not found');

    expect(transportInstances.length).toBe(0);
    expect(transportCount).toBe(0);
    expect(prewarmSpawnCalls.length).toBe(0);
    expect(getDependencyStatus('uvx')).toMatchObject({
      kind: 'vector_search_unavailable',
      remediation: expect.stringContaining('uv/uvx'),
    });
  });

  it('checks uvx availability before macOS certificate discovery can invoke uvx', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    ChromaMcpManager.setUvxAvailabilityProbeForTesting(() => false);
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow('uvx executable not found');

    expect(transportInstances.length).toBe(0);
    expect(prewarmSpawnCalls.length).toBe(0);
    expect(execSyncCalls).toBe(0);
  });

  it('clears stale uvx dependency status after successful availability preflight', async () => {
    ChromaMcpManager.setUvxAvailabilityProbeForTesting(() => false);
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow('uvx executable not found');
    expect(getDependencyStatus('uvx')?.kind).toBe('vector_search_unavailable');

    await ChromaMcpManager.reset();
    ChromaMcpManager.setUvxAvailabilityProbeForTesting(() => true);
    const repairedMgr = ChromaMcpManager.getInstance();

    await repairedMgr.callTool('chroma_list_collections', { limit: 1 });

    expect(getDependencyStatus('uvx')).toBeNull();
  });

  it('uses the configured prewarm timeout before constructing transport and kills the prewarm tree', async () => {
    process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS = '5';
    prewarmSpawnBehavior = 'timeout';
    prewarmStdout = 'prewarm stdout before hang';
    prewarmStderr = 'prewarm stderr before hang';
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow('prewarm timed out after 5ms');

    expect(prewarmSpawnCalls.length).toBe(1);
    expect(prewarmSpawnCalls[0].args).toContain('--help');
    expect(transportInstances.length).toBe(0);
    expect(transportCount).toBe(0);
    expect(killTreeCalls).toContain(prewarmSpawnCalls[0].child.pid);

    const warning = logEntries.find(entry => entry.message === 'chroma-mcp uvx prewarm failed');
    expect(warning?.meta).toMatchObject({
      timeoutMs: 5,
      stdoutTail: 'prewarm stdout before hang',
      stderrTail: 'prewarm stderr before hang',
    });
    expect(getDependencyStatus('uvx')).toMatchObject({
      kind: 'vector_search_unavailable',
    });

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow('connection in backoff');
    expect(prewarmSpawnCalls.length).toBe(1);
  });

  it('captures a bounded chroma-mcp stderr tail on MCP connect failure', async () => {
    const mgr = ChromaMcpManager.getInstance();
    const stderrPayload = `head-${'x'.repeat(2500)}-stderr-tail-marker`;
    connectImpl = async (transport) => {
      transport.stderr.write(stderrPayload);
      throw new Error('handshake failed');
    };

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow('handshake failed');

    const warning = logEntries.find(entry => entry.message === 'Connection failed, killing subprocess tree to prevent zombie');
    const stderrTail = warning?.meta?.stderrTail;
    expect(typeof stderrTail).toBe('string');
    expect((stderrTail as string).length).toBeLessThanOrEqual(2048);
    expect(stderrTail).toContain('stderr-tail-marker');
    expect(stderrTail).not.toContain('head-');
  });

  it('holds a writer lock for local persistent Chroma and releases it on stop()', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(existsSync(chromaWriterLockPath())).toBe(true);
    const lock = JSON.parse(readFileSync(chromaWriterLockPath(), 'utf-8'));
    expect(lock).toMatchObject({
      pid: process.pid,
      dataDir: path.resolve(mockedChromaDir),
    });
    expect(typeof lock.ownerId).toBe('string');
    expect(getDependencyStatus('chroma')).toBeNull();

    await mgr.stop();

    expect(existsSync(chromaWriterLockPath())).toBe(false);
  });

  it('keeps the writer lock until unexpected-close tree cleanup finishes', async () => {
    const managerForTesting = ChromaMcpManager as unknown as typeof ChromaMcpManager & {
      killProcessTree: (pid: number) => Promise<void>;
    };
    const originalKillProcessTree = managerForTesting.killProcessTree;
    const cleanupStartedForPids: number[] = [];
    let finishCleanup: (() => void) | null = null;

    managerForTesting.killProcessTree = async (pid: number) => {
      cleanupStartedForPids.push(pid);
      await new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
    };

    try {
      const mgr = ChromaMcpManager.getInstance();

      await mgr.callTool('chroma_list_collections', { limit: 1 });
      expect(existsSync(chromaWriterLockPath())).toBe(true);

      const firstPid = transportInstances[0]._process.pid;
      transportInstances[0].onclose?.();

      await waitForCondition(() => cleanupStartedForPids.includes(firstPid));
      expect(existsSync(chromaWriterLockPath())).toBe(true);

      finishCleanup?.();
      await waitForCondition(() => !existsSync(chromaWriterLockPath()));
    } finally {
      finishCleanup?.();
      managerForTesting.killProcessTree = originalKillProcessTree;
    }
  });

  it('refuses to open a second local writer for a live Chroma data dir owner', async () => {
    writeChromaWriterLock(process.pid, 'other-worker-owner');
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow('already owned by PID');

    expect(transportInstances.length).toBe(0);
    expect(getDependencyStatus('chroma')).toMatchObject({
      dependency: 'chroma',
      kind: 'vector_search_unavailable',
      message: expect.stringContaining('already owned by PID'),
    });
  });

  it('replaces a stale Chroma writer lock whose PID is dead', async () => {
    const stalePid = 999_998_311;
    deadPids.add(stalePid);
    writeChromaWriterLock(stalePid, 'dead-worker-owner');
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });

    const lock = JSON.parse(readFileSync(chromaWriterLockPath(), 'utf-8'));
    expect(lock.pid).toBe(process.pid);
    expect(lock.ownerId).not.toBe('dead-worker-owner');
    expect(transportInstances.length).toBe(1);
  });

  it('preserves remote mutation concurrency', async () => {
    mockedSettings = {
      CLAUDE_MEM_CHROMA_MODE: 'remote',
    };
    const mgr = ChromaMcpManager.getInstance();
    const mutationReleases: Array<() => void> = [];
    callToolImpl = async request => {
      if (request?.name === 'chroma_add_documents') {
        await new Promise<void>(resolve => mutationReleases.push(resolve));
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };

    const firstMutation = mgr.callTool('chroma_add_documents', { ids: ['one'] });
    const secondMutation = mgr.callTool('chroma_add_documents', { ids: ['two'] });
    await waitForCondition(() => mutationReleases.length === 2);

    mutationReleases.forEach(release => release());
    await Promise.all([firstMutation, secondMutation]);

    expect(existsSync(chromaWriterLockPath())).toBe(false);
    const connectLog = logEntries.find(entry => entry.message === 'Connecting to chroma-mcp via MCP stdio');
    expect(connectLog?.meta?.args).toContain('--client-type http');
    expect(connectLog?.meta?.args).not.toContain('--data-dir');
  });
});

// Restore the real process.kill once the test module finishes evaluating any
// late-arriving microtasks.
process.on('exit', () => {
  process.kill = realProcessKill;
});
