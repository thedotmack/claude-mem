/**
 * THE fail-on-main gate for ghost-listener recovery (plan-15 #3603,
 * reproduction of 2026-09-07 and siblings #2893/#2963/#3482/#3596).
 *
 * Scenario under test:
 *   - a worker is killed OUT-OF-BAND (`taskkill /F /PID`, no `/T` — no
 *     shutdown code runs), while its real chroma-mcp sidecar tree is alive;
 *   - the sidecar descendants inherited the worker's listening socket, so the
 *     port stays LISTENING under the DEAD worker PID (a ghost listener);
 *   - the next launcher (ensureWorkerStarted — the MCP-server / CLI / install
 *     spawn path) sees "port in use", waits for health, gets nothing, and on
 *     MAIN returns 'dead': nothing reclaims, so the port is blocked until a
 *     human tree-kills the sidecar chain by hand.
 *
 * What the gate asserts:
 *   1. the fixture really leaves a ghost: after the out-of-band kill the port
 *      is still bound, its owner PID no longer exists, and the chroma chain
 *      snapshot survives;
 *   2. the PRODUCTION ensureWorkerStarted() then returns 'ready'/'warming'
 *      (NOT 'dead') — on main it returns 'dead' because no reclaim exists;
 *   3. every snapshotted sidecar descendant is gone (the reclaim killed the
 *      chain), matched on pid AND start token so a recycled PID cannot fake
 *      success;
 *   4. the port is served by a NEW live worker (health answers a different
 *      pid than the dead fixture).
 *
 * The fixture is launched DETACHED (PowerShell Start-Process) — the same way
 * spawnDaemon() launches the real worker — because a fixture child of the bun
 * test runner does not reproduce the ghost: the runner's process-tree
 * management takes the sidecar down with the fixture. The production launch
 * path has no such management, which is exactly why the ghost exists there.
 *
 * Windows-only: POSIX sockets die with their owner (no inherited-handle
 * ghost), so the scenario cannot be constructed there — the gate refuses to
 * run rather than pass vacuously.
 *
 * Runtime-dependent for the same reason: the ghost is made of inherited
 * socket handles, and bun >= 1.4 no longer passes the listening socket into
 * spawned children. Measured on one machine with identical code and logging:
 * under 1.3.6 the port stays LISTENING under the dead worker (ghost), under
 * 1.4.0 it is released with the worker. The gate skips the recovery
 * assertions for exactly that signature — port free AND the pre-kill-verified
 * sidecar chain still alive (classifyPostKillState, helpers/ghost-state.ts) —
 * because failing there would report the runtime's behaviour, not the
 * product's. Every other non-ghost shape (chain died with the worker, port
 * held by other processes, shared ghost, recycled pid) is malformed and
 * FAILS: skipping those would pass the gate without exercising recovery.
 *
 * Requires the same isolation contract as the other chroma gates:
 * CLAUDE_MEM_DATA_DIR set in the environment before this process starts, and
 * CLAUDE_MEM_TEST_CHROMA=1 to opt in (skipped otherwise).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  snapshotDescendants,
  survivingProcesses,
  describeProcesses,
  type ProcessIdentity,
} from './helpers/process-tree.js';
import { classifyPostKillState } from './helpers/ghost-state.js';

const RUN_GATE = process.env.CLAUDE_MEM_TEST_CHROMA === '1';

// The ghost scenario is Windows-only (inheritable socket handles). This file
// is also wired into the Linux chroma job for parity — there it must SKIP
// entirely, because the fixture cannot produce a ghost on POSIX.
const IS_WINDOWS = process.platform === 'win32';

// Deliberately well below the 600s bun cap, which covers the WHOLE test —
// readiness plus the recovery this gate exercises (ghost settle, the launcher,
// orphan settle, health). A fixture that never reports ready must fail early,
// with its full event dump, while there is still room to print it: the first
// CI runs of this gate consumed the entire cap in the wait and lost the
// diagnosis. Readiness on a healthy run is seconds; this is the "something is
// broken, bail loudly" line, not a cold-start allowance.
const FIXTURE_READY_TIMEOUT_MS = 240_000;
const RECOVERY_TIMEOUT_MS = 600_000;
const GHOST_SETTLE_TIMEOUT_MS = 30_000;
const ORPHAN_SETTLE_TIMEOUT_MS = 30_000;

// Every stage inside ensureWorkerStarted() is supposed to carry its own
// deadline (health probes, the reclaim, the readiness wait). The first CI run
// of this gate proved how expensive a MISSING one is: the launcher awaited a
// ghost's silent socket forever, and the gate died on bun's 600s cap with no
// output pointing at the stage. Racing the call itself turns any future
// unbounded await into a named failure — and a stage line in the log.
const ENSURE_STARTED_DEADLINE_MS = 300_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'ghost-worker-host.ts');

interface FixtureHandle {
  pid: number;
  port: number;
  chromaRootPid: number;
}

let active: FixtureHandle | null = null;
// The detached fixture's pid, tracked from the moment Start-Process returns.
// `active` is only assigned by the ready event, so without this a fixture that
// hangs before readiness has no teardown handle and its tree outlives the run.
let spawnedFixturePid: number | null = null;
// The port the fixture reported binding (it rides along on every progress
// event), so a listener it leaves behind can be swept even without `ready`.
let reportedPort: number | null = null;
// A deadline failure cannot cancel ensureWorkerStarted() — track the call so
// teardown can let it settle (or reap what it spawned) before cleanup runs.
let inflightEnsureStarted: Promise<unknown> | null = null;

function bunExecutable(): string {
  return process.env.BUN_EXECUTABLE || process.execPath;
}

/** Kill exactly ONE process — never its descendants (`/T` deliberately omitted). */
function killProcessOnly(pid: number): void {
  execFileSync('taskkill', ['/F', '/PID', String(pid)], {
    stdio: 'ignore',
    windowsHide: true,
    // Bounded like every other child-process call in this gate: a wedged kill
    // must fail the run loudly instead of hanging it invisibly.
    timeout: 30_000,
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listeningOwnerPids(port: number): number[] {
  const stdout = execFileSync('netstat', ['-ano'], {
    encoding: 'utf-8',
    timeout: 15_000,
    windowsHide: true,
  });
  const owners = new Set<number>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const fields = line.split(/\s+/);
    if (/^TCP\b/i.test(fields[0] ?? '')
      && (fields[1] ?? '').endsWith(`:${port}`)
      && fields[3] === 'LISTENING') {
      const pid = Number.parseInt(fields[4] ?? '', 10);
      if (Number.isInteger(pid) && pid > 0) owners.add(pid);
    }
  }
  return [...owners];
}

/** Bound an external await whose internals this test cannot inspect. */
async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/** Lines of JSON events from a file the fixture may or may not have written yet. */
function readJsonLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('{'));
}

function readFileOrEmpty(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '(missing)';
}

/**
 * Launch the fixture DETACHED, exactly like spawnDaemon() launches the real
 * worker (PowerShell Start-Process with redirected output). Returns once the
 * fixture reports ready — read from its events file; the redirected stdout is
 * kept for human debugging only.
 */
async function startFixture(): Promise<FixtureHandle> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-fixture-'));
  const stdoutFile = path.join(dir, 'out.txt');
  const stderrFile = path.join(dir, 'err.txt');
  // The fixture's contract channel. The redirected stdout copy is for humans
  // only: a buffered stdout can hold a single ready line unflushed until the
  // process dies, and every CI run of this gate before the events file
  // existed failed exactly that way (ready only visible at the 600s cap).
  // The path travels as an ARGUMENT, not through process.env: a variable set
  // on process.env here never reaches the fixture (bun hands child processes
  // the environment it started with, so the env-var version of this silently
  // wrote no events at all).
  const eventsFile = path.join(dir, 'events.jsonl');
  const pidFile = path.join(dir, 'fixture.pid');

  const command =
    `$p = Start-Process -FilePath '${bunExecutable().replace(/'/g, "''")}' ` +
    `-ArgumentList @('run', '${FIXTURE.replace(/'/g, "''")}', '${eventsFile.replace(/'/g, "''")}') ` +
    `-WorkingDirectory '${process.cwd().replace(/'/g, "''")}' ` +
    `-RedirectStandardOutput '${stdoutFile.replace(/'/g, "''")}' ` +
    `-RedirectStandardError '${stderrFile.replace(/'/g, "''")}' -PassThru; ` +
    `Set-Content -Path '${pidFile.replace(/'/g, "''")}' -Value $p.Id`;

  // stdio 'ignore' is load-bearing, and the pid travels through a file because
  // of it. The DETACHED fixture inherits this call's stdout pipe; a pipe here
  // never reaches EOF while the fixture lives, and bun 1.4.x's execFileSync
  // waits for exactly that — so the call returns only when something kills the
  // fixture. Every red CI run of this gate had that shape: the fixture stayed
  // alive, the launcher sat in the spawn, and the test's own 600s cap is what
  // eventually freed it (the ready line then appears "after 0ms", which is how
  // the stall masqueraded as a handshake problem). Nothing here reads
  // PowerShell's output, so no pipe is needed.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'ignore',
    windowsHide: true,
  });

  const spawnedPid = Number.parseInt(readFileOrEmpty(pidFile).trim(), 10);
  if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) {
    throw new Error(`fixture Start-Process returned an invalid pid: ${spawnedPid}`);
  }
  // Recorded BEFORE any waiting: every failure below this line must still
  // leave teardown a handle on the process it just started.
  spawnedFixturePid = spawnedPid;

  const startedAt = Date.now();
  const deadline = startedAt + FIXTURE_READY_TIMEOUT_MS;
  let lastStage = '(none)';
  let lastReportAt = startedAt;

  while (Date.now() < deadline) {
    if (!processExists(spawnedPid)) {
      throw new Error(
        `fixture exited early (pid ${spawnedPid})\n--- events ---\n${readFileOrEmpty(eventsFile)}\n--- stderr ---\n${readFileOrEmpty(stderrFile)}`
      );
    }

    // Only the events file is a contract channel — stdout is deliberately NOT
    // read back. A fallback would mask a broken file channel exactly as it did
    // before (the env-var handshake never wrote the file, every local run
    // passed on the fallback anyway, and CI kept hanging), and on CI it cannot
    // save the run either: the buffering that hides the events is what
    // redirects to that same stdout.
    for (const line of readJsonLines(eventsFile)) {
      const payload = JSON.parse(line) as Record<string, unknown>;
      if (payload.event === 'progress') {
        lastStage = `${String(payload.stage)}@${String(payload.elapsedMs)}ms`;
        if (typeof payload.port === 'number') reportedPort = payload.port;
        continue;
      }
      if (payload.event === 'ready') {
        const handle: FixtureHandle = {
          pid: payload.pid as number,
          port: payload.port as number,
          chromaRootPid: payload.chromaRootPid as number,
        };
        active = handle;
        console.log(`[ghost-gate] fixture ready after ${Date.now() - startedAt}ms: ${JSON.stringify(handle)}`);
        return handle;
      }
      if (payload.event === 'error') {
        throw new Error(`fixture failed: ${String(payload.message)}`);
      }
    }

    // Keep the log informative even if bun's test timeout kills the run: the
    // stage timeline is what names where a hang is stuck.
    if (Date.now() - lastReportAt >= 15_000) {
      lastReportAt = Date.now();
      console.log(
        `[ghost-gate] waiting for fixture ready: elapsed=${Date.now() - startedAt}ms lastStage=${lastStage}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    `fixture did not become ready in ${FIXTURE_READY_TIMEOUT_MS}ms (lastStage=${lastStage})\n` +
      `--- events ---\n${readFileOrEmpty(eventsFile)}\n` +
      `--- stdout ---\n${readFileOrEmpty(stdoutFile)}\n` +
      `--- stderr ---\n${readFileOrEmpty(stderrFile)}`
  );
}

function assertIsolatedDataDir(): void {  const dataDir = process.env.CLAUDE_MEM_DATA_DIR;
  if (!dataDir) {
    throw new Error(
      'CLAUDE_MEM_DATA_DIR must be set before starting this process — refusing to run the ghost recovery gate against the default data dir'
    );
  }
  fs.mkdirSync(dataDir, { recursive: true });
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
  // A deadline failure leaves the launcher running (the race cannot cancel
  // it). Give it a bounded moment to settle before teardown kills things, or
  // a late reclaim/spawn outlives cleanup and interferes with the next run.
  if (inflightEnsureStarted) {
    await Promise.race([
      inflightEnsureStarted.catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 15_000)),
    ]);
    inflightEnsureStarted = null;
  }

  // Tear down whatever is left: the recovery may have spawned a real worker
  // as the dead fixture's replacement, and the fixture's own chroma chain may
  // still be alive if the gate failed before the reclaim ran.
  const handle = active;
  active = null;
  const detachedPid = spawnedFixturePid;
  spawnedFixturePid = null;
  const fixturePort = handle?.port ?? reportedPort;
  reportedPort = null;
  if (!handle && detachedPid === null) return;

  const { killProcessTree } = await import('../../src/shared/kill-process-tree.js');
  if (handle) {
    await killProcessTree(handle.chromaRootPid).catch(() => {});
    if (processExists(handle.pid)) {
      killProcessOnly(handle.pid);
    }
  } else if (detachedPid !== null && processExists(detachedPid)) {
    // Readiness never arrived, so no chroma root pid was ever reported: take
    // the whole tree from the fixture root, where the sidecar chain is still a
    // descendant.
    await killProcessTree(detachedPid).catch(() => {});
  }

  const { paths } = await import('../../src/shared/paths.js');

  const killPidFileWorker = async (): Promise<void> => {
    const pidFile = paths.workerPid();
    if (!fs.existsSync(pidFile)) return;
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf-8')) as { pid?: number };
    if (typeof info.pid === 'number' && info.pid !== handle?.pid) {
      await killProcessTree(info.pid).catch(() => {});
    }
    fs.rmSync(pidFile, { force: true });
  };
  await killPidFileWorker();

  if (fixturePort === null) return;

  // Bounded sweep. The wait above is time-boxed, so a launcher that was still
  // mid-flight can spawn its worker or reclaim the chain AFTER the kills —
  // that late work is what survives cleanup and leaks a listener into the next
  // run. Repeat "reap the worker, free the port" until the port is quiet.
  const { reclaimGhostListeningPort } = await import('../../src/shared/port-reclaim.js');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (listeningOwnerPids(fixturePort).length === 0) return;
    await reclaimGhostListeningPort(fixturePort).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 2_000));
    await killPidFileWorker();
  }
});

describe.if(RUN_GATE && IS_WINDOWS)('worker recovers from a ghost listener left by an out-of-band kill', () => {
  it('reclaims the dead worker\'s sidecar chain and starts a new worker', async () => {
    assertIsolatedDataDir();
    const fixture = await startFixture();

    // Snapshot BEFORE the kill: once the root exits, identity is the only
    // way to tell the survivors apart from anything that recycled its PID.
    const snapshot = snapshotDescendants(fixture.pid);
    expect(snapshot.length).toBeGreaterThan(0);
    const names = snapshot.map(p => p.name.toLowerCase()).join(' ');
    expect(names).toMatch(/uv|python/);

    // Kill the fixture OUT-OF-BAND: taskkill /F /PID without /T, exactly the
    // way a crash or a forced task-manager kill takes the worker down.
    // Timestamped: the window between here and the ghost assertion is where
    // every CI run of this gate used to die without a trace, and bun only
    // flushes these lines when the test ends — so each one has to carry the
    // elapsed time that says whether it was the step that hung.
    const killStartedAt = Date.now();
    console.log(`[ghost-gate] killing fixture pid=${fixture.pid} out-of-band (taskkill /F /PID, no /T)`);
    killProcessOnly(fixture.pid);
    console.log(`[ghost-gate] taskkill returned after ${Date.now() - killStartedAt}ms`);
    await waitFor(
      () => !processExists(fixture.pid),
      30_000,
      `fixture process ${fixture.pid} to die`
    );
    console.log(`[ghost-gate] fixture pid=${fixture.pid} is gone ${Date.now() - killStartedAt}ms after the kill`);

    // Ghost precondition: the port is still bound under the dead PID, and the
    // sidecar chain survived (the uvx/uv layers exit on pipe EOF, but the
    // persistent chroma-mcp/python sidecar holds the inherited socket). Wait
    // briefly for that settled shape — without it the gate could pass by
    // having nothing to recover.
    let ownerUnderDeadPid = false;
    let reportedOwners = false;
    const settleDeadline = Date.now() + GHOST_SETTLE_TIMEOUT_MS;
    while (Date.now() < settleDeadline) {
      const owners = listeningOwnerPids(fixture.port);
      if (!reportedOwners && owners.length > 0) {
        reportedOwners = true;
        console.log(`[ghost-gate] port ${fixture.port} owners after the kill: [${owners.join(',')}] (fixture was ${fixture.pid})`);
      }
      if (owners.length > 0 && owners.every(owner => owner === fixture.pid) && !processExists(fixture.pid)) {
        ownerUnderDeadPid = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const survivorsAfterKill = survivingProcesses(snapshot);
    // Classify the settled state. Exactly ONE non-ghost state may skip — the
    // port is free AND the pre-kill-verified sidecar chain is still alive —
    // because that is the measured bun >= 1.4 signature (spawned children no
    // longer inherit the listening socket). Every other non-ghost state is
    // malformed: a chain that died with the worker proves nothing about socket
    // inheritance, and a port held by an unrelated process, a shared ghost, or
    // a recycled fixture pid means the scenario did not form. Skipping any of
    // those would pass the gate without ever exercising recovery.
    const finalOwners = listeningOwnerPids(fixture.port);
    const state = classifyPostKillState({
      fixturePid: fixture.pid,
      fixtureAlive: processExists(fixture.pid),
      portOwners: finalOwners,
      chainSurvived: survivorsAfterKill.length > 0,
    });
    if (state.kind === 'runtime-capability-skip') {
      // RUNTIME CAPABILITY SKIP, not a vacuous pass. The fixture's chain was
      // verified before the kill and has survived it (asserted in the
      // classification above), so the only thing missing is the socket
      // inheritance the ghost is made of: bun >= 1.4 no longer hands the
      // listening socket to spawned children. Measured on one machine with
      // identical code — 1.3.6 leaves the port bound under the dead worker,
      // 1.4.0 releases it the moment the worker dies. Without inheritance
      // there is no ghost for the reclaim to recover, and failing here would
      // only report the runtime's behaviour, not the product's.
      console.log(
        `[ghost-gate] no ghost after the out-of-band kill: port ${fixture.port} is free and the verified sidecar chain ` +
          `survived (${describeProcesses(survivorsAfterKill)}). This runtime does not inherit the listening socket into ` +
          'sidecar children (bun >= 1.4), so the ghost-listener scenario cannot be constructed here — skipping the ' +
          'recovery assertions. On bun <= 1.3 the scenario does form and the assertions below run.'
      );
      return;
    }
    if (state.kind === 'malformed') {
      const describeOwner = (pid: number) => `${pid}${processExists(pid) ? ' (alive)' : ' (dead)'}`;
      expect(
        state.kind,
        `post-kill state is malformed (${state.reason}): port ${fixture.port} owners=` +
          `[${finalOwners.map(describeOwner).join(',')}] (fixture was ${fixture.pid}), sidecar chain ` +
          `${survivorsAfterKill.length > 0 ? 'survived' : 'died'} ` +
          `(${describeProcesses(survivorsAfterKill.length > 0 ? survivorsAfterKill : snapshot)}). ` +
          'Not the bun >= 1.4 capability signature — failing instead of skipping, because these ' +
          'states would pass the gate without exercising recovery.'
      ).toBe('ghost');
    }
    expect(ownerUnderDeadPid, 'port must be LISTENING under the dead fixture PID (ghost)').toBe(true);
    expect(processExists(fixture.pid)).toBe(false);
    expect(
      survivorsAfterKill.length > 0,
      `sidecar chain must survive the out-of-band kill: ${describeProcesses(snapshot)}`
    ).toBe(true);
    console.log(`[ghost-gate] ghost confirmed: port LISTENING under dead pid=${fixture.pid}; survivors: ${describeProcesses(survivorsAfterKill)}`);

    // Drive the PRODUCTION launcher. On main this returns 'dead' — no
    // reclaim exists, so the ghost blocks every spawn forever.
    const { ensureWorkerStarted } = await import('../../src/services/worker-spawner.js');
    const { resolveWorkerScriptPath } = await import('../../src/shared/worker-utils.js');
    const scriptPath = resolveWorkerScriptPath();
    expect(scriptPath).not.toBeNull();
    console.log(`[ghost-gate] driving production ensureWorkerStarted() on port ${fixture.port}`);
    const startedAt = Date.now();
    inflightEnsureStarted = ensureWorkerStarted(fixture.port, scriptPath!);
    const result = await withDeadline(inflightEnsureStarted, ENSURE_STARTED_DEADLINE_MS, 'ensureWorkerStarted');
    inflightEnsureStarted = null;
    console.log(`[ghost-gate] ensureWorkerStarted returned '${result}' after ${Date.now() - startedAt}ms`);
    expect(result, `ensureWorkerStarted must not give up on a reclaimable ghost (was: ${result})`).not.toBe('dead');

    // The reclaim must have taken the sidecar chain down with the ghost.
    const orphans = await waitForOrphansToClear(snapshot, ORPHAN_SETTLE_TIMEOUT_MS);
    expect(
      orphans.length === 0,
      `sidecar descendants survived the ghost reclaim: ${describeProcesses(orphans)}`
    ).toBe(true);

    // A NEW worker must now be serving the port.
    const { waitForHealth } = await import('../../src/services/infrastructure/HealthMonitor.js');
    expect(await waitForHealth(fixture.port, 90_000), 'replacement worker must answer health').toBe(true);
  }, RECOVERY_TIMEOUT_MS);
});
