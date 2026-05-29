import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

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

// Singleton enforcement regression coverage for issue #2313.
//
// Hypothesis under test: prior to the fix, ChromaMcpManager could leak its
// chroma-mcp subprocess tree on every reconnect / transport error, accumulating
// 20+ instances per session on Linux because the MCP SDK's transport.close()
// only signals the direct child (uvx). The fix routes every "abandon current
// transport" path through disposeCurrentSubprocess(), which tree-kills via
// killProcessTree() before nulling the handles.

const ORIGINAL_CLAUDE_MEM_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
const FAKE_DATA_DIR = `/tmp/fake-claude-mem-${process.pid}`;
const FAKE_CHROMA_DIR = path.join(FAKE_DATA_DIR, 'chroma');
const FAKE_CHROMA_LOCK = path.join(FAKE_CHROMA_DIR, '.claude-mem-chroma-mcp.lock');

process.env.CLAUDE_MEM_DATA_DIR = FAKE_DATA_DIR;

let transportCount = 0;
const transportInstances: Array<FakeTransport> = [];

interface FakeChildProcess {
  pid: number;
  once: (event: string, _cb: (...args: unknown[]) => void) => FakeChildProcess;
  on: (event: string, _cb: (...args: unknown[]) => void) => FakeChildProcess;
}

class FakeTransport {
  static nextPid = 100_000;
  onclose: (() => void) | null = null;
  closed = false;
  // Mimic StdioClientTransport's internal `_process` field that the manager
  // pokes into via `(this.transport as unknown as { _process })._process`.
  _process: FakeChildProcess;

  constructor(_opts: { command: string; args: string[] }) {
    transportCount += 1;
    const pid = FakeTransport.nextPid++;
    const child: FakeChildProcess = {
      pid,
      once: function (this: FakeChildProcess) { return this; },
      on: function (this: FakeChildProcess) { return this; },
    };
    this._process = child;
    transportInstances.push(this);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeTransport,
}));

let connectImpl: () => Promise<void> = async () => {};
let callToolImpl: () => Promise<unknown> = async () => ({
  content: [{ type: 'text', text: '{}' }],
});

class FakeClient {
  closed = false;
  async connect(): Promise<void> {
    await connectImpl();
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
    chroma: () => FAKE_CHROMA_DIR,
    combinedCerts: () => '/tmp/fake-combined-certs.pem',
  },
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
  },
}));

// Track tree-kill invocations and the transport whose subprocess was killed.
const killTreeCalls: number[] = [];
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];

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
    execFile: (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      execFileCalls.push({ cmd, args });
      // Bun's promisify path will call this as if it were a Node-style callback.
      if (cmd === 'pgrep') {
        cb(null, '', '');
      } else {
        cb(null, '', '');
      }
    },
    execSync: () => '',
    execFileSync: () => '',
  };
});

// Stub process.kill only while this suite is actively running so the tree-kill
// path can record targets without crashing the test runner if the synthetic PID
// happens to collide with a real one. Restoring in afterEach prevents this
// module-level test double from contaminating later tests in the same Bun worker.
const realProcessKill = process.kill;
const stubbedProcessKill = ((pid: number, _signal?: string | number) => {
  killTreeCalls.push(pid);
  return true;
}) as typeof process.kill;

function installProcessKillStub(): void {
  process.kill = stubbedProcessKill;
}

function restoreProcessKill(): void {
  process.kill = realProcessKill;
}

installProcessKillStub();
const { ChromaMcpManager } = await import('../../../src/services/sync/ChromaMcpManager.js');
const originalKillProcessTree = (ChromaMcpManager as unknown as {
  killProcessTree: (pid: number) => Promise<void>;
}).killProcessTree.bind(ChromaMcpManager);

(ChromaMcpManager as unknown as {
  killProcessTree: (pid: number) => Promise<void>;
}).killProcessTree = async (pid: number) => {
  killTreeCalls.push(pid);
  await originalKillProcessTree(pid);
};

afterAll(() => {
  process.kill = realProcessKill;
  (ChromaMcpManager as unknown as {
    killProcessTree: (pid: number) => Promise<void>;
  }).killProcessTree = originalKillProcessTree;
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../../src/supervisor/index.ts', () => realSupervisorSnapshot);
  mock.module('../../../src/supervisor/env-sanitizer.js', () => realEnvSanitizerSnapshot);
  mock.module('child_process', () => realChildProcess);
});

function resetState(): void {
  try { fs.unlinkSync(FAKE_CHROMA_LOCK); } catch { /* absent */ }
  try { fs.mkdirSync(FAKE_CHROMA_DIR, { recursive: true }); } catch { /* best-effort */ }
  transportCount = 0;
  transportInstances.length = 0;
  killTreeCalls.length = 0;
  execFileCalls.length = 0;
  connectImpl = async () => {};
  callToolImpl = async () => ({ content: [{ type: 'text', text: '{}' }] });
}

function expectTreeKillFor(pid: number): void {
  const taskkillCalled = execFileCalls.some(call =>
    call.cmd === 'taskkill' && call.args.includes(String(pid))
  );
  expect(killTreeCalls.includes(pid) || taskkillCalled).toBe(true);
}

describe('ChromaMcpManager singleton enforcement (#2313)', () => {
  beforeEach(async () => {
    installProcessKillStub();
    await ChromaMcpManager.reset();
    resetState();
  });

  afterEach(async () => {
    try {
      await ChromaMcpManager.reset();
      try { fs.unlinkSync(FAKE_CHROMA_LOCK); } catch { /* absent */ }
    } finally {
      restoreProcessKill();
    }
  });

  afterAll(() => {
    restoreProcessKill();
    try { fs.rmSync(FAKE_DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (ORIGINAL_CLAUDE_MEM_DATA_DIR === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = ORIGINAL_CLAUDE_MEM_DATA_DIR;
    }
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
    expectTreeKillFor(firstPid);
  });

  it('stop() disposes state including any pending connecting promise', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(1);
    const subprocessPid = transportInstances[0]._process.pid;

    await mgr.stop();

    // After stop(), every internal handle should be cleared and the prior
    // subprocess tree must have been signaled.
    expectTreeKillFor(subprocessPid);

    // A subsequent ensureConnected must spawn a fresh transport (not reuse
    // a stale one).
    await mgr.callTool('chroma_list_collections', { limit: 1 });
    expect(transportInstances.length).toBe(2);
  });
});
