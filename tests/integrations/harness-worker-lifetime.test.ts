import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessWorkerClient } from '../../src/integrations/harness-worker.js';

let dir: string;
let marker: string;
let release: string;
let originalFetch: typeof fetch;
let previous: Record<string, string | undefined>;
let pending: Promise<unknown>[];
const keys = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_WORKER_PORT'];
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  originalFetch = globalThis.fetch;
  pending = [];
  dir = mkdtempSync(join(tmpdir(), 'cmem-harness-lifetime-'));
  const data = join(dir, 'data');
  const scripts = join(dir, 'config', 'plugins', 'marketplaces', 'thedotmack', 'plugin', 'scripts');
  mkdirSync(data, { recursive: true }); mkdirSync(scripts, { recursive: true });
  marker = join(data, 'worker-starts'); release = join(data, 'release-start');
  process.env.CLAUDE_MEM_DATA_DIR = data;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config');
  delete process.env.CLAUDE_MEM_WORKER_HOST; delete process.env.CLAUDE_MEM_WORKER_PORT;
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: '40502' }));
  // Exercise the real spawn path without launching the installed production worker.
  writeFileSync(join(scripts, 'worker-service.cjs'), '');
  writeFileSync(join(scripts, 'bun-runner.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const data = process.env.CLAUDE_MEM_DATA_DIR;
    fs.appendFileSync(path.join(data, 'worker-starts'), 'start\\n');
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(data, 'release-start'))) { clearInterval(timer); process.exit(0); }
    }, 5);
  `);
  writeFileSync(release, '');
});

afterEach(async () => {
  writeFileSync(release, '');
  await Promise.allSettled(pending);
  globalThis.fetch = originalFetch;
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  rmSync(dir, { recursive: true, force: true });
});

it('does not probe or start the worker for an already canceled caller', async () => {
  let probes = 0;
  globalThis.fetch = (async () => { probes++; throw refused(); }) as typeof fetch;
  const controller = new AbortController();
  const reason = new Error('Session deleted');
  controller.abort(reason);
  const ready = createHarnessWorkerClient().ready(controller.signal);
  pending.push(ready);
  await expect(ready).rejects.toBe(reason);
  expect(probes).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

it('does not start the worker after a canceled health probe fails late', async () => {
  let fail!: () => void;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = ((_input: unknown, options?: RequestInit) => {
    signal = options?.signal;
    return new Promise((_resolve, reject) => { fail = () => reject(refused()); });
  }) as typeof fetch;
  const controller = new AbortController();
  const ready = createHarnessWorkerClient().ready(controller.signal);
  pending.push(ready);
  const reason = new Error('Session deleted');
  controller.abort(reason);
  fail();
  await expect(ready).rejects.toBe(reason);
  expect(signal?.aborted).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

it('canceling one caller preserves shared worker startup and requests for a live caller', async () => {
  unlinkSync(release);
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('http://127.0.0.1:40502');
    requests.push(url.pathname);
    if (url.pathname === '/api/health') throw refused();
    return Response.json({ status: 'ok' });
  }) as typeof fetch;
  const client = createHarnessWorkerClient();
  const canceled = new AbortController();
  const live = new AbortController();
  const reason = new Error('Session deleted');
  const canceledResult = client.ready(canceled.signal).then(() => undefined, error => error);
  const liveResult = client.ready(live.signal).then(() => client.post('/api/sessions/init', { contentSessionId: 'live' }, live.signal));
  pending.push(canceledResult, liveResult);
  await until(() => existsSync(marker));
  canceled.abort(reason);
  expect(live.signal.aborted).toBe(false);
  writeFileSync(release, '');
  expect(await canceledResult).toBe(reason);
  expect((await liveResult).ok).toBe(true);
  expect(readFileSync(marker, 'utf8')).toBe('start\n');
  expect(requests).toEqual(['/api/health', '/api/health', '/api/sessions/init']);
});
