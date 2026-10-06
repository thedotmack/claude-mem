import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
