import { describe, it, expect, afterAll, afterEach, mock } from 'bun:test';
import { spawn, execFileSync } from 'child_process';

// Capture the real module before mock.module mutates the live namespace, and
// re-register it in afterAll — bun's mock.module is process-global and
// mock.restore() does NOT undo it (same discipline as the chroma suite).
import * as realProcessIdentity from '../../src/shared/process-identity.js';
const realIdentitySnapshot = { ...realProcessIdentity };

/**
 * Forces the identity verdict for specific PIDs so the reuse branch is
 * DETERMINISTIC. A genuine PID-reuse race cannot be reproduced reliably
 * in-process (PID assignment is the kernel's to choose), and a harness that
 * spins until the number wraps would be slow and flaky in the primary suite.
 * Overriding the decision function exercises the same production branch
 * without gambling on the scheduler.
 */
const forcedReuse = new Set<number>();

/**
 * Simulates a PROBE landing on a different process than the enumeration saw —
 * i.e. the PID was reassigned between discovery and token capture. Any
 * captureProcessStartToken() call for this PID returns the replacement's
 * token, and identity comparisons are judged against that same value, exactly
 * as they would be if the number really had been reissued.
 */
const probeSeesReplacement = new Map<number, string>();

mock.module('../../src/shared/process-identity.js', () => ({
  ...realIdentitySnapshot,
  captureProcessStartToken: (pid: number) =>
    probeSeesReplacement.get(pid) ?? realIdentitySnapshot.captureProcessStartToken(pid),
  isSameProcess: (pid: number, token: string | null) => {
    if (forcedReuse.has(pid)) return false;
    const replacement = probeSeesReplacement.get(pid);
    if (replacement !== undefined) {
      if (token === null) return true;
      return token === replacement;
    }
    return realIdentitySnapshot.isSameProcess(pid, token);
  },
}));

const { killProcessTree } = await import('../../src/shared/kill-process-tree.js');
const { isPidAlive } = await import('../../src/supervisor/process-registry.js');

const isPosix = process.platform !== 'win32';
const strays: number[] = [];

function settle(ms = 500): Promise<void> {
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
 * A root whose DIRECT CHILD ignores SIGTERM.
 *
 * The child has to survive the graceful pass to be observable at the union
 * pass — that union is the only place a stale PID is signalled, so it is the
 * only place the identity check can be seen to matter.
 *
 * The returned pid is the direct child specifically, resolved via `pgrep -P`.
 * collectDescendantPids returns leaves-FIRST, so its [0] is the child's own
 * transient `sleep`, which dies to the plain SIGTERM pass no matter what the
 * identity check decides — targeting that would make both assertions below
 * pass for the wrong reason.
 */
function spawnTermProofChild(): { rootPid: number } {
  const child = spawn(
    '/bin/sh',
    ['-c', `/bin/sh -c "trap '' TERM; while :; do sleep 1; done" & wait`],
    { stdio: 'ignore' }
  );
  const rootPid = child.pid!;
  strays.push(rootPid);
  return { rootPid };
}

/**
 * A root whose direct child is a plain `sleep` — it dies to the INITIAL signal
 * in either mode (SIGTERM in graceful, SIGKILL in immediate). That makes the
 * initial-signal guard observable: skipped means it is still alive afterwards,
 * because nothing else in the run will signal it.
 */
function spawnTermKillableChild(): { rootPid: number } {
  const child = spawn('/bin/sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' });
  const rootPid = child.pid!;
  strays.push(rootPid);
  return { rootPid };
}

function directChildOf(rootPid: number): number {
  const out = execFileSync('pgrep', ['-P', String(rootPid)], { encoding: 'utf-8' });
  const pids = out.split('\n').map(l => Number.parseInt(l.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  if (pids.length === 0) throw new Error(`fixture has no direct child of ${rootPid}`);
  return pids[0]!;
}

afterEach(() => {
  forcedReuse.clear();
  probeSeesReplacement.clear();
});

afterAll(async () => {
  for (const pid of strays) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  mock.module('../../src/shared/process-identity.js', () => realIdentitySnapshot);
});

describe.if(isPosix)('killProcessTree revalidates descendant identity before SIGKILL', () => {
  // BOTH halves are required. Without the "still killed" case the skip case
  // would pass for a process that was never going to be killed anyway.
  //
  // Only the GRACEFUL path is asserted here, and that is not an omission:
  // immediate mode SIGKILLs the pre-scan set in its first pass, so nothing it
  // could later skip is still alive to observe. Its identity check still
  // guards the (real, but untestable in-process) case where a target dies in
  // pass 1 and the OS reissues the number before pass 2.

  it('kills a descendant whose identity is UNCHANGED', async () => {
    const { rootPid } = spawnTermProofChild();
    await settle();
    const termProof = directChildOf(rootPid);

    // Sanity: it must actually be TERM-proof, or this proves nothing.
    process.kill(termProof, 'SIGTERM');
    await settle(300);
    expect(isPidAlive(termProof)).toBe(true);

    // No forced reuse: identity matches, so the union pass must SIGKILL it.
    await killProcessTree(rootPid);

    const died = await waitUntil(() => !isPidAlive(termProof), 10_000);
    expect(died).toBe(true);
  }, 30_000);

  it('SKIPS a descendant whose PID was reused since the scan', async () => {
    const { rootPid } = spawnTermProofChild();
    await settle();
    const bystander = directChildOf(rootPid);

    // Stand in for "this PID now names an unrelated process". Pre-fix, the
    // union SIGKILLed it regardless; post-fix it must be left alone.
    forcedReuse.add(bystander);

    await killProcessTree(rootPid);
    await settle(1_000);

    expect(isPidAlive(bystander)).toBe(true);

    try { process.kill(bystander, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);
});

describe.if(isPosix)('killProcessTree revalidates identity before the INITIAL signal', () => {
  // The delayed escalation was guarded first; this covers the first signal,
  // which fires right after enumeration. That gap is not free — capturing a
  // token spawns `ps` per PID on macOS — so a PID can be reissued inside it.
  // Both halves, in both modes.

  for (const mode of ['graceful', 'immediate'] as const) {
    const opts = mode === 'immediate' ? { signalMode: 'immediate' as const } : {};

    it(`[${mode}] signals a descendant whose identity is UNCHANGED`, async () => {
      const { rootPid } = spawnTermKillableChild();
      await settle();
      const target = directChildOf(rootPid);
      expect(isPidAlive(target)).toBe(true);

      await killProcessTree(rootPid, opts);

      const died = await waitUntil(() => !isPidAlive(target), 10_000);
      expect(died).toBe(true);
    }, 30_000);

    it(`[${mode}] SKIPS a descendant whose PID was reused since enumeration`, async () => {
      const { rootPid } = spawnTermKillableChild();
      await settle();
      const bystander = directChildOf(rootPid);
      expect(isPidAlive(bystander)).toBe(true);

      forcedReuse.add(bystander);

      await killProcessTree(rootPid, opts);
      await settle(1_000);

      // Never signalled: the initial pass skipped it on identity, and the
      // union pass skips it for the same reason.
      expect(isPidAlive(bystander)).toBe(true);

      try { process.kill(bystander, 'SIGKILL'); } catch { /* fine */ }
    }, 30_000);
  }
});

describe.if(isPosix)('killProcessTree refuses a ROOT whose PID was reused', () => {
  // Guards the shape behind P1 #4: a root PID captured before an await (the
  // MCP transport close) and force-killed afterwards. On a mismatch nothing
  // may happen at all — no root signal, and no descendant enumeration either,
  // since those children belong to the replacement.

  it('kills the tree when the root token still matches', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const child = directChildOf(rootPid);
    const token = realIdentitySnapshot.captureProcessStartToken(rootPid);

    await killProcessTree(rootPid, { expectedStartToken: token });

    expect(await waitUntil(() => !isPidAlive(rootPid), 10_000)).toBe(true);
    expect(await waitUntil(() => !isPidAlive(child), 10_000)).toBe(true);
  }, 30_000);

  it('is a complete no-op when the root token differs', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const child = directChildOf(rootPid);

    await killProcessTree(rootPid, { expectedStartToken: 'stale-token-from-a-dead-process' });
    await settle(1_000);

    // Root untouched AND its children never enumerated or signalled.
    expect(isPidAlive(rootPid)).toBe(true);
    expect(isPidAlive(child)).toBe(true);

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
    try { process.kill(child, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);
});

describe.if(isPosix)('killProcessTree is root-safe BY DEFAULT, with no token passed', () => {
  // The structural fix. Root identity used to be opt-in via
  // expectedStartToken, so any call site that omitted it reopened the reuse
  // hole — which is why successive review rounds each found another one.
  // killProcessTree now captures the root's token itself at entry and
  // revalidates before every signal, so omitting the option is safe.
  //
  // These call killProcessTree(pid) with NO options at all, which is the
  // shape ~11 of the 13 real call sites use.

  it('kills the tree when the root identity is intact (no token passed)', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const child = directChildOf(rootPid);

    await killProcessTree(rootPid);

    expect(await waitUntil(() => !isPidAlive(rootPid), 10_000)).toBe(true);
    expect(await waitUntil(() => !isPidAlive(child), 10_000)).toBe(true);
  }, 30_000);

  it('does NOT signal a reused root when no token was passed', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const child = directChildOf(rootPid);

    // The root's PID now names an unrelated process. Pre-fix this was
    // unguarded whenever the caller omitted expectedStartToken, so the root
    // (and via taskkill /T on Windows, its whole subtree) was terminated.
    forcedReuse.add(rootPid);

    await killProcessTree(rootPid);
    await settle(1_000);

    expect(isPidAlive(rootPid)).toBe(true);
    // Descendants are not enumerated from a reused root either — they would
    // be the replacement's children.
    expect(isPidAlive(child)).toBe(true);

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
    try { process.kill(child, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);

  it('does NOT signal a reused root in immediate mode either', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const child = directChildOf(rootPid);

    forcedReuse.add(rootPid);

    await killProcessTree(rootPid, { signalMode: 'immediate' });
    await settle(1_000);

    expect(isPidAlive(rootPid)).toBe(true);
    expect(isPidAlive(child)).toBe(true);

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
    try { process.kill(child, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);
});

describe.if(isPosix)('descendant identity comes from the discovering observation', () => {
  // The failure this guards is worse than missing a reuse: enumerate-then-probe
  // could bind a descendant to the REPLACEMENT's token and then have the later
  // check compare that replacement against itself, match, and certify an
  // unrelated process as a legitimate kill target.
  //
  // The reassignment interval itself is kernel-timed and cannot be driven
  // deterministically. What CAN be driven is its observable consequence: make
  // every probe for one PID report a different process than the process table
  // did. Under enumerate-then-probe the stored token IS the replacement's, so
  // the comparison matches and the process is signalled. Sourcing identity from
  // the discovering read makes the two disagree, so it is skipped.

  it('does NOT signal a descendant whose probe disagrees with the table read', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const bystander = directChildOf(rootPid);
    expect(isPidAlive(bystander)).toBe(true);

    probeSeesReplacement.set(bystander, 'token-of-an-unrelated-replacement-process');

    await killProcessTree(rootPid);
    await settle(1_000);

    expect(isPidAlive(bystander)).toBe(true);

    try { process.kill(bystander, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);

  it('still signals a descendant when table and probe agree', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const target = directChildOf(rootPid);
    expect(isPidAlive(target)).toBe(true);

    await killProcessTree(rootPid);

    expect(await waitUntil(() => !isPidAlive(target), 10_000)).toBe(true);
  }, 30_000);
});

describe.if(isPosix)('a caller-supplied token beats self-capture for a DEAD pid', () => {
  // The rule this encodes: any site that retains a PID from a live
  // ChildProcess and kills it later must capture the start token WHILE that
  // child is alive. Self-capture is only sufficient when the caller can
  // guarantee liveness at the moment of the call.
  //
  // ChromaMcpManager's onclose cleanup is the canonical violation: it runs
  // BECAUSE the child died, so self-capture is guaranteed to be too late and
  // would read whatever now owns the number, then validate that replacement
  // against itself.

  it('SKIPS the kill when the spawn-time token no longer matches', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const child = directChildOf(rootPid);

    // Stand in for "this PID now belongs to someone else by the time cleanup
    // runs". A caller passing its spawn-time token detects that; self-capture
    // cannot, because it would read the replacement.
    probeSeesReplacement.set(rootPid, 'token-of-whatever-now-owns-this-pid');

    await killProcessTree(rootPid, { expectedStartToken: 'token-captured-while-the-child-was-alive' });
    await settle(1_000);

    expect(isPidAlive(rootPid)).toBe(true);
    expect(isPidAlive(child)).toBe(true);

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
    try { process.kill(child, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);

  it('still kills when the spawn-time token matches the live process', async () => {
    const { rootPid } = spawnTermKillableChild();
    await settle();
    const child = directChildOf(rootPid);

    const token = realIdentitySnapshot.captureProcessStartToken(rootPid);
    expect(token).not.toBeNull();

    await killProcessTree(rootPid, { expectedStartToken: token });

    expect(await waitUntil(() => !isPidAlive(rootPid), 10_000)).toBe(true);
    expect(await waitUntil(() => !isPidAlive(child), 10_000)).toBe(true);
  }, 30_000);
});

describe('isSameProcess fallback semantics', () => {
  // Refusing to kill must stay strictly NARROWER than killing: a token we
  // could not read must never strand a live orphan (#2313).
  const { isSameProcess, captureProcessStartToken } = realIdentitySnapshot;

  it('proceeds when no token was captured at snapshot time', () => {
    expect(isSameProcess(process.pid, null)).toBe(true);
  });

  it('proceeds when the token matches', () => {
    const token = captureProcessStartToken(process.pid);
    expect(token).not.toBeNull();
    expect(isSameProcess(process.pid, token)).toBe(true);
  });

  it('refuses only when a readable token genuinely differs', () => {
    expect(isSameProcess(process.pid, 'definitely-not-this-processes-start-token')).toBe(false);
  });
});
