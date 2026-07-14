import { describe, it, expect, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

// Regression coverage for the reworked tree-kill primitives (#3230):
// killProcessTree, collectDescendantPids (+ its pgrep / ps implementations),
// and waitForExit. These tests spawn REAL processes (no child_process
// mocking) so the pgrep/ps walks and process.kill(pid, 0) liveness checks
// exercise actual OS behavior on macOS/Linux CI runners.

const managerInternals = ChromaMcpManager as unknown as {
  killProcessTree: (pid: number) => Promise<void>;
  collectDescendantPids: (rootPid: number) => Promise<number[]>;
  collectDescendantPidsViaPgrep: (rootPid: number) => Promise<number[]>;
  collectDescendantPidsViaPs: (rootPid: number) => Promise<number[]>;
  waitForExit: (pids: number[], timeoutMs: number, intervalMs?: number) => Promise<number[]>;
};

// Tracks every PID this file spawns (or discovers as a descendant) so
// afterEach can reap anything a test failure left alive.
const spawnedPids = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ESRCH — already dead. Fine.
  }
}

function spawnBashTree(): ChildProcess {
  // A bash tree with two grandchild `sleep` processes forked via `&`, kept
  // alive by `wait` so the parent bash process stays alive until killed.
  const child = spawn('bash', ['-c', 'sleep 30 & sleep 30 & wait']);
  if (child.pid) {
    spawnedPids.add(child.pid);
  }
  return child;
}

function spawnSleep(): ChildProcess {
  const child = spawn('sleep', ['30']);
  if (child.pid) {
    spawnedPids.add(child.pid);
  }
  return child;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const pid of spawnedPids) {
    killIfAlive(pid);
  }
  spawnedPids.clear();
});

describe('ChromaMcpManager tree-kill primitives (#3230)', () => {
  it('killProcessTree kills a real spawned process tree, root and every descendant', async () => {
    const root = spawnBashTree();
    expect(root.pid).toBeDefined();
    const rootPid = root.pid as number;

    // Give bash time to fork both sleep children.
    await sleepMs(200);

    const descendants = await managerInternals.collectDescendantPids(rootPid);
    for (const pid of descendants) {
      spawnedPids.add(pid);
    }
    expect(descendants.length).toBeGreaterThan(0);

    await managerInternals.killProcessTree(rootPid);

    expect(isAlive(rootPid)).toBe(false);
    for (const pid of descendants) {
      expect(isAlive(pid)).toBe(false);
    }
  }, 10_000);

  it('waitForExit resolves early with an empty list once the PID is already dead', async () => {
    const child = spawnSleep();
    const pid = child.pid as number;
    expect(pid).toBeDefined();

    process.kill(pid, 'SIGKILL');
    // Give the OS a moment to reap the signal before polling.
    await sleepMs(50);

    const t0 = Date.now();
    const survivors = await managerInternals.waitForExit([pid], 5_000);
    const elapsed = Date.now() - t0;

    expect(survivors).toEqual([]);
    expect(elapsed).toBeLessThan(1_000);
  }, 10_000);

  it('waitForExit reports a still-alive PID as a survivor when the timeout elapses', async () => {
    const child = spawnSleep();
    const pid = child.pid as number;
    expect(pid).toBeDefined();

    const survivors = await managerInternals.waitForExit([pid], 150);

    expect(survivors).toEqual([pid]);
  }, 10_000);

  it('collectDescendantPidsViaPgrep and collectDescendantPidsViaPs agree on the same tree', async () => {
    const root = spawnBashTree();
    const rootPid = root.pid as number;
    expect(rootPid).toBeDefined();

    await sleepMs(200);

    const viaPgrep = await managerInternals.collectDescendantPidsViaPgrep(rootPid);
    const viaPs = await managerInternals.collectDescendantPidsViaPs(rootPid);
    for (const pid of [...viaPgrep, ...viaPs]) {
      spawnedPids.add(pid);
    }

    expect(viaPgrep.length).toBeGreaterThan(0);
    expect(viaPs.length).toBeGreaterThan(0);
    expect(new Set(viaPgrep)).toEqual(new Set(viaPs));
  }, 10_000);
});
