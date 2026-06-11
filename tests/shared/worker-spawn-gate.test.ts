import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Eagerly evaluate src/shared/paths.ts BEFORE any per-test env override:
// paths.ts freezes its DATA_DIR const at first evaluation, and without this
// import the dynamic imports inside these tests can be the first to evaluate
// it — while the env var points at a soon-deleted per-test temp dir — which
// poisons every later-loaded module in the same bun process (e.g.
// ProcessManager's PID_FILE in combined runs). At this point the env var is
// the per-RUN temp dir pinned by the preload tripwire (tests/preload.ts), so
// paths.ts freezes on a stable, isolated dir that outlives this file.
// The module under test is unaffected: it resolves its lock path at call time
// via resolveDataDir(), not via paths.ts's frozen const.
import '../../src/shared/paths.js';

// The spawn gate's lock path comes from resolveDataDir() (src/shared/paths.ts),
// which consults CLAUDE_MEM_DATA_DIR — so the env var MUST point at the temp
// dir BEFORE the gate module is imported/exercised. The cache-busted dynamic
// import follows the worker-utils test idiom
// (tests/shared/worker-utils-version-recycle.test.ts).
const ORIGINAL_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;

async function importGateFresh() {
  return import(`../../src/shared/worker-spawn-gate.js?spawn-gate=${Date.now()}-${Math.random()}`);
}

describe('worker-spawn-gate — cross-launcher spawn lockfile', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-spawn-gate-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    lockPath = join(tempDir, 'spawn.lock');
  });

  afterEach(() => {
    if (ORIGINAL_DATA_DIR === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = ORIGINAL_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('second acquire fails while the lock is held', async () => {
    const { acquireSpawnLock } = await importGateFresh();

    expect(acquireSpawnLock()).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    // A fresh lock is honored: the loser must skip its spawn (and wait).
    expect(acquireSpawnLock()).toBe(false);

    // The original lock survives the failed attempt.
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('breaks a stale lock (mtime backdated >60s) and re-acquires', async () => {
    const { acquireSpawnLock } = await importGateFresh();

    // A crashed launcher's leftover lock, last touched 61s ago. This also
    // exercises the re-stat-before-unlink guard's happy path: nothing races
    // us, so the second stat sees the same mtime and the break proceeds.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, startedAt: new Date(Date.now() - 61_000).toISOString() })
    );
    const past = new Date(Date.now() - 61_000);
    utimesSync(lockPath, past, past);

    expect(acquireSpawnLock()).toBe(true);

    // The broken lock was replaced with OUR lock.
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
  });

  it('honors a 45s-old lock — within the 60s staleness window (regression: was broken under the old 30s threshold)', async () => {
    const { acquireSpawnLock } = await importGateFresh();

    // 45s covers the worst legitimate in-lock wait: the ~15s post-spawn
    // health wait scaled 2.0x by getPlatformTimeout on Windows (~30s). A
    // 30s staleness window would break this holder's lock mid-spawn.
    const foreignPayload = JSON.stringify({
      pid: 999_999_999,
      startedAt: new Date(Date.now() - 45_000).toISOString(),
    });
    writeFileSync(lockPath, foreignPayload);
    const past = new Date(Date.now() - 45_000);
    utimesSync(lockPath, past, past);

    expect(acquireSpawnLock()).toBe(false);

    // The holder's lock survives untouched.
    expect(readFileSync(lockPath, 'utf-8')).toBe(foreignPayload);
  });

  it('release is owner-only: a foreign lock survives releaseSpawnLock', async () => {
    const { releaseSpawnLock } = await importGateFresh();

    const foreignPayload = JSON.stringify({
      pid: process.pid + 1,
      startedAt: new Date().toISOString(),
    });
    writeFileSync(lockPath, foreignPayload);

    releaseSpawnLock();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf-8')).toBe(foreignPayload);
  });

  it('release after own acquire removes the lock file (and it can be re-acquired)', async () => {
    const { acquireSpawnLock, releaseSpawnLock } = await importGateFresh();

    expect(acquireSpawnLock()).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    releaseSpawnLock();
    expect(existsSync(lockPath)).toBe(false);

    expect(acquireSpawnLock()).toBe(true);
  });
});
