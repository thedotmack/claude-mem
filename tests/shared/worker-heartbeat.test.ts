// The wedged-worker reclaim spares a silent worker whose heartbeat is fresh.
// These tests pin the two halves of that contract: the staleness threshold
// comes from the environment, then settings.json, then the default; and the
// heartbeat's age tracks event-loop progress (it stays fresh while the loop
// turns between slow calls, and goes stale while the loop is held).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  WORKER_HEARTBEAT_STALE_DEFAULT_MS,
  silentEpisodeStartMs,
  endSilentEpisode,
  readWorkerHeartbeatAgeMs,
  readWorkerHeartbeatStaleMs,
  startWorkerHeartbeat,
} from '../../src/shared/port-reclaim.js';

const reclaimUrl = pathToFileURL(fileURLToPath(new URL('../../src/shared/port-reclaim.ts', import.meta.url))).href;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-mem-heartbeat-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
});

describe('silent episode', () => {
  it('starts at the first silent probe and keeps that start while the silence continues', () => {
    const path = join(dir, 'worker-silent-since.json');
    expect(silentEpisodeStartMs(42, 1_000_000, path)).toBe(1_000_000);
    expect(silentEpisodeStartMs(42, 1_060_000, path)).toBe(1_000_000);
    expect(silentEpisodeStartMs(42, 1_120_000, path)).toBe(1_000_000);
  });

  it('keeps the episode across hooks that fire minutes apart on a quiet machine', () => {
    const path = join(dir, 'worker-silent-since.json');
    silentEpisodeStartMs(42, 1_000_000, path);
    expect(silentEpisodeStartMs(42, 1_000_000 + 5 * 60_000, path)).toBe(1_000_000);
    expect(silentEpisodeStartMs(42, 1_000_000 + 11 * 60_000, path)).toBe(1_000_000);
  });

  it('starts a new episode after a long gap with no silent probe', () => {
    const path = join(dir, 'worker-silent-since.json');
    silentEpisodeStartMs(42, 1_000_000, path);
    const later = 1_000_000 + 31 * 60_000;
    expect(silentEpisodeStartMs(42, later, path)).toBe(later);
  });

  it('starts a new episode after the worker answered a probe', () => {
    const path = join(dir, 'worker-silent-since.json');
    silentEpisodeStartMs(42, 1_000_000, path);
    endSilentEpisode(path);
    expect(silentEpisodeStartMs(42, 1_060_000, path)).toBe(1_060_000);
  });

  it('starts a new episode for a different worker', () => {
    const path = join(dir, 'worker-silent-since.json');
    silentEpisodeStartMs(42, 1_000_000, path);
    expect(silentEpisodeStartMs(43, 1_010_000, path)).toBe(1_010_000);
  });

  it('does not create settings.json when it reads the threshold', () => {
    const settings = join(dir, 'settings.json');
    readWorkerHeartbeatStaleMs({}, settings);
    expect(existsSync(settings)).toBe(false);
  });
});

describe('worker heartbeat file', () => {
  it('has no age before the worker writes one', () => {
    expect(readWorkerHeartbeatAgeMs(Date.now(), join(dir, 'worker-heartbeat'))).toBeNull();
  });

  it('is written at start, so its age is near zero', async () => {
    const path = join(dir, 'worker-heartbeat');
    const stop = startWorkerHeartbeat(path, 50);
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const age = readWorkerHeartbeatAgeMs(Date.now(), path);
      expect(age).not.toBeNull();
      expect(age!).toBeLessThan(1_000);
    } finally {
      stop();
    }
  });

  it('stays fresh while the loop turns between slow calls, and goes stale while it is held', () => {
    const path = join(dir, 'worker-heartbeat');
    // A child process, so a held event loop cannot stall the test runner.
    const script = `
      const { startWorkerHeartbeat, readWorkerHeartbeatAgeMs } = await import(${JSON.stringify(reclaimUrl)});
      const hold = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      startWorkerHeartbeat(${JSON.stringify(path)}, 100);
      await sleep(150);
      // Slow but progressing: 300 ms sync holds with the loop turning between them.
      let slowMaxAge = 0;
      for (let i = 0; i < 8; i++) {
        hold(300);
        await sleep(120);
        slowMaxAge = Math.max(slowMaxAge, readWorkerHeartbeatAgeMs(Date.now(), ${JSON.stringify(path)}));
      }
      // Dead: one 2 s hold; the timer cannot fire, so the file ages.
      hold(2000);
      const heldAge = readWorkerHeartbeatAgeMs(Date.now(), ${JSON.stringify(path)});
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
