import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarnessWorkerUrl } from '../../src/integrations/harness-worker.js';

let dir: string;
let previous: Record<string, string | undefined>;
const keys = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_WORKER_PORT'];
beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), 'cmem-harness-settings-'));
  process.env.CLAUDE_MEM_DATA_DIR = dir;
  delete process.env.CLAUDE_MEM_WORKER_HOST; delete process.env.CLAUDE_MEM_WORKER_PORT;
});
afterEach(() => {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  rmSync(dir, { recursive: true, force: true });
});
it('honors BOM and nested settings, normalizes localhost, and prefers environment overrides', () => {
  writeFileSync(join(dir, 'settings.json'), '\uFEFF' + JSON.stringify({ env: { CLAUDE_MEM_WORKER_PORT: '40500', CLAUDE_MEM_WORKER_HOST: 'localhost' } }));
  expect(resolveHarnessWorkerUrl()).toBe('http://127.0.0.1:40500');
  process.env.CLAUDE_MEM_WORKER_PORT = '40501';
  expect(resolveHarnessWorkerUrl()).toBe('http://127.0.0.1:40501');
});
it('brackets IPv6 and resolves flat settings', () => {
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '40500', CLAUDE_MEM_WORKER_HOST: '::1' }));
  expect(resolveHarnessWorkerUrl()).toBe('http://[::1]:40500');
});

// The worker also supports a persisted data-directory redirect. Resolve in a
// child so HOME is isolated and no real user's settings can be read.
function resolveWithHome(home: string, env: Record<string, string> = {}, cwd = home): string {
  const moduleUrl = pathToFileURL(join(import.meta.dir, '../../src/integrations/harness-worker.ts')).href;
  const result = spawnSync(process.execPath, ['-e',
    `const { resolveHarnessWorkerUrl } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(resolveHarnessWorkerUrl());`,
  ], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MEM_DATA_DIR: '', ...env }, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

it.each([
  ['flat', (target: string) => JSON.stringify({ CLAUDE_MEM_DATA_DIR: target })],
  ['nested with a stale root', (target: string) => JSON.stringify({ CLAUDE_MEM_DATA_DIR: '/stale', env: { CLAUDE_MEM_DATA_DIR: target } })],
  ['BOM-prefixed', (target: string) => '\uFEFF' + JSON.stringify({ CLAUDE_MEM_DATA_DIR: target })],
] as const)('reads the worker address from a %s persisted data-directory redirect', (_name, document) => {
  const home = join(dir, 'home');
  const target = join(home, 'memory');
  mkdirSync(join(home, '.claude-mem'), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(home, '.claude-mem', 'settings.json'), document('~/memory'));
  writeFileSync(join(target, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_HOST: '::1', CLAUDE_MEM_WORKER_PORT: '40502' }));
  expect(resolveWithHome(home)).toBe('http://[::1]:40502');
  expect(resolveWithHome(home, { CLAUDE_MEM_WORKER_PORT: '40503' })).toBe('http://[::1]:40503');
  // An explicit environment data directory wins over the persisted redirect.
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '40504' }));
  expect(resolveWithHome(home, { CLAUDE_MEM_DATA_DIR: dir })).toBe('http://127.0.0.1:40504');
});

it('keeps relative data-directory settings relative to the working directory, like the worker', () => {
  mkdirSync(join(dir, '.claude-mem'));
  mkdirSync(join(dir, 'relative-data'));
  writeFileSync(join(dir, '.claude-mem', 'settings.json'), JSON.stringify({ CLAUDE_MEM_DATA_DIR: 'relative-data' }));
  writeFileSync(join(dir, 'relative-data', 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '40505' }));
  expect(resolveWithHome(dir)).toBe('http://127.0.0.1:40505');
});

it.each([undefined, '{', 'null', '[]', JSON.stringify({ CLAUDE_MEM_DATA_DIR: 42 })])(
  'uses the default address for absent or invalid settings: %s', document => {
    mkdirSync(join(dir, '.claude-mem'));
    if (document !== undefined) writeFileSync(join(dir, '.claude-mem', 'settings.json'), document);
    expect(resolveWithHome(dir)).toBe('http://127.0.0.1:' + (37700 + ((process.getuid?.() ?? 77) % 100)));
  },
);

it('uses defaults when the redirected settings file is missing instead of reading stale bootstrap values', () => {
  mkdirSync(join(dir, '.claude-mem'));
  writeFileSync(join(dir, '.claude-mem', 'settings.json'), JSON.stringify({
    CLAUDE_MEM_DATA_DIR: join(dir, 'missing'), CLAUDE_MEM_WORKER_PORT: '40506',
  }));
  expect(resolveWithHome(dir)).toBe('http://127.0.0.1:' + (37700 + ((process.getuid?.() ?? 77) % 100)));
});
