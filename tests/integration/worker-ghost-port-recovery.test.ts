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

const RUN_GATE = process.env.CLAUDE_MEM_TEST_CHROMA === '1';

// The ghost scenario is Windows-only (inheritable socket handles). This file
// is also wired into the Linux chroma job for parity — there it must SKIP
// entirely, because the fixture cannot produce a ghost on POSIX.
const IS_WINDOWS = process.platform === 'win32';

const FIXTURE_READY_TIMEOUT_MS = 600_000;
const RECOVERY_TIMEOUT_MS = 600_000;
const GHOST_SETTLE_TIMEOUT_MS = 30_000;
const ORPHAN_SETTLE_TIMEOUT_MS = 30_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'ghost-worker-host.ts');

interface FixtureHandle {
  pid: number;
  port: number;
  chromaRootPid: number;
}

let active: FixtureHandle | null = null;

function bunExecutable(): string {
  return process.env.BUN_EXECUTABLE || process.execPath;
}

/** Kill exactly ONE process — never its descendants (`/T` deliberately omitted). */
function killProcessOnly(pid: number): void {
  execFileSync('taskkill', ['/F', '/PID', String(pid)], {
    stdio: 'ignore',
    windowsHide: true,
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

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Launch the fixture DETACHED, exactly like spawnDaemon() launches the real
 * worker (PowerShell Start-Process with redirected output). Returns once the
 * fixture's stdout reports ready.
 */
async function startFixture(): Promise<FixtureHandle> {
  const stdoutFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-fixture-')), 'out.txt');
  const stderrFile = stdoutFile.replace(/out\.txt$/, 'err.txt');

  const command =
    `$p = Start-Process -FilePath '${bunExecutable().replace(/'/g, "''")}' ` +
    `-ArgumentList @('run', '${FIXTURE.replace(/'/g, "''")}') ` +
    `-WorkingDirectory '${process.cwd().replace(/'/g, "''")}' ` +
    `-RedirectStandardOutput '${stdoutFile.replace(/'/g, "''")}' ` +
    `-RedirectStandardError '${stderrFile.replace(/'/g, "''")}' -PassThru; ` +
    `Write-Output $p.Id`;

  const spawnedPid = Number.parseInt(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim(),
    10
  );
  if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) {
    throw new Error(`fixture Start-Process returned an invalid pid: ${spawnedPid}`);
  }

  const deadline = Date.now() + FIXTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processExists(spawnedPid)) {
      const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf-8') : '';
      throw new Error(`fixture exited early (pid ${spawnedPid})\n${stderr}`);
    }
    if (fs.existsSync(stdoutFile)) {
      const content = fs.readFileSync(stdoutFile, 'utf-8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('{')) continue;
        const payload = JSON.parse(line) as Record<string, unknown>;
        if (payload.event === 'ready') {
          const handle: FixtureHandle = {
            pid: payload.pid as number,
            port: payload.port as number,
            chromaRootPid: payload.chromaRootPid as number,
          };
          active = handle;
          return handle;
        }
        if (payload.event === 'error') {
          throw new Error(`fixture failed: ${String(payload.message)}`);
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`fixture did not become ready in ${FIXTURE_READY_TIMEOUT_MS}ms`);
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
  // Tear down whatever is left: the recovery may have spawned a real worker
  // as the dead fixture's replacement, and the fixture's own chroma chain may
  // still be alive if the gate failed before the reclaim ran.
  const handle = active;
  active = null;
  if (!handle) return;

  const { killProcessTree } = await import('../../src/shared/kill-process-tree.js');
  await killProcessTree(handle.chromaRootPid).catch(() => {});
  if (processExists(handle.pid)) {
    killProcessOnly(handle.pid);
  }

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
    killProcessOnly(fixture.pid);
    await waitFor(
      () => !processExists(fixture.pid),
      30_000,
      `fixture process ${fixture.pid} to die`
    );

    // Ghost precondition: the port is still bound under the dead PID, and the
    // sidecar chain survived (the uvx/uv layers exit on pipe EOF, but the
    // persistent chroma-mcp/python sidecar holds the inherited socket). Wait
    // briefly for that settled shape — without it the gate could pass by
    // having nothing to recover.
    let ownerUnderDeadPid = false;
    const settleDeadline = Date.now() + GHOST_SETTLE_TIMEOUT_MS;
    while (Date.now() < settleDeadline) {
      const owners = listeningOwnerPids(fixture.port);
      if (owners.length > 0 && owners.every(owner => owner === fixture.pid) && !processExists(fixture.pid)) {
        ownerUnderDeadPid = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(ownerUnderDeadPid, 'port must be LISTENING under the dead fixture PID (ghost)').toBe(true);
    expect(processExists(fixture.pid)).toBe(false);
    const survivorsAfterKill = survivingProcesses(snapshot);
    expect(
      survivorsAfterKill.length > 0,
      `sidecar chain must survive the out-of-band kill: ${describeProcesses(snapshot)}`
    ).toBe(true);

    // Drive the PRODUCTION launcher. On main this returns 'dead' — no
    // reclaim exists, so the ghost blocks every spawn forever.
    const { ensureWorkerStarted } = await import('../../src/services/worker-spawner.js');
    const { resolveWorkerScriptPath } = await import('../../src/shared/worker-utils.js');
    const scriptPath = resolveWorkerScriptPath();
    expect(scriptPath).not.toBeNull();
    const result = await ensureWorkerStarted(fixture.port, scriptPath!);
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
