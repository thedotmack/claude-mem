import { describe, it, expect, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { killProcessTree, collectDescendantIdentities } from '../../src/shared/kill-process-tree.js';
import { captureProcessStartToken } from '../../src/shared/process-identity.js';
import { isPidAlive } from '../../src/supervisor/process-registry.js';

/**
 * The parts of tree-kill that are genuinely runnable on BOTH platforms.
 *
 * Most of the reuse suite is `describe.if(isPosix)` — its fixtures depend on
 * `/bin/sh`, `pgrep` and SIGTERM semantics that have no Windows equivalent —
 * so it runs on ubuntu only. That left three Windows-specific mechanisms with
 * no executing coverage anywhere, and they are exactly the ones that cannot be
 * verified locally:
 *
 *   1. the CIM process-table read (descendant discovery),
 *   2. taskkill exit-code classification (not-found tolerated, real failures
 *      surfaced),
 *   3. the root identity gate short-circuiting before `taskkill /T /F`.
 *
 * A format or behaviour difference in any of those would silently skip every
 * descendant as "reused" and bring back #2313 while the code still looked
 * guarded. Everything here therefore uses a platform-appropriate fixture and
 * asserts through the PRODUCTION helpers, so the Windows job exercises the
 * Windows implementations rather than skipping.
 */

const isWindows = process.platform === 'win32';
const strays: number[] = [];

function settle(ms = 600): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle(50);
  }
  return predicate();
}

/**
 * A two-level tree on either platform: a shell that outlives a long-running
 * child, so a single-PID kill would leave the child behind.
 */
function spawnTwoLevelTree(): ChildProcess {
  const child = isWindows
    ? spawn('cmd.exe', ['/c', 'ping -n 120 127.0.0.1 > NUL'], { stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', ['-c', 'sleep 120 & wait'], { stdio: 'ignore' });
  if (child.pid) strays.push(child.pid);
  return child;
}

afterAll(() => {
  for (const pid of strays) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

describe('killProcessTree end-to-end on this platform', () => {
  it('discovers descendants through the production enumeration', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    // On Windows this is the CIM read; on POSIX the ps/proc read. Either way
    // it must actually see the child, or every guard downstream is inert.
    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);

    try { process.kill(root.pid!, 'SIGKILL'); } catch { /* fine */ }
  }, 60_000);

  it('kills the root AND its descendant', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    await killProcessTree(root.pid!);

    expect(await waitUntil(() => !isPidAlive(root.pid!), 20_000)).toBe(true);
    expect(await waitUntil(() => !isPidAlive(childPid), 20_000)).toBe(true);
  }, 60_000);

  it('treats an already-dead target as success, not failure', async () => {
    // Windows: taskkill exits 128 / "not found". POSIX: ESRCH. Both are the
    // tolerated case — a throw here would make `server stop` report a failed
    // stop for a server that had already exited.
    const root = spawnTwoLevelTree();
    await settle();
    const pid = root.pid!;

    await killProcessTree(pid);
    expect(await waitUntil(() => !isPidAlive(pid), 20_000)).toBe(true);

    // Second call against the corpse must resolve, not reject.
    await killProcessTree(pid);
  }, 60_000);

  it('is a complete no-op when the root identity does not match', async () => {
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    // A token that cannot belong to this process: the gate must short-circuit
    // BEFORE taskkill /T /F, leaving the subtree untouched.
    await killProcessTree(root.pid!, { expectedStartToken: 'not-this-processes-start-token' });
    await settle(1_000);

    expect(isPidAlive(root.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    try { process.kill(root.pid!, 'SIGKILL'); } catch { /* fine */ }
    try { process.kill(childPid, 'SIGKILL'); } catch { /* fine */ }
  }, 60_000);

  it('still kills when the supplied root identity matches', async () => {
    // The other half: without this, the no-op case above would pass for a
    // build where the gate rejected everything.
    const root = spawnTwoLevelTree();
    await settle();

    const descendants = await collectDescendantIdentities(root.pid!);
    expect(descendants.length).toBeGreaterThan(0);
    const childPid = descendants[0]!.pid;

    const token = captureProcessStartToken(root.pid!);
    expect(token).not.toBeNull();

    await killProcessTree(root.pid!, { expectedStartToken: token });

    expect(await waitUntil(() => !isPidAlive(root.pid!), 20_000)).toBe(true);
    expect(await waitUntil(() => !isPidAlive(childPid), 20_000)).toBe(true);
  }, 60_000);
});
