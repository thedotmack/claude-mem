import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkerService } from '../../src/services/worker-service.js';
import * as pruneCache from '../../src/npx-cli/utils/prune-cache.js';
import {
  PLUGIN_CACHE_PRUNE_FIRST_DELAY_MS,
  PLUGIN_CACHE_PRUNE_INTERVAL_MS,
} from '../../src/npx-cli/utils/prune-cache.js';
import { logger } from '../../src/utils/logger.js';

// A scratch config, so a sweep that escapes the mock cannot touch a real
// ~/.claude plugin cache.
const scratch = mkdtempSync(path.join(tmpdir(), 'claude-mem-prune-timer-'));
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = scratch;
});

afterAll(() => {
  if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  mock.restore();
});

const emptyPrune = {
  root: scratch,
  kept: [] as string[],
  removed: [] as string[],
  failed: [] as { version: string; reason: string }[],
  retainedForLiveWorker: false,
};

function workerWithFakeTimers() {
  const worker = Object.create(WorkerService.prototype) as WorkerService & {
    isShuttingDown: boolean;
    pluginCachePruneTimer: ReturnType<typeof setTimeout> | null;
    pluginCachePruneInFlight: boolean;
    startPluginCachePrune: () => void;
    stopPluginCachePrune: () => void;
  };
  worker.isShuttingDown = false;
  worker.pluginCachePruneTimer = null;
  worker.pluginCachePruneInFlight = false;

  const timeouts: Array<{ callback: () => void; delayMs: number }> = [];
  const intervals: Array<{ callback: () => void; delayMs: number }> = [];
  const unrefs: string[] = [];
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delayMs: number) => {
    timeouts.push({ callback, delayMs });
    return { unref() { unrefs.push('first sweep'); } };
  }) as unknown as typeof setTimeout);
  spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delayMs: number) => {
    intervals.push({ callback, delayMs });
    return { unref() { unrefs.push('hourly sweep'); } };
  }) as unknown as typeof setInterval);
  const cleared = { timeouts: 0, intervals: 0 };
  spyOn(globalThis, 'clearTimeout').mockImplementation((() => { cleared.timeouts += 1; }) as unknown as typeof clearTimeout);
  spyOn(globalThis, 'clearInterval').mockImplementation((() => { cleared.intervals += 1; }) as unknown as typeof clearInterval);
  const prune = spyOn(pruneCache, 'pruneSupersededPluginCache').mockResolvedValue(emptyPrune);
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  return { worker, timeouts, intervals, unrefs, cleared, prune };
}

describe('WorkerService plugin cache prune', () => {
  it('sweeps 5 minutes after start, then hourly, without holding the event loop', () => {
    const fixture = workerWithFakeTimers();
    fixture.worker.startPluginCachePrune();
    expect(fixture.timeouts.map(timer => timer.delayMs)).toEqual([PLUGIN_CACHE_PRUNE_FIRST_DELAY_MS]);
    expect(PLUGIN_CACHE_PRUNE_FIRST_DELAY_MS).toBe(5 * 60_000);
    expect(fixture.unrefs).toEqual(['first sweep']);

    fixture.timeouts[0].callback();
    expect(fixture.intervals.map(timer => timer.delayMs)).toEqual([PLUGIN_CACHE_PRUNE_INTERVAL_MS]);
    expect(PLUGIN_CACHE_PRUNE_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(fixture.unrefs).toEqual(['first sweep', 'hourly sweep']);

    fixture.worker.startPluginCachePrune();
    expect(fixture.timeouts).toHaveLength(1);
  });

  it('does not start during shutdown, and stop clears the armed timer', () => {
    const fixture = workerWithFakeTimers();
    fixture.worker.isShuttingDown = true;
    fixture.worker.startPluginCachePrune();
    expect(fixture.timeouts).toHaveLength(0);

    fixture.worker.isShuttingDown = false;
    fixture.worker.startPluginCachePrune();
    fixture.worker.stopPluginCachePrune();
    expect(fixture.cleared).toEqual({ timeouts: 1, intervals: 1 });
    expect(fixture.worker.pluginCachePruneTimer).toBeNull();
  });

  it('asks the sweep to keep the directory this process is running from', async () => {
    const fixture = workerWithFakeTimers();
    fixture.worker.startPluginCachePrune();
    fixture.timeouts[0].callback();
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();

    expect(fixture.prune).toHaveBeenCalledTimes(1);
    const options = fixture.prune.mock.calls[0][0] as { runningScriptPath?: string; additionalProtectedVersions?: string[] };
    const workerDir = path.dirname(fileURLToPath(new URL('../../src/services/worker-service.ts', import.meta.url)));
    expect(options.runningScriptPath).toBe(workerDir);
    expect(options.additionalProtectedVersions).toEqual(['0.0.0-dev']);
  });
});
