import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realLogger from '../../../src/utils/logger.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realLoggerSnapshot = { ...realLogger };
const realChildProcess = require('node:child_process');

let currentSettings: Record<string, string> = {};

let capturedTransportOpts: { command: string; args: string[] } | null = null;

class FakeChildProcess extends EventEmitter {
  pid = 200_000;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;

  finish(code: number | null): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }

  kill(): boolean {
    this.finish(null);
    return true;
  }
}

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class FakeTransport {
    onclose: (() => void) | null = null;
    stderr = new PassThrough();
    constructor(opts: { command: string; args: string[] }) {
      capturedTransportOpts = { command: opts.command, args: opts.args };
    }
    async close() {}
  },
}));

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    constructor() {}
    async connect() {}
    async callTool() {
      return { content: [{ type: 'text', text: '{}' }] };
    }
    async close() {}
  },
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

mock.module('child_process', () => {
  const original = require('node:child_process');
  return {
    ...original,
    spawn: () => {
      const child = new FakeChildProcess();
      queueMicrotask(() => child.finish(0));
      return child;
    },
    execSync: () => '',
  };
});

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

afterAll(() => {
  ChromaMcpManager.setUvxAvailabilityProbeForTesting(null);
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('child_process', () => realChildProcess);
});

function expectLauncherPrefixBeforeMode(args: string[], mode: 'http' | 'persistent') {
  const fromIdx = args.indexOf('--from');
  expect(fromIdx).toBeGreaterThan(-1);
  expect(args[fromIdx + 1]).toBe('chroma-mcp==0.2.6');
  expect(args[fromIdx + 2]).toBe('chroma-mcp');
  expect(args[fromIdx + 3]).toBe('--client-type');
  expect(args[fromIdx + 4]).toBe(mode);
  expect(args.slice(0, fromIdx)).toEqual([
    '--python', '3.13',
    '--with', 'onnxruntime>=1.20',
    '--with', 'protobuf<7',
  ]);
}

async function assertSslFlag(sslSetting: string | undefined, expectedValue: string) {
  currentSettings = { CLAUDE_MEM_CHROMA_MODE: 'remote' };
  if (sslSetting !== undefined) currentSettings.CLAUDE_MEM_CHROMA_SSL = sslSetting;

  await mgr.callTool('chroma_list_collections', {});

  expect(capturedTransportOpts).not.toBeNull();
  expectLauncherPrefixBeforeMode(capturedTransportOpts!.args, 'http');
  const sslIdx = capturedTransportOpts!.args.indexOf('--ssl');
  expect(sslIdx).not.toBe(-1);
  expect(capturedTransportOpts!.args[sslIdx + 1]).toBe(expectedValue);
}

let mgr: ChromaMcpManager;

describe('ChromaMcpManager SSL flag regression (#1286)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    capturedTransportOpts = null;
    currentSettings = {};
    ChromaMcpManager.setUvxAvailabilityProbeForTesting(() => true);
    mgr = ChromaMcpManager.getInstance();
  });

  it('emits --ssl false when CLAUDE_MEM_CHROMA_SSL=false', async () => {
    await assertSslFlag('false', 'false');
  });

  it('emits --ssl true when CLAUDE_MEM_CHROMA_SSL=true', async () => {
    await assertSslFlag('true', 'true');
  });

  it('defaults --ssl false when CLAUDE_MEM_CHROMA_SSL is not set', async () => {
    await assertSslFlag(undefined, 'false');
  });

  it('omits --ssl entirely in local mode', async () => {
    currentSettings = {
      CLAUDE_MEM_CHROMA_MODE: 'local',
    };

    await mgr.callTool('chroma_list_collections', {});

    expect(capturedTransportOpts).not.toBeNull();
    const args = capturedTransportOpts!.args;
    expect(args).not.toContain('--ssl');
    expectLauncherPrefixBeforeMode(args, 'persistent');
    expect(args).toContain('--client-type');
    expect(args[args.indexOf('--client-type') + 1]).toBe('persistent');
  });
});
