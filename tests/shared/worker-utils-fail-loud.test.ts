import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Eagerly evaluate paths.ts BEFORE any per-test env override: it freezes
// DATA_DIR at first evaluation. The preload already pinned CLAUDE_MEM_DATA_DIR
// to a per-run temp dir, so importing here keeps that stable root.
import { DATA_DIR } from '../../src/shared/paths.js';

const STATE_DIR = join(DATA_DIR, 'state');
const FAILURES_PATH = join(STATE_DIR, 'hook-failures.json');

function resetStateFile(): void {
  if (existsSync(FAILURES_PATH)) {
    rmSync(FAILURES_PATH);
  }
}

async function importWorkerUtilsFresh() {
  return import(`../../src/shared/worker-utils.js?worker-utils-fail-loud=${Date.now()}-${Math.random()}`);
}

describe('recordWorkerUnreachable — per-process dedupe', () => {
  const originalTelemetry = process.env.CLAUDE_MEM_TELEMETRY;
  let exitSpy: ReturnType<typeof spyOn>;
  let exitCalls: Array<number | undefined>;

  beforeEach(() => {
    process.env.CLAUDE_MEM_TELEMETRY = '0';
    mkdirSync(STATE_DIR, { recursive: true });
    resetStateFile();
    exitCalls = [];
    exitSpy = spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCalls.push(code);
      // Prevent the test process from exiting.
      throw new Error(`process.exit(${code}) blocked`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (originalTelemetry === undefined) {
      delete process.env.CLAUDE_MEM_TELEMETRY;
    } else {
      process.env.CLAUDE_MEM_TELEMETRY = originalTelemetry;
    }
  });

  it('increments the persisted counter once for two unreachable-worker calls in the same process', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    workerUtils.resetWorkerUnreachableState();

    const first = await workerUtils.recordWorkerUnreachable();
    const second = await workerUtils.recordWorkerUnreachable();

    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it('increments again after resetWorkerUnreachableState (new hook process)', async () => {
    const workerUtils = await importWorkerUtilsFresh();
    workerUtils.resetWorkerUnreachableState();

    expect(await workerUtils.recordWorkerUnreachable()).toBe(1);

    workerUtils.resetWorkerUnreachableState();
    expect(await workerUtils.recordWorkerUnreachable()).toBe(2);
  });

  it('fires the threshold branch only on the crossing increment, not on deduped calls', async () => {
    // Default threshold is 3; the third process crosses it.
    const workerUtils = await importWorkerUtilsFresh();

    workerUtils.resetWorkerUnreachableState();
    expect(await workerUtils.recordWorkerUnreachable()).toBe(1);
    expect(exitCalls).toHaveLength(0);

    workerUtils.resetWorkerUnreachableState();
    expect(await workerUtils.recordWorkerUnreachable()).toBe(2);
    expect(exitCalls).toHaveLength(0);

    // Third process crosses threshold; emitBlockingError calls process.exit(2).
    // The spy blocks the exit and throws, but the persisted state is already
    // written before the exit call.
    workerUtils.resetWorkerUnreachableState();
    await expect(workerUtils.recordWorkerUnreachable()).rejects.toThrow('process.exit(2) blocked');
    expect(exitCalls).toEqual([2]);

    exitCalls = [];
    // Another call in the same process must be deduped: return the current
    // count without re-entering the threshold branch.
    const fourth = await workerUtils.recordWorkerUnreachable();
    expect(fourth).toBe(3);
    expect(exitCalls).toHaveLength(0);
  });
});
