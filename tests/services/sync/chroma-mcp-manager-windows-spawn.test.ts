import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// Regression coverage for issue 2426.
//
// Symptom on Windows: every chroma-mcp tool call closed in ~30 ms with
// `MCP error -32000: Connection closed`. Root cause: the Windows code path
// wrapped the spawn as `cmd.exe /c uvx ...`, and cmd.exe re-parses the argv
// array back into a single command line. The dep-override `--with` arguments
// (`onnxruntime>=1.20`, `protobuf<7`) then parse as I/O redirection
// (`>=1.20` becomes "redirect stdout to file =1.20", `<7` becomes
// "redirect stdin from file 7"), so the Python subprocess never starts.
//
// Fix: drop the Windows-only cmd.exe wrap. Node's spawn (via cross-spawn)
// resolves `uvx` → `uvx.exe` on PATH on Windows the same way every other
// platform does, and argv stays an array so no I/O redirection re-parse fires.

let lastSpawn: { command: string; args: string[] } | null = null;

interface FakeChildProcess {
  pid: number;
  once: () => FakeChildProcess;
  on: () => FakeChildProcess;
}

class FakeTransport {
  static nextPid = 200_000;
  onclose: (() => void) | null = null;
  _process: FakeChildProcess;

  constructor(opts: { command: string; args: string[] }) {
    lastSpawn = { command: opts.command, args: opts.args };
    const pid = FakeTransport.nextPid++;
    const self: FakeChildProcess = {
      pid,
      once: function (this: FakeChildProcess) { return this; },
      on: function (this: FakeChildProcess) { return this; },
    };
    this._process = self;
  }

  async close(): Promise<void> {}
}

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: FakeTransport,
}));

class FakeClient {
  async connect(): Promise<void> {}
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
    get: () => '',
    getInt: () => 0,
    loadFromFile: () => ({}),
  },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
  paths: {
    chroma: () => 'C:\\Users\\test\\.claude-mem\\chroma',
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

mock.module('child_process', () => {
  const original = require('node:child_process');
  return {
    ...original,
    execFile: (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: { stdout: string; stderr: string }) => void
    ) => {
      cb(null, { stdout: '', stderr: '' } as { stdout: string; stderr: string });
    },
    execSync: () => '',
  };
});

const ORIGINAL_PLATFORM = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

const { ChromaMcpManager } = await import('../../../src/services/sync/ChromaMcpManager.js');

describe('ChromaMcpManager Windows spawn (2426)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    lastSpawn = null;
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
  });

  it('spawns uvx directly on Windows (no cmd.exe /c wrapper)', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(lastSpawn).not.toBeNull();
    expect(lastSpawn!.command).toBe('uvx');
    expect(lastSpawn!.args[0]).not.toBe('/c');
    expect(lastSpawn!.args).not.toContain('/c');
  });

  it('passes dep-override version specifiers as argv elements (not as cmd.exe redirection)', async () => {
    const mgr = ChromaMcpManager.getInstance();
    await mgr.callTool('chroma_list_collections', { limit: 1 });

    expect(lastSpawn).not.toBeNull();
    expect(lastSpawn!.args).toContain('--with');
    expect(lastSpawn!.args).toContain('onnxruntime>=1.20');
    expect(lastSpawn!.args).toContain('protobuf<7');
  });
});
