import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const WORKER_UTILS_URL = pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'worker-utils.ts')).href;
const testDirs: string[] = [];

interface PersistedFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
  thresholdTripped?: boolean;
}

function createStateDir(state: PersistedFailureState): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-failure-'));
  testDirs.push(dataDir);
  const statePath = join(dataDir, 'state', 'hook-failures.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state), 'utf-8');
  return dataDir;
}

function readState(dataDir: string): Required<PersistedFailureState> {
  return JSON.parse(readFileSync(join(dataDir, 'state', 'hook-failures.json'), 'utf-8'));
}

function recordFailure(dataDir: string, threshold: number): ReturnType<typeof Bun.spawnSync> {
  const source = `
    const { recordWorkerUnreachable } = await import(${JSON.stringify(WORKER_UTILS_URL)});
    await recordWorkerUnreachable();
  `;
  return Bun.spawnSync([process.execPath, '-e', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: String(threshold),
      CLAUDE_MEM_TELEMETRY: '0',
    },
  });
}

function resetFailureState(dataDir: string): ReturnType<typeof Bun.spawnSync> {
  const source = `
    const { __resetWorkerFailureCounterForTesting } = await import(${JSON.stringify(WORKER_UTILS_URL)});
    await __resetWorkerFailureCounterForTesting();
  `;
  return Bun.spawnSync([process.execPath, '-e', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      CLAUDE_MEM_TELEMETRY: '0',
    },
  });
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('worker-unreachable fail-loud latch', () => {
  it('migrates an already-exceeded counter and blocks only once', () => {
    // Old state files do not have thresholdTripped. Simulate lowering the
    // threshold from above 4 to 3 during the same worker outage.
    const dataDir = createStateDir({ consecutiveFailures: 4, lastFailureAt: 1 });

    const first = recordFailure(dataDir, 3);
    expect(first.exitCode).toBe(2);
    expect(new TextDecoder().decode(first.stderr)).toContain(
      'claude-mem worker unreachable for 5 consecutive hooks.'
    );
    expect(readState(dataDir)).toMatchObject({
      consecutiveFailures: 5,
      thresholdTripped: true,
    });

    const second = recordFailure(dataDir, 3);
    expect(second.exitCode).toBe(0);
    expect(new TextDecoder().decode(second.stderr)).not.toContain('claude-mem worker unreachable');
    expect(readState(dataDir)).toMatchObject({
      consecutiveFailures: 6,
      thresholdTripped: true,
    });

    const recovery = resetFailureState(dataDir);
    expect(recovery.exitCode).toBe(0);
    expect(readState(dataDir)).toEqual({
      consecutiveFailures: 0,
      lastFailureAt: 0,
      thresholdTripped: false,
    });
  });

  it('allows only one concurrent process to claim the latch', async () => {
    const dataDir = createStateDir({ consecutiveFailures: 2, lastFailureAt: 1 });
    const lockPath = join(dataDir, 'state', 'hook-failures.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: -1, token: 'test-barrier' }), 'utf-8');
    const source = `
      const { recordWorkerUnreachable } = await import(${JSON.stringify(WORKER_UTILS_URL)});
      await recordWorkerUnreachable();
    `;
    const options = {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: dataDir,
        CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',
        CLAUDE_MEM_TELEMETRY: '0',
      },
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    };

    const workers = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, '-e', source], options));
    await new Promise(resolve => setTimeout(resolve, 200));
    unlinkSync(lockPath);

    const exits = await Promise.all(workers.map(worker => worker.exited));
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()));

    expect(exits.filter(exit => exit === 2)).toHaveLength(1);
    expect(exits.filter(exit => exit === 0)).toHaveLength(5);
    expect(errors.join('').match(/claude-mem worker unreachable/g)?.length).toBe(1);
    const state = readState(dataDir);
    expect(state.thresholdTripped).toBe(true);
    expect(state.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(state.consecutiveFailures).toBeLessThanOrEqual(8);
  });

  it('degrades without blocking when the latch cannot be persisted', () => {
    const dataDir = createStateDir({ consecutiveFailures: 2, lastFailureAt: 1 });
    const statePath = join(dataDir, 'state', 'hook-failures.json');
    mkdirSync(`${statePath}.tmp`);

    const first = recordFailure(dataDir, 3);
    const second = recordFailure(dataDir, 3);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(new TextDecoder().decode(first.stderr)).not.toContain('claude-mem worker unreachable');
    expect(new TextDecoder().decode(second.stderr)).not.toContain('claude-mem worker unreachable');
    expect(readState(dataDir)).toEqual({ consecutiveFailures: 2, lastFailureAt: 1 });
  });

  it('waits through recovery lock contention so the next outage can escalate', async () => {
    const dataDir = createStateDir({
      consecutiveFailures: 2,
      lastFailureAt: 1,
      thresholdTripped: true,
    });
    const lockPath = join(dataDir, 'state', 'hook-failures.lock');
    const readyPath = join(dataDir, 'reset-ready');
    writeFileSync(lockPath, JSON.stringify({ pid: -1, token: 'test-barrier' }), 'utf-8');
    const source = `
      const { __resetWorkerFailureCounterForTesting } = await import(${JSON.stringify(WORKER_UTILS_URL)});
      await Bun.write(${JSON.stringify(readyPath)}, 'ready');
      await __resetWorkerFailureCounterForTesting();
    `;
    const recovery = Bun.spawn([process.execPath, '-e', source], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: dataDir,
        CLAUDE_MEM_TELEMETRY: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const readyDeadline = Date.now() + 5_000;
    while (!(await Bun.file(readyPath).exists()) && Date.now() <= readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await Bun.file(readyPath).exists()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    unlinkSync(lockPath);

    expect(await recovery.exited).toBe(0);
    expect(readState(dataDir)).toEqual({
      consecutiveFailures: 0,
      lastFailureAt: 0,
      thresholdTripped: false,
    });

    expect(recordFailure(dataDir, 2).exitCode).toBe(0);
    const thresholdFailure = recordFailure(dataDir, 2);
    expect(thresholdFailure.exitCode).toBe(2);
    expect(new TextDecoder().decode(thresholdFailure.stderr)).toContain(
      'claude-mem worker unreachable for 2 consecutive hooks.'
    );
  });
});
