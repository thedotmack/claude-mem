// The wedged-worker reclaim spares a silent worker whose heartbeat is fresh.
// These tests pin the worker side of that contract: the staleness threshold
// comes from the environment, then settings.json, then the default; the
// heartbeat is JSON {pid, beatAtMs, lastResponseAtMs} replaced atomically by
// the worker alone; and beatAtMs tracks event-loop progress (it stays fresh
// while the loop turns between slow calls, and goes stale while it is held).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  WORKER_HEARTBEAT_STALE_DEFAULT_MS,
  readWorkerHeartbeat,
  readWorkerHeartbeatStaleMs,
  startWorkerHeartbeat,
} from '../../src/shared/port-reclaim.js';

const reclaimUrl = pathToFileURL(fileURLToPath(new URL('../../src/shared/port-reclaim.ts', import.meta.url))).href;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-mem-heartbeat-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition never held');
};

describe('heartbeat staleness setting', () => {
  it('reads settings.json when the environment does not set it', () => {
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS: '45000' }));
    expect(readWorkerHeartbeatStaleMs({}, settings)).toBe(45_000);
  });

  it('lets the environment override settings.json', () => {
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS: '45000' }));
    expect(readWorkerHeartbeatStaleMs({ CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS: '60000' }, settings)).toBe(60_000);
  });

  it('falls back to the default for a missing or out-of-range value', () => {
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS: '5' }));
    expect(readWorkerHeartbeatStaleMs({}, settings)).toBe(WORKER_HEARTBEAT_STALE_DEFAULT_MS);
    expect(readWorkerHeartbeatStaleMs({}, join(dir, 'absent.json'))).toBe(WORKER_HEARTBEAT_STALE_DEFAULT_MS);
  });

  it('does not create settings.json when it reads the threshold', () => {
    const settings = join(dir, 'settings.json');
    readWorkerHeartbeatStaleMs({}, settings);
    expect(existsSync(settings)).toBe(false);
  });
});

describe('worker heartbeat file', () => {
  it('reads as absent before the worker writes one, or when it is not a heartbeat', () => {
    const path = join(dir, 'worker-heartbeat.json');
    expect(readWorkerHeartbeat(path)).toBeNull();
    writeFileSync(path, '{"pid":42,"beatAtMs":');
    expect(readWorkerHeartbeat(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: 42, beatAtMs: 1 }));
    expect(readWorkerHeartbeat(path)).toBeNull();
    writeFileSync(path, 'null');
    expect(readWorkerHeartbeat(path)).toBeNull();
  });

  it('publishes the writer pid, the beat time and the last finished response', async () => {
    const path = join(dir, 'worker-heartbeat.json');
    let lastResponseAtMs: number | null = 5_000;
    let nowMs = 10_000;
    const stop = startWorkerHeartbeat({
      heartbeatPath: path,
      pid: 4242,
      now: () => nowMs,
      readLastResponseAtMs: () => lastResponseAtMs,
      intervalMs: 20,
    });
    try {
      await waitFor(() => readWorkerHeartbeat(path)?.beatAtMs === 10_000);
      expect(readWorkerHeartbeat(path)).toEqual({ pid: 4242, beatAtMs: 10_000, lastResponseAtMs: 5_000 });
      // The worker answers a request: the next beat carries it.
      lastResponseAtMs = 11_000;
      nowMs = 12_000;
      await waitFor(() => readWorkerHeartbeat(path)?.beatAtMs === 12_000);
      expect(readWorkerHeartbeat(path)).toEqual({ pid: 4242, beatAtMs: 12_000, lastResponseAtMs: 11_000 });
    } finally {
      stop();
    }
  });

  it('dates the last response to its own start until the worker finishes one', async () => {
    const path = join(dir, 'worker-heartbeat.json');
    let nowMs = 1_000;
    const stop = startWorkerHeartbeat({ heartbeatPath: path, pid: 7, now: () => nowMs, readLastResponseAtMs: () => null, intervalMs: 20 });
    try {
      nowMs = 2_000;
      await waitFor(() => readWorkerHeartbeat(path)?.beatAtMs === 2_000);
      expect(readWorkerHeartbeat(path)?.lastResponseAtMs).toBe(1_000);
    } finally {
      stop();
    }
  });

  it('replaces the file by rename, leaving no temp file behind', async () => {
    const path = join(dir, 'worker-heartbeat.json');
    const stop = startWorkerHeartbeat({ heartbeatPath: path, pid: 7, readLastResponseAtMs: () => null, intervalMs: 3_600_000 });
    stop();
    await waitFor(() => readWorkerHeartbeat(path) !== null);
    await waitFor(() => readdirSync(dir).length === 1);
    expect(readdirSync(dir)).toEqual(['worker-heartbeat.json']);
  });

  it('stays fresh while the loop turns between slow calls, and goes stale while it is held', () => {
    const path = join(dir, 'worker-heartbeat.json');
    // A child process, so a held event loop cannot stall the test runner.
    const script = `
      const { startWorkerHeartbeat, readWorkerHeartbeat } = await import(${JSON.stringify(reclaimUrl)});
      const hold = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const ageMs = () => Date.now() - readWorkerHeartbeat(${JSON.stringify(path)}).beatAtMs;
      startWorkerHeartbeat({ heartbeatPath: ${JSON.stringify(path)}, intervalMs: 100, readLastResponseAtMs: () => null });
      await sleep(150);
      // Slow but progressing: 300 ms sync holds with the loop turning between them.
      let slowMaxAge = 0;
      for (let i = 0; i < 8; i++) {
        hold(300);
        await sleep(120);
        slowMaxAge = Math.max(slowMaxAge, ageMs());
      }
      // Dead: one 2 s hold; the timer cannot fire, so the beat ages.
      hold(2000);
      const heldAge = ageMs();
      console.log('AGES:' + JSON.stringify({ slowMaxAge, heldAge }));
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 });
    expect(child.status).toBe(0);
    const line = child.stdout.split('\n').find(l => l.startsWith('AGES:'));
    expect(line).toBeDefined();
    const { slowMaxAge, heldAge } = JSON.parse(line!.slice('AGES:'.length));
    expect(slowMaxAge).toBeLessThan(1_000);
    expect(heldAge).toBeGreaterThanOrEqual(1_900);
  }, 20_000);
});
