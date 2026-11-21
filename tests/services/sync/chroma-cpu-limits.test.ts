import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Capture real exports before mock.module mutates the live namespace, then
// restore them in afterAll so mocks never leak across test files.
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realPaths from '../../../src/shared/paths.js';
import * as realLogger from '../../../src/utils/logger.js';
import * as realSupervisor from '../../../src/supervisor/index.ts';
import * as realEnvSanitizer from '../../../src/supervisor/env-sanitizer.js';
import * as realPortReclaim from '../../../src/shared/port-reclaim.js';
import * as realKillProcessTree from '../../../src/shared/kill-process-tree.js';
import * as realSdkClientStdio from '@modelcontextprotocol/sdk/client/stdio.js';
import * as realSdkClientIndex from '@modelcontextprotocol/sdk/client/index.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realPathsSnapshot = { ...realPaths };
const realLoggerSnapshot = { ...realLogger };
const realSupervisorSnapshot = { ...realSupervisor };
const realEnvSanitizerSnapshot = { ...realEnvSanitizer };
const realPortReclaimSnapshot = { ...realPortReclaim };
const realKillProcessTreeSnapshot = { ...realKillProcessTree };
const realSdkClientStdioSnapshot = { ...realSdkClientStdio };
const realSdkClientIndexSnapshot = { ...realSdkClientIndex };
const realChildProcess = require('node:child_process');
const realProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

const tempRoots: string[] = [];
let mockedChromaDir = '';
let mockedSettings: Record<string, unknown> = {};
const logEntries: Array<{ level: string; area: string; message: string; meta?: Record<string, unknown> }> = [];
const prewarmSpawns: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
const transportSpawns: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];

const THREAD_ENV_KEYS = [
  'OMP_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'MKL_NUM_THREADS',
  'VECLIB_MAXIMUM_THREADS',
  'NUMEXPR_NUM_THREADS',
  'RAYON_NUM_THREADS',
  'ORT_INTRA_OP_NUM_THREADS',
  'ORT_INTER_OP_NUM_THREADS',
  'OMP_WAIT_POLICY',
  'TOKENIZERS_PARALLELISM',
] as const;
// The subset the chroma-mcp stack actually reads (see CHROMA_THREAD_COUNT_ENV_VARS).
const CAPPED_ENV_KEYS = [
  'ORT_INTRA_OP_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'VECLIB_MAXIMUM_THREADS',
  'RAYON_NUM_THREADS',
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of [...THREAD_ENV_KEYS, 'ort_intra_op_num_threads', 'UV_CACHE_DIR']) {
  savedEnv[key] = process.env[key];
}

class FakeChildProcess extends EventEmitter {
  pid = 300_000;
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  finish(code: number | null): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
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
    _process = new FakeChildProcess();
    constructor(opts: { command: string; args: string[]; env?: Record<string, string> }) {
      transportSpawns.push({ command: opts.command, args: opts.args, env: opts.env });
    }
    async close() {
      if (this._process.exitCode === null && this._process.signalCode === null) {
        this._process.finish(0);
      }
    }
  },
}));

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    async connect() {}
    async callTool() {
      return { content: [{ type: 'text', text: '{}' }] };
    }
    async close() {}
  },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: () => '',
    getInt: () => 0,
    loadFromFile: () => ({
      CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS: '5000',
      CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS: '600000',
      ...mockedSettings,
    }),
  },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
  paths: {
    chroma: () => mockedChromaDir,
    combinedCerts: () => path.join(mockedChromaDir, 'combined-certs.pem'),
  },
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: (area: string, message: string, meta?: Record<string, unknown>) => logEntries.push({ level: 'info', area, message, meta }),
    debug: (area: string, message: string, meta?: Record<string, unknown>) => logEntries.push({ level: 'debug', area, message, meta }),
    warn: (area: string, message: string, meta?: Record<string, unknown>) => logEntries.push({ level: 'warn', area, message, meta }),
    error: (area: string, message: string, meta?: Record<string, unknown>) => logEntries.push({ level: 'error', area, message, meta }),
    failure: (area: string, message: string, meta?: Record<string, unknown>) => logEntries.push({ level: 'failure', area, message, meta }),
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

mock.module('../../../src/shared/port-reclaim.js', () => ({
  ...realPortReclaimSnapshot,
  reclaimOrphanChromaDataDirWriters: async () => ({ killedPids: [] }),
}));

mock.module('../../../src/shared/kill-process-tree.js', () => ({
  ...realKillProcessTreeSnapshot,
  killProcessTree: async () => {},
  collectDescendantIdentities: async () => [],
  collectDescendantPids: async () => [],
}));

mock.module('child_process', () => {
  const original = require('node:child_process');
  return {
    ...original,
    spawn: (command: string, args: string[], opts?: { env?: Record<string, string> }) => {
      prewarmSpawns.push({ command, args, env: opts?.env });
      const child = new FakeChildProcess();
      queueMicrotask(() => child.finish(0));
      return child;
    },
    execSync: () => '',
  };
});

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

function clearThreadEnvVars(): void {
  for (const key of [...THREAD_ENV_KEYS, 'ort_intra_op_num_threads']) {
    delete process.env[key];
  }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function connect(): Promise<void> {
  await ChromaMcpManager.getInstance().callTool('chroma_list_collections', { limit: 1 });
}

beforeEach(async () => {
  await ChromaMcpManager.reset();
  const root = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-chroma-cpu-'));
  tempRoots.push(root);
  mockedChromaDir = path.join(root, 'chroma');
  process.env.UV_CACHE_DIR = path.join(root, 'uv-cache');
  mockedSettings = {};
  logEntries.length = 0;
  prewarmSpawns.length = 0;
  transportSpawns.length = 0;
  clearThreadEnvVars();
  ChromaMcpManager.setUvxAvailabilityProbeForTesting(() => true);
  ChromaMcpManager.setNiceAvailabilityProbeForTesting(() => false);
  ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => false);
  ChromaMcpManager.setAllowedCpusProbeForTesting(() => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  ChromaMcpManager.setProcSelfStatusPathForTesting(null);
  ChromaMcpManager.setChildExitWaitTimeoutsForTesting(10);
});

afterEach(() => {
  clearThreadEnvVars();
  if (realProcessPlatform) {
    Object.defineProperty(process, 'platform', realProcessPlatform);
  }
});

afterAll(async () => {
  await ChromaMcpManager.reset();
  ChromaMcpManager.setUvxAvailabilityProbeForTesting(null);
  ChromaMcpManager.setNiceAvailabilityProbeForTesting(null);
  ChromaMcpManager.setTasksetAvailabilityProbeForTesting(null);
  ChromaMcpManager.setAllowedCpusProbeForTesting(null);
  ChromaMcpManager.setProcSelfStatusPathForTesting(null);
  ChromaMcpManager.setChildExitWaitTimeoutsForTesting(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (realProcessPlatform) {
    Object.defineProperty(process, 'platform', realProcessPlatform);
  }
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../src/utils/logger.js', () => realLoggerSnapshot);
  mock.module('../../../src/supervisor/index.ts', () => realSupervisorSnapshot);
  mock.module('../../../src/supervisor/env-sanitizer.js', () => realEnvSanitizerSnapshot);
  mock.module('../../../src/shared/port-reclaim.js', () => realPortReclaimSnapshot);
  mock.module('../../../src/shared/kill-process-tree.js', () => realKillProcessTreeSnapshot);
  mock.module('child_process', () => realChildProcess);
  mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => realSdkClientStdioSnapshot);
  mock.module('@modelcontextprotocol/sdk/client/index.js', () => realSdkClientIndexSnapshot);
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ChromaMcpManager.parseLinuxCpuList', () => {
  it('parses ranges, singles, and mixed lists in sorted order', () => {
    expect(ChromaMcpManager.parseLinuxCpuList('0-3')).toEqual([0, 1, 2, 3]);
    expect(ChromaMcpManager.parseLinuxCpuList('4')).toEqual([4]);
    expect(ChromaMcpManager.parseLinuxCpuList('6-7,0,2-3,2')).toEqual([0, 2, 3, 6, 7]);
  });

  it('accepts every CPU ID the Linux kernel can report (0..8191)', () => {
    expect(ChromaMcpManager.parseLinuxCpuList('0-8191')).toHaveLength(8192);
    expect(ChromaMcpManager.parseLinuxCpuList('8191')).toEqual([8191]);
  });

  it('returns [] for empty, malformed, inverted, or out-of-kernel-range specs', () => {
    expect(ChromaMcpManager.parseLinuxCpuList('')).toEqual([]);
    expect(ChromaMcpManager.parseLinuxCpuList('   ')).toEqual([]);
    expect(ChromaMcpManager.parseLinuxCpuList('abc')).toEqual([]);
    expect(ChromaMcpManager.parseLinuxCpuList('4-2')).toEqual([]);
    expect(ChromaMcpManager.parseLinuxCpuList('0-99999')).toEqual([]);
    expect(ChromaMcpManager.parseLinuxCpuList('0,,2')).toEqual([]);
    expect(ChromaMcpManager.parseLinuxCpuList('8192')).toEqual([]);
    expect(ChromaMcpManager.parseLinuxCpuList('99999999999999999999')).toEqual([]);
  });
});

describe('chroma-mcp CPU and thread limits (#6365)', () => {
  const MAX_THREADS_KEY = 'CLAUDE_MEM_CHROMA_MAX_THREADS';

  it('is off by default: no thread env vars and no taskset, deferring to the OS scheduler (39f110260)', async () => {
    setPlatform('linux');
    ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
    await connect();

    for (const spawn of [prewarmSpawns[0], transportSpawns[0]]) {
      expect(spawn.command).toBe('uvx');
      for (const key of THREAD_ENV_KEYS) {
        expect(spawn.env![key]).toBeUndefined();
      }
    }
  });

  it('injects only the thread caps the chroma-mcp stack reads when set to 2, in both prewarm and transport env', async () => {
    setPlatform('linux');
    mockedSettings = { [MAX_THREADS_KEY]: '2' };
    await connect();

    for (const spawn of [prewarmSpawns[0], transportSpawns[0]]) {
      expect(spawn.env).toBeDefined();
      for (const key of CAPPED_ENV_KEYS) {
        expect(spawn.env![key]).toBe('2');
      }
      for (const key of THREAD_ENV_KEYS.filter(k => !(CAPPED_ENV_KEYS as readonly string[]).includes(k))) {
        expect(spawn.env![key]).toBeUndefined();
      }
    }
  });

  it('honours a configured CLAUDE_MEM_CHROMA_MAX_THREADS (string or JSON number)', async () => {
    setPlatform('linux');
    mockedSettings = { [MAX_THREADS_KEY]: 4 };
    await connect();

    for (const key of CAPPED_ENV_KEYS) {
      expect(transportSpawns[0].env![key]).toBe('4');
    }
    expect(logEntries.filter(e => e.level === 'warn' && JSON.stringify(e).includes(MAX_THREADS_KEY))).toHaveLength(0);
  });

  it('preserves explicit user thread env vars instead of overwriting them', async () => {
    setPlatform('linux');
    mockedSettings = { [MAX_THREADS_KEY]: '2' };
    process.env.ORT_INTRA_OP_NUM_THREADS = '6';
    await connect();

    expect(transportSpawns[0].env!.ORT_INTRA_OP_NUM_THREADS).toBe('6');
    // Unset vars still receive the configured cap.
    expect(transportSpawns[0].env!.RAYON_NUM_THREADS).toBe('2');
  });

  it('treats existing env var names case-insensitively on win32', async () => {
    setPlatform('win32');
    mockedSettings = { [MAX_THREADS_KEY]: '2' };
    process.env.ort_intra_op_num_threads = '3';
    await connect();

    const env = transportSpawns[0].env!;
    const matchingKeys = Object.keys(env).filter(k => k.toLowerCase() === 'ort_intra_op_num_threads');
    expect(matchingKeys).toEqual(['ort_intra_op_num_threads']);
    expect(env.ort_intra_op_num_threads).toBe('3');
    expect(env.RAYON_NUM_THREADS).toBe('2');
  });

  it('disables both env caps and taskset wrapping when CLAUDE_MEM_CHROMA_MAX_THREADS=0', async () => {
    setPlatform('linux');
    ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
    mockedSettings = { [MAX_THREADS_KEY]: '0' };
    await connect();

    expect(transportSpawns[0].command).not.toBe('taskset');
    expect(transportSpawns[0].args).not.toContain('taskset');
    for (const key of THREAD_ENV_KEYS) {
      expect(transportSpawns[0].env![key]).toBeUndefined();
    }
  });

  for (const bad of ['abc', '-1', '8193', '2.5']) {
    it(`falls back to off with a single warning for invalid value ${JSON.stringify(bad)}`, async () => {
      setPlatform('linux');
      ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
      mockedSettings = { [MAX_THREADS_KEY]: bad };
      await connect();

      expect(transportSpawns[0].command).toBe('uvx');
      expect(transportSpawns[0].env!.ORT_INTRA_OP_NUM_THREADS).toBeUndefined();
      const warnings = logEntries.filter(
        e => e.level === 'warn' && JSON.stringify([e.message, e.meta]).includes(MAX_THREADS_KEY),
      );
      expect(warnings).toHaveLength(1);
    });
  }

  it('wraps Linux prewarm and transport with `taskset -c 0,1` when available', async () => {
    setPlatform('linux');
    mockedSettings = { [MAX_THREADS_KEY]: '2' };
    ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
    await connect();

    expect(transportSpawns[0].command).toBe('taskset');
    expect(transportSpawns[0].args.slice(0, 3)).toEqual(['-c', '0,1', 'uvx']);
    expect(prewarmSpawns[0].command).toBe('taskset');
    expect(prewarmSpawns[0].args.slice(0, 3)).toEqual(['-c', '0,1', 'uvx']);
    expect(prewarmSpawns[0].args.at(-1)).toBe('--help');
  });

  it('composes `nice -n 10 taskset -c 0,1 uvx ...` when both nice and taskset are available on Linux', async () => {
    setPlatform('linux');
    mockedSettings = { [MAX_THREADS_KEY]: '2' };
    ChromaMcpManager.setNiceAvailabilityProbeForTesting(() => true);
    ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
    await connect();

    expect(transportSpawns[0].command).toBe('nice');
    expect(transportSpawns[0].args.slice(0, 6)).toEqual(['-n', '10', 'taskset', '-c', '0,1', 'uvx']);
    expect(prewarmSpawns[0].command).toBe('nice');
    expect(prewarmSpawns[0].args.slice(0, 6)).toEqual(['-n', '10', 'taskset', '-c', '0,1', 'uvx']);
    expect(prewarmSpawns[0].args.at(-1)).toBe('--help');
  });

  it('picks CPUs from the process allowed cpuset (container-safe, never hardcodes CPU 0)', async () => {
    setPlatform('linux');
    mockedSettings = { [MAX_THREADS_KEY]: '2' };
    ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
    ChromaMcpManager.setAllowedCpusProbeForTesting(() => [4, 5, 6, 7]);
    await connect();

    expect(transportSpawns[0].command).toBe('taskset');
    expect(transportSpawns[0].args.slice(0, 3)).toEqual(['-c', '4,5', 'uvx']);
  });

  it('omits taskset when allowed CPUs are already within maxThreads', async () => {
    setPlatform('linux');
    mockedSettings = { [MAX_THREADS_KEY]: '2' };
    ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
    ChromaMcpManager.setAllowedCpusProbeForTesting(() => [0, 1]);
    await connect();

    expect(transportSpawns[0].command).toBe('uvx');
    expect(transportSpawns[0].env!.ORT_INTRA_OP_NUM_THREADS).toBe('2');
  });

  it('omits taskset on darwin and win32 while still applying thread-cap env vars', async () => {
    ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
    mockedSettings = { [MAX_THREADS_KEY]: '2' };

    for (const platform of ['darwin', 'win32'] as const) {
      await ChromaMcpManager.reset();
      transportSpawns.length = 0;
      setPlatform(platform);
      await connect();

      expect(transportSpawns[0].command).not.toBe('taskset');
      expect(transportSpawns[0].args).not.toContain('taskset');
      expect(transportSpawns[0].env!.ORT_INTRA_OP_NUM_THREADS).toBe('2');
      expect(transportSpawns[0].env!.RAYON_NUM_THREADS).toBe('2');
    }
  });

  describe('when the allowed CPU list is unknown, affinity is skipped and logged, never guessed', () => {
    function statusFile(contents: string): string {
      const file = path.join(tempRoots[tempRoots.length - 1], 'status');
      writeFileSync(file, contents);
      return file;
    }

    function affinityWarnings() {
      return logEntries.filter(e => e.level === 'warn' && e.message === 'CPU affinity cap skipped: allowed CPU list unknown');
    }

    beforeEach(() => {
      setPlatform('linux');
      ChromaMcpManager.setTasksetAvailabilityProbeForTesting(() => true);
      ChromaMcpManager.setAllowedCpusProbeForTesting(null);
      mockedSettings = { [MAX_THREADS_KEY]: '2' };
    });

    it('reads Cpus_allowed_list from proc status (container cpuset 4-7)', async () => {
      ChromaMcpManager.setProcSelfStatusPathForTesting(statusFile('Name:\tbun\nCpus_allowed:\tf0\nCpus_allowed_list:\t4-7\n'));
      await connect();

      expect(transportSpawns[0].command).toBe('taskset');
      expect(transportSpawns[0].args.slice(0, 3)).toEqual(['-c', '4,5', 'uvx']);
      expect(affinityWarnings()).toHaveLength(0);
    });

    const unknownCases: Array<[string, () => void, string]> = [
      ['the probe returns no CPUs', () => ChromaMcpManager.setAllowedCpusProbeForTesting(() => []), 'no CPUs'],
      ['proc status is unreadable', () => ChromaMcpManager.setProcSelfStatusPathForTesting(path.join(os.tmpdir(), 'claude-mem-no-such-status')), 'cannot read'],
      ['proc status has no Cpus_allowed_list', () => ChromaMcpManager.setProcSelfStatusPathForTesting(statusFile('Name:\tbun\n')), 'no Cpus_allowed_list'],
      ['Cpus_allowed_list is unparseable', () => ChromaMcpManager.setProcSelfStatusPathForTesting(statusFile('Cpus_allowed_list:\t0-99999\n')), 'cannot parse'],
    ];
    for (const [label, arrange, reason] of unknownCases) {
      it(`launches without taskset and warns once when ${label}`, async () => {
        arrange();
        await connect();

        for (const spawn of [prewarmSpawns[0], transportSpawns[0]]) {
          expect(spawn.command).toBe('uvx');
          expect(spawn.args).not.toContain('taskset');
        }
        // The env caps still apply; only the affinity mask is skipped.
        expect(transportSpawns[0].env!.ORT_INTRA_OP_NUM_THREADS).toBe('2');
        const warnings = affinityWarnings();
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0].meta?.reason)).toContain(reason);
      });
    }
  });
});
