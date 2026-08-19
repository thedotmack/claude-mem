import { describe, it, expect } from 'bun:test';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  killProcessTree,
  collectDescendantPids,
  ProcessTreeKillError,
} from '../../src/shared/kill-process-tree.js';
import { isPidAlive } from '../../src/supervisor/process-registry.js';

const isPosix = process.platform !== 'win32';

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return predicate();
}

/**
 * A shell that forks a grandchild and then sleeps, so the tree is genuinely
 * two levels deep — a single-PID kill leaves the grandchild running, which is
 * the #3482 shape in miniature.
 */
function spawnTwoLevelTree(): { rootPid: number } {
  // `& wait` keeps the shell itself alive as the parent instead of letting it
  // exec away into the last command, so the tree really is two levels deep.
  const child = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 300 & wait'], {
    stdio: 'ignore',
    detached: false,
  });
  return { rootPid: child.pid! };
}

/** Give the shell time to actually fork before sampling the tree. */
function settle(ms = 500): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe.if(isPosix)('killProcessTree signal modes', () => {
  it("'immediate' reaps the whole tree without sending SIGTERM (#3378)", async () => {
    const { rootPid } = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantPids(rootPid);
    expect(descendants.length).toBeGreaterThan(0);

    await killProcessTree(rootPid, { signalMode: 'immediate' });

    const allGone = await waitUntil(
      () => !isPidAlive(rootPid) && descendants.every(pid => !isPidAlive(pid)),
      10_000
    );
    expect(allGone).toBe(true);
  }, 30_000);

  it("'graceful' (default) also reaps the whole tree", async () => {
    const { rootPid } = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantPids(rootPid);
    expect(descendants.length).toBeGreaterThan(0);

    await killProcessTree(rootPid);

    const allGone = await waitUntil(
      () => !isPidAlive(rootPid) && descendants.every(pid => !isPidAlive(pid)),
      10_000
    );
    expect(allGone).toBe(true);
  }, 30_000);

  it('is not an error when the target is already gone', async () => {
    const { rootPid } = spawnTwoLevelTree();
    await settle();
    await killProcessTree(rootPid, { signalMode: 'immediate' });
    await waitUntil(() => !isPidAlive(rootPid), 10_000);

    // Second call against a corpse must resolve, not throw.
    await killProcessTree(rootPid, { signalMode: 'immediate' });
  }, 30_000);
});

describe.if(isPosix)('the #3378 invariant is enforced, not just documented', () => {
  // The recycle path must run ZERO stale-version shutdown code. That holds
  // only if 'immediate' never sends SIGTERM — a catchable signal would let a
  // stale worker execute its own shutdown/handoff logic and re-spawn itself,
  // which is the restart storm (#3378) the invariant exists to prevent.
  //
  // Asserting that in a comment is worthless: a regression reinstating
  // SIGTERM-then-SIGKILL would pass a comment unchanged. So the root here
  // TRAPS SIGTERM and touches a marker file. The marker's absence is the
  // proof; its presence means SIGTERM was delivered.
  it("'immediate' never delivers SIGTERM to the root", async () => {
    const marker = path.join(
      os.tmpdir(),
      `claude-mem-sigterm-marker-${process.pid}-${Date.now()}`
    );

    const child = spawn(
      '/bin/sh',
      ['-c', `trap 'touch "${marker}"; exit 0' TERM; sleep 300 & wait`],
      { stdio: 'ignore' }
    );
    const rootPid = child.pid!;
    await settle();

    await killProcessTree(rootPid, { signalMode: 'immediate' });
    await waitUntil(() => !isPidAlive(rootPid), 10_000);
    // Give a delivered-but-slow handler room to write, so a pass cannot be
    // an artifact of checking too early.
    await settle(750);

    const trapFired = fs.existsSync(marker);
    fs.rmSync(marker, { force: true });

    expect(trapFired).toBe(false);
  }, 30_000);

  it("'graceful' DOES deliver SIGTERM — proving the marker works", async () => {
    // Control case. Without this, a marker that never fires for an unrelated
    // reason (trap syntax, tmpdir perms) would make the test above vacuous.
    const marker = path.join(
      os.tmpdir(),
      `claude-mem-sigterm-control-${process.pid}-${Date.now()}`
    );

    const child = spawn(
      '/bin/sh',
      ['-c', `trap 'touch "${marker}"; exit 0' TERM; sleep 300 & wait`],
      { stdio: 'ignore' }
    );
    const rootPid = child.pid!;
    await settle();

    await killProcessTree(rootPid);
    await waitUntil(() => !isPidAlive(rootPid), 10_000);
    await settle(750);

    const trapFired = fs.existsSync(marker);
    fs.rmSync(marker, { force: true });

    expect(trapFired).toBe(true);
  }, 30_000);
});

describe('ProcessTreeKillError', () => {
  it('carries the pid so callers can report which kill failed', () => {
    const error = new ProcessTreeKillError(4242, 'taskkill failed');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProcessTreeKillError');
    expect(error.pid).toBe(4242);
  });
});
