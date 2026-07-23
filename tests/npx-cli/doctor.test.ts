import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
import * as realInstallSetupRuntime from '../../src/npx-cli/install/setup-runtime.js';
import * as realPaths from '../../src/shared/paths.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realInstallSetupRuntimeSnapshot = { ...realInstallSetupRuntime };
const realPathsSnapshot = { ...realPaths };

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: { get: (key: string) => key === 'CLAUDE_MEM_WORKER_HOST' ? '127.0.0.1' : '39999' },
}));
mock.module('../../src/npx-cli/install/setup-runtime.js', () => ({
  getBunVersion: () => '1.2.3',
  getUvVersion: () => '0.8.0',
  isInstallCurrent: () => true,
}));
mock.module('../../src/shared/paths.js', () => ({
  resolveDataDir: () => '/tmp/claude-mem-doctor-test',
}));

import { runDoctorCommand } from '../../src/npx-cli/commands/doctor.js';

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const originalLog = console.log;

afterAll(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  console.log = originalLog;
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../src/npx-cli/install/setup-runtime.js', () => realInstallSetupRuntimeSnapshot);
  mock.module('../../src/shared/paths.js', () => realPathsSnapshot);
});

describe('npx doctor Chroma diagnostics', () => {
  beforeEach(() => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      return new Response(JSON.stringify({
        health: {
          chroma: {
            count: 1,
            lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: null, signal: 'SIGSEGV' },
            chromaMcpVersion: '0.2.6',
            dependencyOverrides: ['onnxruntime>=1.20', 'protobuf<7', 'chromadb==1.0.16'],
          },
        },
      }), { status: 200 });
    }) as typeof fetch;
  });

  it('renders the warn-only exact Chroma child exit detail', async () => {
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    process.exit = (() => undefined) as typeof process.exit;

    await runDoctorCommand();

    const text = output.join('\n');
    expect(text).toContain('Chroma child exits');
    expect(text).toContain('1 (signal SIGSEGV)');
    expect(text).toContain('2026-07-23T12:00:00.000Z');
    expect(text).toContain('chroma-mcp 0.2.6');
    expect(text).toContain('onnxruntime>=1.20, protobuf<7, chromadb==1.0.16');
  });

  it('does not fabricate crash state when the worker is unreachable', async () => {
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    process.exit = (() => undefined) as typeof process.exit;
    globalThis.fetch = mock(async () => { throw new Error('connection refused'); }) as typeof fetch;

    await runDoctorCommand();

    const text = output.join('\n');
    expect(text).toContain('Worker daemon');
    expect(text).not.toContain('Chroma child exits');
  });

  it('ignores a missing or malformed admin Chroma payload', async () => {
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    process.exit = (() => undefined) as typeof process.exit;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ health: { chroma: { count: 'not-a-number' } } }), { status: 200 });
    }) as typeof fetch;

    await runDoctorCommand();

    const text = output.join('\n');
    expect(text).toContain('Worker daemon');
    expect(text).not.toContain('Chroma child exits');
  });
});
