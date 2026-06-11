import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import * as realPaths from '../../../src/shared/paths.js';
import * as realLogger from '../../../src/utils/logger.js';
import * as realSupervisor from '../../../src/supervisor/index.ts';
import * as realEnvSanitizer from '../../../src/supervisor/env-sanitizer.js';
const realLoggerSnapshot = { ...realLogger };
const realSupervisorSnapshot = { ...realSupervisor };
const realEnvSanitizerSnapshot = { ...realEnvSanitizer };

const FAKE_CHROMA_DIR = realPaths.paths.chroma();
const FAKE_CHROMA_LOCK = path.join(FAKE_CHROMA_DIR, '.claude-mem-chroma-mcp.lock');

let currentSettings: Record<string, string> = {};

let capturedTransportOpts: { command: string; args: string[] } | null = null;

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class FakeTransport {
    onclose: (() => void) | null = null;
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

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
    dataIn: () => {},
    dataOut: () => {},
    success: () => {},
  },
}));

const { ChromaMcpManager } = await import('../../../src/services/sync/ChromaMcpManager.js');
type ChromaMcpManagerType = InstanceType<typeof ChromaMcpManager>;

afterAll(() => {
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../../src/supervisor/index.ts', () => realSupervisorSnapshot);
  mock.module('../../../src/supervisor/env-sanitizer.js', () => realEnvSanitizerSnapshot);
});

function writeCurrentSettings(): void {
  fs.mkdirSync(FAKE_CHROMA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(realPaths.USER_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(realPaths.USER_SETTINGS_PATH, JSON.stringify(currentSettings, null, 2), 'utf-8');
}

async function assertSslFlag(sslSetting: string | undefined, expectedValue: string) {
  currentSettings = { CLAUDE_MEM_CHROMA_MODE: 'remote' };
  if (sslSetting !== undefined) currentSettings.CLAUDE_MEM_CHROMA_SSL = sslSetting;
  writeCurrentSettings();

  await mgr.callTool('chroma_list_collections', {});

  expect(capturedTransportOpts).not.toBeNull();
  const sslIdx = capturedTransportOpts!.args.indexOf('--ssl');
  expect(sslIdx).not.toBe(-1);
  expect(capturedTransportOpts!.args[sslIdx + 1]).toBe(expectedValue);
}

let mgr: ChromaMcpManagerType;

describe('ChromaMcpManager SSL flag regression (#1286)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    try { fs.unlinkSync(FAKE_CHROMA_LOCK); } catch { /* absent */ }
    fs.mkdirSync(FAKE_CHROMA_DIR, { recursive: true });
    capturedTransportOpts = null;
    currentSettings = {};
    writeCurrentSettings();
    mgr = ChromaMcpManager.getInstance();
  });

  afterEach(async () => {
    await ChromaMcpManager.reset();
    try { fs.unlinkSync(FAKE_CHROMA_LOCK); } catch { /* absent */ }
  });

  afterAll(() => {
    try { fs.rmSync(FAKE_CHROMA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    writeCurrentSettings();

    await mgr.callTool('chroma_list_collections', {});

    expect(capturedTransportOpts).not.toBeNull();
    const args = capturedTransportOpts!.args;
    expect(args).not.toContain('--ssl');
    expect(args).toContain('--client-type');
    expect(args[args.indexOf('--client-type') + 1]).toBe('persistent');
  });
});
