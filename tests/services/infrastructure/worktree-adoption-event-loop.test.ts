// #4741: worktree adoption ran every git call through spawnSync, so one slow
// git call — a sleeping USB volume is the reported case — froze the worker's
// event loop for the whole GIT_TIMEOUT_MS (15 s). /api/health shares that
// loop, went silent, hooks reclaimed the worker, and every restart re-ran
// adoption plus a full Chroma backfill: the hours-long wedge loop.
//
// This test drives one adoption git call (hasProvenAncestry -> gitRun) against
// a shim `git` that sleeps 1.5 s and asserts the event loop keeps ticking
// while it runs. The child process is needed because Bun resolves spawned
// binaries against the process's ORIGINAL environment, so the shim has to be
// on PATH before the probe process starts.
//
// RED on the spawnSync implementation: the probe's 50 ms interval records
// ~1500 ms of drift (loop frozen for the whole git call).
// GREEN on the async implementation: drift stays near zero.
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SHIM_SLEEP_S = 1.5;
const TICK_MS = 50;

describe('worktree adoption keeps the event loop responsive during git (#4741)', () => {
  it.skipIf(process.platform === 'win32')(
    'one slow git call does not block the loop for its duration',
    () => {
      const shimDir = mkdtempSync(join(tmpdir(), 'wa4741-shim-'));
      const dataDir = mkdtempSync(join(tmpdir(), 'wa4741-data-'));
      const shimPath = join(shimDir, 'git');
      writeFileSync(shimPath, `#!/bin/sh\nsleep ${SHIM_SLEEP_S}\nexit 1\n`);
      chmodSync(shimPath, 0o755);

      // Runs in a child so the shim is on PATH before the process exists
      // (see file comment). One adoption git call, timed, with a 50 ms
      // interval measuring the worst inter-tick drift.
      const childScript = `
const { hasProvenAncestry } = await import(${JSON.stringify(join(REPO_ROOT, 'src', 'services', 'infrastructure', 'WorktreeAdoption.js'))});
const TICK_MS = ${TICK_MS};
let last = Date.now();
let maxTickDriftMs = 0;
const timer = setInterval(() => {
  const now = Date.now();
  maxTickDriftMs = Math.max(maxTickDriftMs, now - last - TICK_MS);
  last = now;
}, TICK_MS);
const t0 = Date.now();
const proven = await hasProvenAncestry(${JSON.stringify(REPO_ROOT)}, 'deadbeef', new Set(['cafebabe']));
const callMs = Date.now() - t0;
// Let one more tick fire so a blocked-loop drift is actually recorded.
await new Promise(resolve => setTimeout(resolve, TICK_MS * 4));
clearInterval(timer);
console.log('PROBE:' + JSON.stringify({ proven, callMs, maxTickDriftMs }));
`;

      try {
        const child = Bun.spawnSync(['bun', '-e', childScript], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PATH: `${shimDir}:${process.env.PATH}`,
            CLAUDE_MEM_DATA_DIR: dataDir
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000
        });

        expect(child.exitCode).toBe(0);
        const probeLine = child.stdout
          .toString()
          .split('\n')
          .find(line => line.startsWith('PROBE:'));
        expect(probeLine).toBeDefined();
        const probe = JSON.parse(probeLine!.slice('PROBE:'.length));

        // The shim must actually have intercepted git — otherwise the probe
        // is vacuous (real git fails in ~20 ms and blocks nothing).
        expect(provenShimRan(probe)).toBe(true);
        // The shim exits 1, so the ancestry probe stays unproven.
        expect(probe.proven).toBe(false);
        // The loop must not be frozen for the git call's duration.
        expect(probe.maxTickDriftMs).toBeLessThan(1000);
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});

function provenShimRan(probe: { callMs: number }): boolean {
  // The shim sleeps 1.5 s; a real git failure returns in well under 100 ms.
  return probe.callMs >= SHIM_SLEEP_S * 1000 * 0.9;
}
