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
let execFileCalls: Array<{ command: string; args: string[]; timeout?: number }> = [];
let connectCalls = 0;
let sequence: string[] = [];
let connectImpl: () => Promise<void> = async () => {};

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
    execFile: (
      command: string,
      args: string[],
      opts: { timeout?: number } | undefined,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      execFileCalls.push({ command, args, timeout: opts?.timeout });
      sequence.push('prewarm');
      cb(null, { stdout: '', stderr: '' });
    },
    execSync: () => '',
  };
});

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
const realExecFileAsync = (ChromaMcpManager as any).execFileAsync;

afterAll(() => {
  (ChromaMcpManager as any).execFileAsync = realExecFileAsync;
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
  execFileCalls = [];
  connectCalls = 0;
  sequence = [];
  (ChromaMcpManager as any).execFileAsync = async (
    command: string,
    args: string[],
    opts: { timeout?: number } | undefined
  ) => {
    execFileCalls.push({ command, args, timeout: opts?.timeout });
    sequence.push('prewarm');
    return { stdout: '', stderr: '' };
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
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].args).toContain('--help');
  });

  it('uses distinct prewarm and connect timeout budgets', async () => {
    currentSettings.CLAUDE_MEM_CHROMA_CONNECT_TIMEOUT_MS = '1500';
    currentSettings.CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS = '2500';
    connectImpl = () => new Promise<void>(() => {});
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow(
      'MCP connection to chroma-mcp timed out after 1500ms'
    );

    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].timeout).toBe(2500);
  });

  it('treats a killed prewarm child as a timeout', async () => {
    (ChromaMcpManager as any).execFileAsync = async () => {
      sequence.push('prewarm');
      throw Object.assign(new Error('Command failed: uvx'), { killed: true });
    };
    const mgr = ChromaMcpManager.getInstance();

    await expect(mgr.callTool('chroma_list_collections', { limit: 1 })).rejects.toThrow(
      'chroma-mcp prewarm timed out after 2000ms'
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
    expect(execFileCalls).toHaveLength(1);
  });
});
