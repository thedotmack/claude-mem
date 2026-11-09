/**
 * The auto-update supervisor must outlive a tree-kill of the process that
 * launched it (#3793: a worker recycle's tree-kill once SIGKILLed an
 * in-flight `bun install`, and the supervisor would be next in line).
 *
 * Shape, copied from worker-recycle-orphans.test.ts:
 *   1. a fixture CHILD plays the worker. It launches the supervisor through
 *      the worker's real launcher: launchAutoUpdateSupervisor with
 *      autoUpdateLaunchDeps, the effects productionAutoUpdateLaunchDeps returns
 *      behind the test tripwire, pointed at the fixture script instead of the
 *      worker's. It starts `auto-update-apply --detached-hop`; the hop starts
 *      the supervisor and exits, as in production. Only the installer and the
 *      worker probes are replaced, by harmless stand-ins
 *      (fixtures/auto-update-supervisor-host.ts). A launcher that started the
 *      supervisor without the detached hop fails this test;
 *   2. once the supervisor has recorded its pid and its stand-in installer is
 *      running, this test tree-kills the fixture with the same call the
 *      worker recycle uses: killProcessTree(pid, {signalMode: 'immediate'});
 *   3. the supervisor must still be running, and must write its outcome.
 *
 * The off baseline launches the same supervisor as a plain child, with no hop:
 * the same tree-kill must take it and its installer down before the update
 * applies. The kill reaches the installer first (leaves before ancestors), so
 * the supervisor may still record that the installer was killed before its
 * own SIGKILL lands; either way nothing applies, and that is what it asserts.
 *
 * Every file goes in a project-local scratch directory, which is also the
 * fixture's CLAUDE_MEM_DATA_DIR; nothing touches the real data dir or
 * ~/.claude, and no installer or worker runs.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readAutoUpdateState, type AutoUpdateState } from '../../src/services/auto-update/auto-update-state.js';
import { collectDescendantPids, killProcessTree } from '../../src/shared/kill-process-tree.js';
import { captureProcessStartToken, isSameProcess } from '../../src/shared/process-identity.js';
import { isPidAlive } from '../../src/supervisor/process-registry.js';

const TARGET = '15.13.0';
const PREVIOUS = '15.12.0';

/**
 * How long the stand-in installer runs: long enough that the tree-kill lands
 * while it runs, short enough to keep the test fast. Measured on the owner's
 * Mac (2026-11-08): the supervisor recorded its pid and started the stand-in
 * 0.17 s after the stand-in parent was started.
 */
const STAND_IN_INSTALLER_RUN_MS = 4_000;
/**
 * Bounds each wait below, so a broken launch fails the test instead of
 * hanging it. Each covers a few Bun processes loading the TypeScript sources
 * (all three were up within 0.2 s on the owner's Mac) plus the stand-in
 * installer's run; the margin is for a loaded CI runner.
 */
const STEP_TIMEOUT_MS = 30_000;
/** Poll interval for the state file and process table. */
const POLL_MS = 100;
/**
 * After the stand-in installer's run, how much longer the off baseline waits
 * before it reads the state: a surviving supervisor proves and records in
 * well under that (measured 2026-11-08: its outcome landed 0.02 s after a
 * 4 s stand-in run ended).
 */
const RECORDING_MARGIN_MS = 1_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'auto-update-supervisor-host.ts');
const scratchRoot = path.join(here, '..', '..', '.scratch', 'test-runs');

interface Run {
  directory: string;
  parent: ChildProcess;
  parentPid: number;
  statePath: string;
}

const runs: Run[] = [];
const pidsToReap = new Set<number>();

afterEach(async () => {
  for (const pid of pidsToReap) {
    if (!isPidAlive(pid)) continue;
    try {
      await killProcessTree(pid, { signalMode: 'immediate' });
    } catch (error: unknown) {
      // A process this test started outlived it; say so rather than leave it unnoticed.
      console.error(`could not reap pid ${pid} after the test: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  pidsToReap.clear();
  for (const run of runs.splice(0)) {
    if (run.parent.exitCode === null && run.parent.signalCode === null) run.parent.kill('SIGKILL');
    rmSync(run.directory, { recursive: true, force: true });
  }
});

async function startStandInParent(launch: 'hop' | 'direct'): Promise<Run> {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, `auto-update-tree-kill-${launch}-`));
  writeFileSync(path.join(directory, 'installed-version'), PREVIOUS);
  const parent = spawn(process.execPath, [FIXTURE, 'stand-in-parent'], {
    env: {
      ...process.env,
      // The launcher writes its state file and attempt log into DATA_DIR.
      CLAUDE_MEM_DATA_DIR: directory,
      AUTO_UPDATE_FIXTURE_DIR: directory,
      AUTO_UPDATE_FIXTURE_LAUNCH: launch,
      AUTO_UPDATE_FIXTURE_TARGET: TARGET,
      AUTO_UPDATE_FIXTURE_PREVIOUS: PREVIOUS,
      AUTO_UPDATE_FIXTURE_INSTALLER_MS: String(STAND_IN_INSTALLER_RUN_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const run: Run = { directory, parent, parentPid: parent.pid!, statePath: path.join(directory, 'auto-update-state.json') };
  runs.push(run);

  let stderr = '';
  parent.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const launchedStatePath = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stand-in parent did not launch in ${STEP_TIMEOUT_MS} ms\n${stderr}`)), STEP_TIMEOUT_MS);
    let buffered = '';
    parent.stdout?.on('data', (chunk) => {
      buffered += String(chunk);
      for (const line of buffered.split('\n').slice(0, -1)) {
        if (!line.startsWith('{')) continue;
        const payload = JSON.parse(line) as { event: string; message?: string; statePath?: string };
        if (payload.event === 'launched') { clearTimeout(timer); resolve(payload.statePath ?? ''); return; }
        if (payload.event === 'error') { clearTimeout(timer); reject(new Error(`stand-in parent failed: ${payload.message}\n${stderr}`)); return; }
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1);
    });
    parent.once('exit', (code) => { clearTimeout(timer); reject(new Error(`stand-in parent exited early with code ${code}\n${stderr}`)); });
  });
  // The real launcher wrote its state where this test reads it: the scratch data dir.
  expect(launchedStatePath).toBe(run.statePath);
  return run;
}

async function waitFor<T>(what: string, read: () => T | null, timeoutMs: number = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const readState = (run: Run): AutoUpdateState | null => existsSync(run.statePath) ? readAutoUpdateState(run.statePath) : null;

/** The supervisor has recorded its pid, and its stand-in installer is running. */
async function waitForInstallerRunning(run: Run): Promise<{ supervisorPid: number; installerPid: number }> {
  const supervisorPid = await waitFor('the supervisor to record its pid', () => readState(run)?.inFlightAttempt?.supervisorPid ?? null);
  const installerPid = await waitFor('the stand-in installer to start', () => {
    const pidsFile = path.join(run.directory, 'installer-pids');
    return existsSync(pidsFile) ? Number(readFileSync(pidsFile, 'utf-8').trim().split('\n')[0]) : null;
  });
  pidsToReap.add(supervisorPid);
  pidsToReap.add(installerPid);
  return { supervisorPid, installerPid };
}

async function waitUntilGone(pid: number): Promise<void> {
  await waitFor(`pid ${pid} to be gone`, () => (isPidAlive(pid) ? null : true));
}

describe('the auto-update supervisor and a tree-kill of the process that launched it', () => {
  it('survives it, launched through the worker\'s real launcher and its detached hop, and still writes its outcome', async () => {
    const run = await startStandInParent('hop');
    const { supervisorPid, installerPid } = await waitForInstallerRunning(run);
    // This test's own record of which process the supervisor is, to check after the kill.
    const supervisorStartToken = captureProcessStartToken(supervisorPid);
    expect(supervisorStartToken).not.toBeNull();

    // The hop has exited, so the supervisor is no longer in the launcher's tree:
    // the walk the recycle's tree-kill uses cannot find it.
    expect(isPidAlive(run.parentPid)).toBe(true);
    const launcherDescendants = await collectDescendantPids(run.parentPid);
    expect(launcherDescendants).not.toContain(supervisorPid);
    expect(launcherDescendants).not.toContain(installerPid);

    await killProcessTree(run.parentPid, { signalMode: 'immediate' });
    await waitUntilGone(run.parentPid);

    // Same process, by pid and start token, after the kill.
    expect(isPidAlive(supervisorPid)).toBe(true);
    expect(isSameProcess(supervisorPid, supervisorStartToken)).toBe(true);
    expect(isPidAlive(installerPid)).toBe(true);

    const outcome = await waitFor('the supervisor\'s outcome', () => readState(run)?.lastAttemptOutcome ?? null);
    expect(outcome).toMatchObject({ result: 'applied', targetVersion: TARGET, previousVersion: PREVIOUS });
    expect(readState(run)?.inFlightAttempt).toBeNull();
    expect(readFileSync(path.join(run.directory, 'installed-version'), 'utf-8')).toBe(TARGET);
    await waitUntilGone(supervisorPid);
  }, 4 * STEP_TIMEOUT_MS);

  it('off baseline: launched as a plain child with no hop, the same tree-kill takes it and its installer down before the update applies', async () => {
    const run = await startStandInParent('direct');
    const { supervisorPid, installerPid } = await waitForInstallerRunning(run);

    const launcherDescendants = await collectDescendantPids(run.parentPid);
    expect(launcherDescendants).toContain(supervisorPid);
    expect(launcherDescendants).toContain(installerPid);

    await killProcessTree(run.parentPid, { signalMode: 'immediate' });
    await waitUntilGone(run.parentPid);
    await waitUntilGone(supervisorPid);
    await waitUntilGone(installerPid);

    // Past the stand-in installer's whole run, the update never applied. The
    // supervisor either died before it recorded anything (the attempt is left
    // in flight, for the worker's gate 3), or saw its killed installer first
    // and recorded that; never an applied update.
    await new Promise((resolve) => setTimeout(resolve, STAND_IN_INSTALLER_RUN_MS + RECORDING_MARGIN_MS));
    const state = readState(run);
    expect(readFileSync(path.join(run.directory, 'installed-version'), 'utf-8')).toBe(PREVIOUS);
    if (state?.lastAttemptOutcome == null) {
      expect(state?.inFlightAttempt).toMatchObject({ supervisorPid });
    } else {
      expect(state.lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'installer-exit' });
      expect(state.lastAttemptOutcome.message).toContain('was ended by SIGKILL');
    }
  }, 4 * STEP_TIMEOUT_MS);
});
