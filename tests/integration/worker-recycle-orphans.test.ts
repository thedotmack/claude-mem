/**
 * THE fail-on-main gate for #3482 — a worker recycle must tear down the whole
 * Chroma process tree, on EVERY platform.
 *
 * Why this test and not a ChromaMcpManager-only round trip: ChromaMcpManager
 * .stop() already tree-kills, so a create/add/query/stop test passes on main
 * and proves nothing. The single-PID kill that actually causes #3482 is in the
 * WORKER RECYCLE path — `ensureWorkerRunning()` in src/shared/worker-utils.ts,
 * which on main does `process.kill(stalePidInfo.pid, 'SIGKILL')`. That
 * terminates exactly one PID, so the stale worker's uvx -> uv -> python
 * descendants survive holding the inherited listening socket.
 *
 * NOT Windows-only. The bug was first characterised on Windows (no process
 * groups), but a bare SIGKILL orphans the identical chain on POSIX — the
 * descendants just re-parent to init instead. This gate was originally scoped
 * to win32; running it on macOS reproduced the exact same signature
 * (surviving `uv` and `python`), which is why the fix and this test both now
 * cover POSIX. That also makes the gate verifiable on Linux CI rather than
 * resting entirely on a Windows job.
 *
 * Shape of the gate:
 *   1. a fixture CHILD process starts a real chroma-mcp tree, serves
 *      /api/health with a stale version, and writes an owned worker PID file;
 *   2. this test snapshots the child's descendants WITH identity, BEFORE any
 *      teardown — after the root dies the children re-parent and a
 *      post-mortem walk finds nothing, which would be a false PASS;
 *   3. this test calls the PRODUCTION `ensureWorkerRunning()`, whose recycle
 *      branch performs the kill under test;
 *   4. every snapshotted descendant must be gone, matched on pid AND start
 *      token so a recycled PID cannot fake success.
 *
 * The fix keeps the #3378 invariant intact: the recycle uses the tree-kill's
 * 'immediate' mode, which is SIGKILL-only with no grace window, so no
 * stale-version shutdown code runs anywhere in the tree.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  snapshotDescendants,
  survivingProcesses,
  describeProcesses,
  type ProcessIdentity,
} from './helpers/process-tree.js';

const RUN_GATE = process.env.CLAUDE_MEM_TEST_CHROMA === '1';

/**
 * This gate drives the PRODUCTION recycle, which kills whatever owns the real
 * worker port and deletes the real worker PID file. Run against a developer's
 * default data dir it would take down their live worker. DATA_DIR is resolved
 * at import time (src/shared/paths.ts), so the isolation has to already be in
 * the environment — refuse to run otherwise rather than trusting the caller.
 */
function assertIsolatedDataDir(): void {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
  if (!dataDir) {
    throw new Error(
      'CLAUDE_MEM_DATA_DIR must be set before starting this process — refusing to run the recycle gate against the default data dir'
    );
  }
  fs.mkdirSync(dataDir, { recursive: true });
}

const FIXTURE_READY_TIMEOUT_MS = 600_000;
const RECYCLE_TIMEOUT_MS = 600_000;
const ORPHAN_SETTLE_TIMEOUT_MS = 30_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'stale-worker-host.ts');

interface FixtureHandle {
  child: ChildProcess;
  pid: number;
  port: number;
  chromaRootPid: number;
}

let active: FixtureHandle | null = null;

function bunExecutable(): string {
  return process.env.BUN_EXECUTABLE || process.execPath;
}

async function startFixture(): Promise<FixtureHandle> {
  const child = spawn(bunExecutable(), ['run', FIXTURE], {
    // Inherit CLAUDE_MEM_DATA_DIR from the harness. DATA_DIR is resolved at
    // module-import time, so it MUST arrive through the environment — setting
    // it after import would silently point at the real home dir.
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });

  const ready = await new Promise<FixtureHandle>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`fixture did not become ready in ${FIXTURE_READY_TIMEOUT_MS}ms\n${stderr}`)),
      FIXTURE_READY_TIMEOUT_MS
    );
    let buffered = '';

    child.stdout?.on('data', chunk => {
      buffered += String(chunk);
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith('{')) continue;

        const payload = JSON.parse(line) as Record<string, unknown>;
        if (payload.event === 'ready') {
          clearTimeout(timer);
          resolve({
            child,
            pid: payload.pid as number,
            port: payload.port as number,
            chromaRootPid: payload.chromaRootPid as number,
          });
          return;
        }
        if (payload.event === 'error') {
          clearTimeout(timer);
          reject(new Error(`fixture failed: ${String(payload.message)}\n${stderr}`));
          return;
        }
      }
    });

    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`fixture exited early with code ${code}\n${stderr}`));
    });
  });

  active = ready;
  return ready;
}

async function waitForOrphansToClear(
  snapshot: ProcessIdentity[],
  timeoutMs: number
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let survivors = survivingProcesses(snapshot);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    survivors = survivingProcesses(snapshot);
  }
  return survivors;
}

afterEach(async () => {
  // Tear down whatever is left, INCLUDING a worker that ensureWorkerRunning()
  // may have spawned as the stale one's replacement.
  const handle = active;
  active = null;
  if (!handle) return;

  const { killProcessTree } = await import('../../src/shared/kill-process-tree.js');
  await killProcessTree(handle.pid).catch(() => {});
  await killProcessTree(handle.chromaRootPid).catch(() => {});

  const { paths } = await import('../../src/shared/paths.js');
  const pidFile = paths.workerPid();
  if (fs.existsSync(pidFile)) {
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as { pid?: number };
    if (typeof info.pid === 'number' && info.pid !== handle.pid) {
      await killProcessTree(info.pid).catch(() => {});
    }
    fs.rmSync(pidFile, { force: true });
  }
});

describe.if(RUN_GATE)('worker recycle tears down the whole Chroma tree (#3482)', () => {
  it('leaves no orphaned uv/python descendants after the production recycle', async () => {
    assertIsolatedDataDir();
    const fixture = await startFixture();

    // Snapshot BEFORE any teardown. This ordering is the test: once the root
    // exits, its children re-parent and drop out of the process table's
    // parent-child chain, so a walk taken afterwards finds nothing and would
    // report a false PASS.
    const snapshot = snapshotDescendants(fixture.pid);

    // The fixture must genuinely own a uvx/uv/python chain, otherwise this
    // test could pass by having nothing to orphan in the first place.
    expect(snapshot.length).toBeGreaterThan(0);
    const names = snapshot.map(p => p.name.toLowerCase()).join(' ');
    expect(names).toMatch(/uv|python/);

    // Drive the PRODUCTION recycle. Its liveness probe sees the fixture's
    // /api/health, its version probe sees a mismatch, and its kill targets
    // the fixture's pid from the owned PID file.
    const { ensureWorkerRunning } = await import('../../src/shared/worker-utils.js');
    await ensureWorkerRunning();

    // The kill is what is under test; whether a replacement worker then came
    // up is a separate concern, so the return value is intentionally ignored.
    const survivors = await waitForOrphansToClear(snapshot, ORPHAN_SETTLE_TIMEOUT_MS);

    expect(
      survivors.length === 0,
      `orphaned descendants survived the worker recycle: ${describeProcesses(survivors)}`
    ).toBe(true);
  }, RECYCLE_TIMEOUT_MS);
});
