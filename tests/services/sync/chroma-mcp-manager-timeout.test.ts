import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realLogger from '../../../src/utils/logger.js';
import * as realSupervisor from '../../../src/supervisor/index.js';
import * as realEnvSanitizer from '../../../src/supervisor/env-sanitizer.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realLoggerSnapshot = { ...realLogger };
const realSupervisorSnapshot = { ...realSupervisor };
const realEnvSanitizerSnapshot = { ...realEnvSanitizer };
const realChildProcess = require('node:child_process');

let currentSettings: Record<string, string> = {};
let spawnCalls: Array<{ command: string; args: string[] }> = [];
let connectCalls = 0;
let sequence: string[] = [];
let connectImpl: () => Promise<void> = async () => {};

class FakeChild {
  pid = 42;
  stdout = null;
  stderr = null;
  private _handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();

  on(event: string, handler: (...args: unknown[]) => void): this {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event)!.push(handler);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this._handlers.get(event) ?? []) handler(...args);
  }

  unref(): void {}
}

let spawnImpl: () => FakeChild = () => {
  const c = new FakeChild();
  Promise.resolve().then(() => c.emit('close', 0));
  return c;
};

class FakeTransport {
  onclose: (() => void) | null = null;
  _process = {
    pid: 4242,
    once() { return this; },
    on() { return this; },
  };

  constructor(_opts: { command: string; args: string[] }) {}

  async close(): Promise<void> {}
}

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeTransport,
}));

class FakeClient {
  async connect(): Promise<void> {
    connectCalls += 1;
    sequence.push('connect');
    await connectImpl();
  }

  async callTool(): Promise<unknown> {
    return { content: [{ type: 'text', text: '{}' }] };
  }

  async close(): Promise<void> {}
}

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: FakeClient,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => currentSettings[key] ?? '',
    getInt: () => 0,
    loadFromFile: () => currentSettings,
  },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
  paths: {
    chroma: () => '/tmp/fake-chroma',
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

mock.module('../../../src/supervisor/index.js', () => ({
  getSupervisor: () => ({
    assertCanSpawn: () => {},
    registerProcess: () => {},
    unregisterProcess: () => {},
  }),
}));

mock.module('../../../src/supervisor/env-sanitizer.js', () => ({
  sanitizeEnv: (env: NodeJS.ProcessEnv) => env,
}));

mock.module('child_process', () => {
  const original = require('node:child_process');
  return {
    ...original,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      sequence.push('prewarm');
      return spawnImpl();
    },
    execSync: () => '',
  };
});

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../../src/supervisor/index.js', () => realSupervisorSnapshot);
  mock.module('../../../src/supervisor/env-sanitizer.js', () => realEnvSanitizerSnapshot);
  mock.module('child_process', () => realChildProcess);
});

function resetState(): void {
  currentSettings = {
    CLAUDE_MEM_CHROMA_MODE: 'local',
    CLAUDE_MEM_CHROMA_CONNECT_TIMEOUT_MS: '1000',
    CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS: '2000',
  };
  spawnCalls = [];
  connectCalls = 0;
  sequence = [];
  spawnImpl = () => {
    const c = new FakeChild();
    Promise.resolve().then(() => c.emit('close', 0));
    return c;
  };
  connectImpl = async () => {};
}

describe('ChromaMcpManager timeout and prewarm contract (#2897)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    resetState();
  });

  it('prewarms before starting the MCP handshake', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(sequence).toEqual(['prewarm', 'connect']);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('--help');
  });

  it('uses distinct prewarm and connect timeout budgets', async () => {
    currentSettings.CLAUDE_MEM_CHROMA_CONNECT_TIMEOUT_MS = '1500';
    currentSettings.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS = '2500';
    connectImpl = () => new Promise<void>(() => {});
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow(
      'MCP connection to chroma-mcp timed out after 1500ms'
    );

    // Prewarm ran (spawn called) and completed; only the connect timed out.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('--help');
  });

  it('reports a spawn error as prewarm failure', async () => {
    spawnImpl = () => {
      const c = new FakeChild();
      Promise.resolve().then(() => c.emit('error', new Error('spawn uvx ENOENT')));
      return c;
    };
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow(
      'chroma-mcp prewarm failed: spawn uvx ENOENT'
    );
    expect(connectCalls).toBe(0);
  });

  it('rejects with timed-out message when prewarm spawn never completes', async () => {
    spawnImpl = () => new FakeChild(); // never emits 'close' — stuck cold-cache install

    const mgr = ChromaMcpManager.getInstance() as any;
    const killCalls: number[] = [];
    const realKill = (ChromaMcpManager as any).killProcessTree;
    (ChromaMcpManager as any).killProcessTree = async (pid: number) => { killCalls.push(pid); };

    try {
      await expect(
        mgr.runPrewarm({ command: 'uvx', args: ['--help'], env: {}, cwd: '/tmp', timeoutMs: 50 })
      ).rejects.toThrow('chroma-mcp prewarm timed out after 50ms');
      expect(killCalls).toContain(42);
    } finally {
      (ChromaMcpManager as any).killProcessTree = realKill;
    }
  });

  it('rejects with signal message when prewarm child exits with null code', async () => {
    spawnImpl = () => {
      const c = new FakeChild();
      Promise.resolve().then(() => c.emit('close', null));
      return c;
    };
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow(
      'chroma-mcp prewarm terminated by signal'
    );
    expect(connectCalls).toBe(0);
  });

  it('falls back to defaults for unrealistically small timeout settings', () => {
    currentSettings.CLAUDE_MEM_CHROMA_CONNECT_TIMEOUT_MS = '30';
    currentSettings.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS = '30';
    const mgr = ChromaMcpManager.getInstance() as any;

    expect(mgr.readBoundedTimeoutSetting(currentSettings, 'CLAUDE_MEM_CHROMA_CONNECT_TIMEOUT_MS', 60_000)).toBe(60_000);
    expect(mgr.readBoundedTimeoutSetting(currentSettings, 'CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS', 300_000)).toBe(300_000);
  });

  it('memoizes a successful prewarm across reconnects on the same manager instance', async () => {
    const mgr = ChromaMcpManager.getInstance();

    await mgr.callTool('chroma_list_collections', { limit: 1 });
    await mgr.stop();
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(connectCalls).toBe(2);
    expect(spawnCalls).toHaveLength(1);
  });
});
