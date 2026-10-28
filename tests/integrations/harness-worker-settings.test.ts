import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessWorkerClient, resolveHarnessContextTimeoutMs, resolveHarnessWorkerUrl } from '../../src/integrations/harness-worker.js';
import { HOOK_TIMEOUTS, getTimeout } from '../../src/shared/hook-constants.js';

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

it('gives context renders the hooks API budget, configurable like the hooks', () => {
  const key = 'CLAUDE_MEM_API_TIMEOUT_MS';
  const before = process.env[key];
  delete process.env[key];
  try {
    expect(resolveHarnessContextTimeoutMs()).toBe(getTimeout(HOOK_TIMEOUTS.API_REQUEST));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { [key]: '45000' } }));
    expect(resolveHarnessContextTimeoutMs()).toBe(45_000);
    process.env[key] = '60000';
    expect(resolveHarnessContextTimeoutMs()).toBe(60_000);
    for (const bad of ['abc', '10', '999999999']) {
      process.env[key] = bad;
      expect(resolveHarnessContextTimeoutMs()).toBe(getTimeout(HOOK_TIMEOUTS.API_REQUEST));
    }
  } finally {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
});

it('uses that budget for the context request instead of the 5 s cap', async () => {
  const key = 'CLAUDE_MEM_API_TIMEOUT_MS';
  const before = process.env[key];
  const realFetch = globalThis.fetch;
  // Stand-in for a busy worker: every response would arrive after 2 s.
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    const timer = setTimeout(() => resolve(new Response('memory')), 2_000);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
  })) as typeof fetch;
  try {
    process.env[key] = '600';
    const client = createHarnessWorkerClient();
    const started = Date.now();
    await expect(client.context(new URLSearchParams({ cwd: '/tmp' }))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
    process.env[key] = '4000';
    client.reset();
    expect(await client.context(new URLSearchParams({ cwd: '/tmp' }))).toBe('memory');
  } finally {
    globalThis.fetch = realFetch;
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
});
