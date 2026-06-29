import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realLogger from '../../../src/utils/logger.js';
import * as realSupervisor from '../../../src/supervisor/index.ts';
import * as realEnvSanitizer from '../../../src/supervisor/env-sanitizer.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realLoggerSnapshot = { ...realLogger };
const realSupervisorSnapshot = { ...realSupervisor };
const realEnvSanitizerSnapshot = { ...realEnvSanitizer };
const realChildProcess = require('node:child_process');
const realProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalPrewarmTimeout = process.env.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS;

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
let callToolImpl: () => Promise<unknown> = async () => ({
  content: [{ type: 'text', text: '{}' }],
});

class FakeClient {
  closed = false;
  async connect(transport: FakeTransport): Promise<void> {
    await connectImpl(transport);
  }
  async callTool(): Promise<unknown> {
    return await callToolImpl();
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
    loadFromFile: () => ({}),
  },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
  paths: {
    chroma: () => '/tmp/fake-chroma',
    combinedCerts: () => '/tmp/fake-combined-certs.pem',
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
let execSyncCalls = 0;
const prewarmSpawnCalls: Array<{ command: string; args: string[]; child: FakeChildProcess }> = [];
let prewarmSpawnBehavior: 'success' | 'timeout' | 'failure' = 'success';
let prewarmStdout = '';
let prewarmStderr = '';

mock.module('../../../src/supervisor/index.ts', () => ({
  getSupervisor: () => ({
    assertCanSpawn: () => {},
    registerProcess: () => {},
    unregisterProcess: () => {},
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
});

function resetState(): void {
  transportCount = 0;
  transportInstances.length = 0;
  prewarmSpawnCalls.length = 0;
  killTreeCalls.length = 0;
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
});

// Restore the real process.kill once the test module finishes evaluating any
// late-arriving microtasks.
process.on('exit', () => {
  process.kill = realProcessKill;
});
