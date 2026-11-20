/**
 * The auto-update supervisor: moves the install to the target version with
 * the installer users run themselves (`npx claude-mem@<version> update`), as
 * `npx --yes --no-workspaces --package=claude-mem@<version> claude-mem update`
 * run from a new folder of its own (auto-update-launch.ts
 * claudeMemUpdateInvocation, makeAutoUpdateInstallerRunFolder), proves the
 * switch, and puts the previous version back when it fails.
 *
 * It runs in its own process, from the worker script of the version being
 * replaced, and never as the worker's descendant: the worker starts a detached
 * hop, the hop starts this supervisor detached and exits at once
 * (auto-update-launch.ts). A worker restart, recycle or tree-kill therefore
 * cannot take it down mid-install (#3793).
 *
 * Every effect is injected (AutoUpdateApplyDeps), so `bun test` drives each
 * path directly. The production effects are wired in auto-update-launch.ts.
 *
 * What it does once the target's installer has ended (exit 0, non-zero, or
 * killed at its deadline), read from the places the install's version is
 * recorded (InstallVersionsRead: the resolver, the user-scope registration in
 * installed_plugins.json, the marketplace copy's package.json, plugin manifest
 * and worker script) and compared with what they held before the installer:
 *  - the installer may still be running after the kill: nothing else runs
 *    (restore_failed, installer-still-running);
 *  - the install resolves to the target and a worker on it finished starting:
 *    applied;
 *  - nothing changed: nothing switched, so a worker is proven on the previous
 *    version (failed; restore_failed when none finishes starting), and the
 *    target is not blocked: it is tried again at the next due check;
 *  - something changed to a version newer than the target: another updater
 *    moved the install on, so nothing is stamped or reinstalled (failed,
 *    superseded-by-another-update);
 *  - anything else, a half-replaced marketplace copy included: the switch
 *    started. When the database's schema stamp is newer than the previous
 *    version knows, the target is kept and its worker waited for again
 *    (applied once it finishes starting; otherwise restore_failed,
 *    restore-blocked-by-schema, naming the forward fix); when the stamp cannot
 *    be read, nothing more runs (restore_failed, schema-stamp-unreadable);
 *    otherwise the previous version is restored (restored, or restore_failed).
 *    Right before the previous version's installer starts, the readings and
 *    the stamp are read again, and the same rules stop it: a reading moved to
 *    a version newer than the target (failed, superseded-by-another-update),
 *    or a stamp the previous version cannot open (restore_failed,
 *    restore-blocked-by-schema or schema-stamp-unreadable).
 * Every failure after the switch started blocks the target. Every
 * restore_failed outcome records its fix and when to run it
 * (auto-update-state-file.ts AutoUpdateFixCommandWhen): now; once an
 * installer still running has finished; or, when the target failed on its
 * own and the previous version cannot be put back, the forward fix once a
 * release newer than the target is out (supervisorFix,
 * restorePreviousVersion).
 *
 * Before each proof that a worker finished starting, a worker is started on
 * the version the install resolves to when no worker process runs, and never
 * while one runs, answering or not (startWorkerIfNoneRuns).
 *
 * The state file is shared with the worker's check (auto-update-check.ts,
 * gate 3). The supervisor writes it at three points:
 *  1. at start, its pid and the phase it starts in, installing the target,
 *     into the in-flight attempt the worker wrote, only while that attempt is
 *     still its own (same startedAt) and unclaimed;
 *  2. right before the previous version's installer runs, the phase
 *     restoring the previous version, only while the attempt in flight is
 *     still its own and claimed by it; with none or another in flight it
 *     writes nothing and logs (recordSupervisorPhase);
 *  3. at the end, its outcome, replacing the in-flight attempt only while it is
 *     still its own or already null (the worker recorded it vanished). With a
 *     different attempt in flight it writes nothing and logs.
 * Gate 3 reads the phase for an attempt whose supervisor vanished, to tell a
 * restore that had begun from an attempt that changed nothing.
 */

import { writeFileSync } from 'fs';
import path from 'path';
import { compareVersionsDescending } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { INSTALLED_VERSION_PATTERN, type NpmPublicationRead } from './auto-update-check.js';
import { ORPHANED_MARKER_FILENAME } from './auto-update-install-shape.js';
import {
  AUTO_UPDATE_FORWARD_FIX,
  AUTO_UPDATE_FORWARD_FIX_COMMAND,
  autoUpdateFixCommand,
  type AutoUpdateFix,
  type AutoUpdateSupervisorPhase,
} from './auto-update-state-file.js';
import type { AutoUpdateAttemptOutcome, AutoUpdateState } from './auto-update-state.js';

// The fix commands live with the state file's shape, and the marker with the
// install-shape check, so the SessionStart launcher can use them without this
// module; re-exported for its callers.
export { AUTO_UPDATE_FORWARD_FIX_COMMAND, ORPHANED_MARKER_FILENAME, autoUpdateFixCommand };

/** One attempt, as the worker launched it (auto-update-launch.ts launchAutoUpdateSupervisor). */
export interface AutoUpdateApplyAttempt {
  targetVersion: string;
  previousVersion: string;
  /** The in-flight attempt's startedAt, passed on by the worker: the attempt's identity in the state file. */
  startedAt: number;
}

/** Where an attempt failed: lastAttemptOutcome.failureStage, and failure_stage in telemetry. */
export type AutoUpdateApplyFailureStage =
  /** Before the target's installer started, the install no longer resolved to, or was no longer registered at, the previous version. Nothing ran. */
  | 'install-moved-before-start'
  /** Windows: no npx was found on PATH, so no installer could be run. */
  | 'npx-not-found'
  /** The installer's own folder could not be made, or its package.json not written, so no installer was started. */
  | 'installer-folder'
  /** The installer process could not be started (a throw from spawn, or an 'error' event before it exited). */
  | 'installer-spawn'
  /** It exited non-zero, or a signal it did not get from the supervisor ended it. */
  | 'installer-exit'
  /** It ran past AUTO_UPDATE_INSTALLER_DEADLINE_MS, so its process tree was killed. */
  | 'installer-timeout'
  /** It ran past its deadline and was still running after the tree-kill, so no other installer was started. */
  | 'installer-still-running'
  /** It exited 0, but the install does not resolve to the target, or no worker on it finished starting. */
  | 'prove-install'
  /** A version newer than the target appeared while the installer ran, or before the previous version's installer started: another updater moved the install on. */
  | 'superseded-by-another-update'
  /** The database carries a schema stamp newer than the previous version knows, so it was not reinstalled. */
  | 'restore-blocked-by-schema'
  /** The database's schema stamp could not be read, so the previous version was not reinstalled. */
  | 'schema-stamp-unreadable'
  /** Something the supervisor itself did threw. */
  | 'supervisor-exception';

/** What became of the previous version after a failure: restore_result in telemetry. */
export type AutoUpdateRestoreResult =
  /** Nothing switched: the install reads as it did before, and a worker on the previous version finished starting. */
  | 'not-needed'
  /** Nothing switched, but no worker on the previous version finished starting. */
  | 'previous-worker-unproven'
  /** No restore was tried; failure_stage says why (the install moved first, another update, the schema stamp, an installer still running). */
  | 'not-attempted'
  /** The previous version's installer ran, and a worker on the previous version finished starting. */
  | 'restored'
  /** npm does not show the previous version as published by the workflow (gate 7), so its installer was not run. */
  | 'previous-not-published'
  /** npm's metadata for the previous version could not be read, so its installer was not run. */
  | 'previous-publication-unknown'
  /** The previous version's installer could not start (its folder included), exited non-zero, ran past its deadline, or was still running after it. */
  | 'restore-installer-failed'
  /** Its installer exited 0, but the install does not resolve to the previous version, or no worker on it finished starting. */
  | 'restore-unproven'
  /** The supervisor threw before it could tell. */
  | 'unknown';

/** One installer run (auto-update-launch.ts runAutoUpdateInstaller). */
export type AutoUpdateInstallerRun =
  | { kind: 'exited'; exitCode: number | null; signal: string | null }
  | { kind: 'spawn-failed'; message: string }
  /** Windows only: npx is not on PATH (auto-update-launch.ts claudeMemUpdateInvocation). Nothing was started. */
  | { kind: 'npx-not-found'; message: string }
  /** The run's own folder could not be made (auto-update-launch.ts makeAutoUpdateInstallerRunFolder). Nothing was started. */
  | { kind: 'folder-failed'; message: string }
  /**
   * Ran past its deadline and its tree was killed. killError: why the
   * tree-kill threw, when it did. installerStillRunning: the installer's own
   * process had not exited INSTALLER_EXIT_AFTER_KILL_WAIT_MS after the kill.
   */
  | { kind: 'timed-out'; deadlineMs: number; killError: string | null; installerPid: number | null; installerStillRunning: boolean };

/** A worker on a version finished starting, or the reason none did. */
export type AutoUpdateWorkerProof =
  | { ok: true; pid: number }
  /** startupFailed: the worker reported that its startup failed; otherwise none finished starting before the ceiling. */
  | { ok: false; startupFailed: boolean; detail: string };

/** The places the install's version is recorded, read at one moment (auto-update-launch.ts readInstallVersions). */
export interface InstallVersionsRead {
  /** The version the resolver picks (worker-utils.ts resolvePluginRoot), null when nothing resolves. */
  resolved: string | null;
  /**
   * The versions of the registration the npx installer writes for
   * claude-mem@thedotmack in Claude Code's installed_plugins.json, its
   * user-scope entries (prune-cache.ts readUserScopeRegisteredCacheVersions).
   * Project- and local-scope entries are left out: no installer run writes them.
   */
  registered: { kind: 'read'; versions: string[] } | { kind: 'unreadable'; message: string };
  marketplace: MarketplaceCopyRead;
}

/**
 * The marketplace copy (install.ts copyPluginToMarketplace), read where a
 * copy that stopped partway shows. The installer removes and recopies plugin/
 * and the copy's other folders one by one and writes package.json last, so a
 * run that fails partway through (EBUSY or EPERM on Windows, a full disk)
 * leaves package.json at the old version while plugin/ is missing, half-copied
 * or already the new one's.
 */
export interface MarketplaceCopyRead {
  /** package.json's version, the copy's version to the resolver (worker-utils.ts readPackageVersion); null when missing or versionless. */
  packageVersion: string | null;
  /** plugin/.claude-plugin/plugin.json's version, which the installer reads to tell an update from a fresh install; null when missing or versionless. */
  pluginManifestVersion: string | null;
  /** Whether plugin/scripts/worker-service.cjs exists: the script the resolver, the installer's worker start, Pi and DSH start (harness-worker.ts). */
  hasWorkerScript: boolean;
}

/** Whether a worker process runs for this install (auto-update-launch.ts readRunningWorker). */
export type RunningWorkerRead =
  /** One answers GET /api/health on the install's port. */
  | { kind: 'answering'; pid: number }
  /**
   * None answers, but the PID file names a live claude-mem worker: one still
   * starting answers nothing while its synchronous migrations hold its event
   * loop.
   */
  | { kind: 'alive-not-answering'; pid: number }
  | { kind: 'none' };

/** The database's schema stamp, read without writing to it (auto-update-launch.ts readDatabaseSchemaStamp). */
export type DatabaseSchemaStampRead =
  | { kind: 'stamped'; schemaVersion: number }
  /** No database file yet: nothing the previous version could refuse. */
  | { kind: 'no-database' }
  | { kind: 'unreadable'; message: string };

/** What writing the `.orphaned_at` marker did. */
export type OrphanedMarkerResult =
  | { kind: 'stamped' }
  /** Claude Code or an earlier run already stamped it; its time is kept, so the 14-day clean-up is not pushed back. */
  | { kind: 'already-stamped' }
  /** The version directory does not exist: nothing resolves to it from the cache. */
  | { kind: 'no-directory' }
  | { kind: 'failed'; message: string };

export interface AutoUpdateApplyDeps {
  now: () => number;
  readState: () => AutoUpdateState;
  writeState: (state: AutoUpdateState) => void;
  /** This supervisor's pid, recorded in the in-flight attempt. */
  processId: number;
  /** The pid of the worker answering on this install's port, or null when none answers (restart-verify.ts getCurrentWorkerPid). */
  getCurrentWorkerPid: () => Promise<number | null>;
  /**
   * One run of `npx --yes --no-workspaces --package=claude-mem@<version>
   * claude-mem update` from a new folder of its own, its output appended to
   * the attempt log, under the installer deadline. A folder that cannot be
   * made comes back as folder-failed, never as a throw.
   */
  runInstaller: (version: string) => Promise<AutoUpdateInstallerRun>;
  /**
   * A worker other than `oldPid` (when one is given) reports `version` and
   * that it finished starting (auto-update-launch.ts autoUpdateWorkerProof).
   */
  proveWorkerOnVersion: (oldPid: number | null, version: string) => Promise<AutoUpdateWorkerProof>;
  readInstallVersions: () => InstallVersionsRead;
  readDatabaseSchemaStamp: () => DatabaseSchemaStampRead;
  /** The newest schema this supervisor's code knows (connection.ts LATEST_SCHEMA_VERSION): the previous version's, whose code it runs. */
  supervisorSchemaVersion: number;
  /** <plugin cache root>/<version> (npx-cli/utils/paths.ts pluginCacheDirectory). */
  pluginCacheDirectory: (version: string) => string;
  /** Write the epoch-ms `.orphaned_at` marker into a version directory (writeOrphanedMarker). */
  stampOrphaned: (versionDirectory: string, epochMs: number) => OrphanedMarkerResult;
  /** Whether a worker process runs for this install, answering or not (auto-update-launch.ts readRunningWorker). */
  readRunningWorker: () => Promise<RunningWorkerRead>;
  /**
   * Start a worker from the script the install resolves to now
   * (worker-spawner.ts ensureWorkerStarted). Called only when readRunningWorker
   * finds none (startWorkerIfNoneRuns says why).
   */
  ensureWorkerStarted: () => Promise<'ready' | 'warming' | 'dead'>;
  /** Gate 7's test, for the previous version (auto-update-check.ts readNpmPublication). */
  readNpmPublication: (version: string) => Promise<NpmPublicationRead>;
  /** telemetry.ts captureEvent: consent-gated and never throws. */
  captureEvent: (event: string, properties: Record<string, unknown>) => void;
}

export type AutoUpdateApplyResult =
  /** The attempt in flight is not this supervisor's: it ran nothing and wrote nothing. */
  | { kind: 'not-claimed'; reason: string }
  | {
      kind: 'finished';
      outcome: AutoUpdateAttemptOutcome;
      restoreResult: AutoUpdateRestoreResult | null;
      /** 'left-to-another-attempt': a different attempt was in flight at the end, so the outcome was not written. */
      recorded: 'recorded' | 'left-to-another-attempt';
    };

/**
 * The production stampOrphaned: writes the epoch-ms marker Claude Code writes,
 * only into a directory that exists and only when it is not there yet. Never
 * deletes anything: pruning is the installer's job (prune-cache.ts).
 */
export function writeOrphanedMarker(versionDirectory: string, epochMs: number): OrphanedMarkerResult {
  try {
    writeFileSync(path.join(versionDirectory, ORPHANED_MARKER_FILENAME), String(epochMs), { flag: 'wx' });
    return { kind: 'stamped' };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return { kind: 'already-stamped' };
    if (code === 'ENOENT') return { kind: 'no-directory' };
    logger.warn('AUTO_UPDATE', 'Could not write the .orphaned_at marker; the outcome records it', { versionDirectory, code },
      error instanceof Error ? error : new Error(String(error)));
    return { kind: 'failed', message: errorMessageOf(error) };
  }
}

/**
 * Run one attempt and record its outcome. Throws only when the state file
 * cannot be read or written (claiming or recording), after logging what it
 * could not record; every other failure becomes the recorded outcome.
 */
export async function applyAutoUpdate(attempt: AutoUpdateApplyAttempt, deps: AutoUpdateApplyDeps): Promise<AutoUpdateApplyResult> {
  const claim = claimInFlightAttempt(attempt, deps);
  if (!claim.claimed) {
    logger.warn('AUTO_UPDATE', 'Auto-update supervisor is not the attempt in flight; it runs nothing and writes nothing', {
      ...describeAttempt(attempt),
      reason: claim.reason,
    });
    return { kind: 'not-claimed', reason: claim.reason };
  }
  logger.info('AUTO_UPDATE', `Auto-update supervisor started: ${attempt.previousVersion} → ${attempt.targetVersion}`, {
    ...describeAttempt(attempt),
    supervisorPid: deps.processId,
  });

  // The phase the claim recorded; restorePreviousVersion moves it on.
  const progress: SupervisorProgress = { phase: 'installing-target' };
  let finished: FinishedAttempt;
  try {
    finished = await installProveAndRestore(attempt, deps, progress);
  } catch (error: unknown) {
    logger.error('AUTO_UPDATE', 'Auto-update supervisor stopped on an unexpected error', describeAttempt(attempt),
      error instanceof Error ? error : new Error(String(error)));
    finished = await outcomeAfterUnexpectedError(attempt, deps, error, progress.phase);
  }

  let recorded: 'recorded' | 'left-to-another-attempt';
  try {
    recorded = recordFinalOutcome(attempt, finished, deps);
  } catch (error: unknown) {
    logger.error('AUTO_UPDATE', 'Auto-update supervisor could not record its outcome in the state file', {
      ...describeAttempt(attempt),
      result: finished.outcome.result,
      failureStage: finished.outcome.failureStage,
      outcomeMessage: finished.outcome.message,
    }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    sendOutcomeTelemetry(attempt, finished, deps);
  }
  logOutcome(attempt, finished.outcome);
  return { kind: 'finished', outcome: finished.outcome, restoreResult: finished.restoreResult, recorded };
}

type ClaimResult = { claimed: true } | { claimed: false; reason: string };

/**
 * Record this supervisor's pid in the attempt the worker wrote, with the phase
 * it starts in: installing the target, before the target's installer runs
 * (AutoUpdateInFlightAttempt.supervisorPhase). Anything else in flight (none,
 * another startedAt, other versions, or a supervisor already recorded) means
 * this process is a stale or duplicate launch, so it claims nothing.
 */
function claimInFlightAttempt(attempt: AutoUpdateApplyAttempt, deps: AutoUpdateApplyDeps): ClaimResult {
  const state = deps.readState();
  const inFlight = state.inFlightAttempt;
  if (inFlight === null) {
    return { claimed: false, reason: 'no attempt is in flight: the worker cleared it (its launch failed, or it recorded the attempt as ended)' };
  }
  if (inFlight.startedAt !== attempt.startedAt) {
    return { claimed: false, reason: `the attempt in flight started at ${new Date(inFlight.startedAt).toISOString()}, not ${new Date(attempt.startedAt).toISOString()}` };
  }
  if (inFlight.targetVersion !== attempt.targetVersion || inFlight.previousVersion !== attempt.previousVersion) {
    return { claimed: false, reason: `the attempt in flight moves ${inFlight.previousVersion} → ${inFlight.targetVersion}, not ${attempt.previousVersion} → ${attempt.targetVersion}` };
  }
  if (inFlight.supervisorPid !== null) {
    return { claimed: false, reason: `supervisor pid ${inFlight.supervisorPid} already runs this attempt` };
  }
  state.inFlightAttempt = { ...inFlight, supervisorPid: deps.processId, supervisorPhase: 'installing-target' };
  deps.writeState(state);
  return { claimed: true };
}

/** How far this supervisor has got, kept as it goes, so its error path knows it too (outcomeAfterUnexpectedError). */
interface SupervisorProgress {
  phase: AutoUpdateSupervisorPhase;
}

/**
 * Record how far this supervisor got in the attempt in flight
 * (AutoUpdateInFlightAttempt.supervisorPhase), by the rules its claim and its
 * final write go by: only while that attempt is still its own (same
 * startedAt) and claimed by it. With none in flight, or another, it writes
 * nothing and logs, as the final write does, and the run goes on: the final
 * write decides what it records then. A read or write that fails is logged
 * and the run goes on too. Stopping would leave the install half-switched with
 * nothing to put it back, while a phase not recorded only leaves gate 3 to
 * judge a vanished attempt by the phase recorded before.
 */
function recordSupervisorPhase(attempt: AutoUpdateApplyAttempt, phase: AutoUpdateSupervisorPhase, deps: AutoUpdateApplyDeps): void {
  try {
    const state = deps.readState();
    const inFlight = state.inFlightAttempt;
    if (inFlight === null || inFlight.startedAt !== attempt.startedAt || inFlight.supervisorPid !== deps.processId) {
      logger.warn('AUTO_UPDATE', 'The attempt in flight is no longer this supervisor\'s, so it does not record how far it got', {
        ...describeAttempt(attempt),
        phase,
        inFlightStartedAt: inFlight === null ? null : new Date(inFlight.startedAt).toISOString(),
        inFlightSupervisorPid: inFlight?.supervisorPid ?? null,
      });
      return;
    }
    state.inFlightAttempt = { ...inFlight, supervisorPhase: phase };
    deps.writeState(state);
  } catch (error: unknown) {
    logger.error('AUTO_UPDATE', 'Auto-update supervisor could not record how far it got in the state file, and goes on', { ...describeAttempt(attempt), phase },
      error instanceof Error ? error : new Error(String(error)));
  }
}

interface AttemptFailure {
  stage: AutoUpdateApplyFailureStage;
  message: string;
}

interface FinishedAttempt {
  outcome: AutoUpdateAttemptOutcome;
  restoreResult: AutoUpdateRestoreResult | null;
  /**
   * Whether the target goes on versionsThatFailedToApply, never retried
   * automatically. False when nothing of the target was written: the install
   * moved before the installer started, or nothing switched
   * (recoverOnPreviousVersion says why that is not blocked), including after
   * an unexpected error (outcomeAfterUnexpectedError).
   */
  blocksVersion: boolean;
}

async function installProveAndRestore(attempt: AutoUpdateApplyAttempt, deps: AutoUpdateApplyDeps, progress: SupervisorProgress): Promise<FinishedAttempt> {
  const { targetVersion, previousVersion } = attempt;

  // The worker read the install when it decided; anything may have changed
  // since (a manual update, Claude Code's own updater). The installer would
  // then move an install this attempt was never meant for.
  const beforeInstall = deps.readInstallVersions();
  if (!resolvesAndIsRegisteredOnlyAt(beforeInstall, previousVersion)) {
    return {
      outcome: failedOutcome(attempt, deps.now(), 'failed',
        { stage: 'install-moved-before-start', message: `Before ${targetVersion}'s installer started, the install no longer resolved to and was registered only at ${previousVersion}` },
        `${describeInstallVersions(beforeInstall)} Nothing was run; ${targetVersion} is tried again at the next due check.`),
      restoreResult: 'not-attempted',
      blocksVersion: false,
    };
  }

  const workerPidBeforeInstall = await deps.getCurrentWorkerPid();
  const install = await deps.runInstaller(targetVersion);
  if (install.kind === 'timed-out' && install.installerStillRunning) {
    // Nothing read now is settled while it runs, and a second installer would
    // write the same files: stop here.
    const fix: AutoUpdateFix = { ...await supervisorFix(attempt, deps), when: 'once-the-running-update-has-finished' };
    return {
      outcome: restoreFailedOutcome(attempt, deps.now(),
        { stage: 'installer-still-running', message: describeInstallerStillRunning(install, targetVersion) },
        `No other installer was started and nothing was stamped. ${fixSentence(fix, targetVersion)}`, fix),
      restoreResult: 'not-attempted',
      blocksVersion: true,
    };
  }

  const installFailure = installerFailure(install, targetVersion);
  let failure: AttemptFailure;
  if (installerNeverStarted(install)) {
    // Nothing ran, so there is nothing to prove.
    failure = installFailure!;
  } else {
    const proven = await proveInstalledVersion(targetVersion, workerPidBeforeInstall, deps);
    if (proven.proven) {
      return {
        outcome: {
          result: 'applied',
          targetVersion,
          previousVersion,
          finishedAt: deps.now(),
          message: `Updated ${previousVersion} → ${targetVersion}: the installer ${describeInstallerEnding(install)}, the install resolves to ${targetVersion}, and a worker on it finished starting (pid ${proven.pid}).`,
        },
        restoreResult: null,
        blocksVersion: true,
      };
    }
    failure = installFailure !== null
      ? { stage: installFailure.stage, message: `${installFailure.message}, and ${proven.why}` }
      : { stage: 'prove-install', message: `${targetVersion}'s installer exited 0, but ${proven.why}` };
  }

  const afterInstall = deps.readInstallVersions();
  const change = classifyInstallChange(beforeInstall, afterInstall, targetVersion);
  if (change.kind === 'nothing-switched') return recoverOnPreviousVersion(attempt, failure, deps);
  if (change.kind === 'superseded') {
    return {
      outcome: failedOutcome(attempt, deps.now(), 'failed',
        { stage: 'superseded-by-another-update', message: failure.message },
        `${describeInstallVersions(afterInstall)} ${change.newerVersion} is newer than ${targetVersion}: another update moved the install on while this one ran, so nothing was stamped or reinstalled.`),
      restoreResult: 'not-attempted',
      blocksVersion: true,
    };
  }
  return restorePreviousVersion(attempt, failure, afterInstall, deps, progress);
}

/** No installer process was started, so nothing of the version was written and there is nothing to prove. */
function installerNeverStarted(run: AutoUpdateInstallerRun): run is Extract<AutoUpdateInstallerRun, { kind: 'spawn-failed' | 'npx-not-found' | 'folder-failed' }> {
  return run.kind === 'spawn-failed' || run.kind === 'npx-not-found' || run.kind === 'folder-failed';
}

/** Why an installer run failed, or null when it exited 0. */
function installerFailure(run: AutoUpdateInstallerRun, version: string): AttemptFailure | null {
  if (run.kind === 'npx-not-found') {
    return { stage: 'npx-not-found', message: `the installer for ${version} could not be run: ${run.message}` };
  }
  if (run.kind === 'folder-failed') {
    return { stage: 'installer-folder', message: `the installer for ${version} could not be run: ${run.message}` };
  }
  if (run.kind === 'spawn-failed') {
    return { stage: 'installer-spawn', message: `the installer for ${version} could not be started: ${run.message}` };
  }
  if (run.kind === 'timed-out') {
    return { stage: 'installer-timeout', message: `the installer for ${version} ${describeInstallerEnding(run)}` };
  }
  if (run.exitCode === 0) return null;
  return { stage: 'installer-exit', message: `the installer for ${version} ${describeInstallerEnding(run)}` };
}

function describeInstallerEnding(run: Extract<AutoUpdateInstallerRun, { kind: 'exited' | 'timed-out' }>): string {
  if (run.kind === 'timed-out') {
    const deadline = `ran past its ${Math.round(run.deadlineMs / MILLISECONDS_PER_SECOND)} s deadline`;
    return run.killError === null
      ? `${deadline} and its process tree was killed`
      : `${deadline}; killing its process tree failed (${run.killError}), but the installer then exited`;
  }
  if (run.exitCode === 0) return 'exited 0';
  return run.exitCode === null ? `was ended by ${run.signal ?? 'an unknown signal'}` : `exited with code ${run.exitCode}`;
}

function describeInstallerStillRunning(run: Extract<AutoUpdateInstallerRun, { kind: 'timed-out' }>, version: string): string {
  const kill = run.killError === null ? 'its process tree was killed' : `killing its process tree failed (${run.killError})`;
  return `the installer for ${version} ran past its ${Math.round(run.deadlineMs / MILLISECONDS_PER_SECOND)} s deadline and ${kill}, `
    + `but its process (pid ${run.installerPid ?? 'unknown'}) was still running after it`;
}

type ProvenInstall = { proven: true; pid: number } | { proven: false; why: string };

/**
 * The install resolves to `version` and a worker on it, other than
 * `workerPidBefore`, finished starting. When no worker process runs, one is
 * started first, on the version the install resolves to: an installer can end
 * without starting one, and the proof would then wait out its ceiling for a
 * worker nothing starts. A non-interactive run that finds no marketplace copy
 * (a cache-only install, #3534) takes itself for a fresh install and skips
 * "Starting worker daemon" after it stopped the old worker (install.ts
 * shouldSkipWorkerAutostart), and a run that aborts after its cache folder is
 * complete never reaches that step.
 */
async function proveInstalledVersion(version: string, workerPidBefore: number | null, deps: AutoUpdateApplyDeps): Promise<ProvenInstall> {
  const resolved = deps.readInstallVersions().resolved;
  if (resolved !== version) return { proven: false, why: `the install resolves to ${resolved ?? 'no version'}, not ${version}` };
  const start = await startWorkerIfNoneRuns(deps);
  const proof = await deps.proveWorkerOnVersion(workerPidBefore, version);
  if (proof.ok) return { proven: true, pid: proof.pid };
  return { proven: false, why: `${describeWorkerStart(start)}${describeProofFailure(proof, version)}` };
}

type WorkerStartBeforeProof =
  | { kind: 'already-running'; worker: Exclude<RunningWorkerRead, { kind: 'none' }> }
  | { kind: 'started'; result: 'ready' | 'warming' | 'dead' };

/**
 * Start a worker when no worker process runs. Never while one runs, answering
 * or not: ensureWorkerStarted's wedged-port reclaim (worker-spawner.ts, then
 * port-reclaim.ts reclaimWedgedOwnedWorker) kills a worker of ours that has
 * been silent past its boot grace, and a worker still migrating its database
 * is exactly that. The proof that follows already waits for a worker that is
 * still starting, up to the worker's own startup bounds.
 */
async function startWorkerIfNoneRuns(deps: AutoUpdateApplyDeps): Promise<WorkerStartBeforeProof> {
  const running = await deps.readRunningWorker();
  if (running.kind !== 'none') return { kind: 'already-running', worker: running };
  return { kind: 'started', result: await deps.ensureWorkerStarted() };
}

/** What happened before a proof that failed, as the start of its reason ('' when a worker answered and nothing was started). */
function describeWorkerStart(start: WorkerStartBeforeProof): string {
  if (start.kind === 'started') return `after starting a worker (${start.result}), `;
  if (start.worker.kind === 'alive-not-answering') {
    return `a worker process (pid ${start.worker.pid}) was running but not answering, so none was started or stopped, and `;
  }
  return '';
}

function describeProofFailure(proof: Extract<AutoUpdateWorkerProof, { ok: false }>, version: string): string {
  return proof.startupFailed
    ? `the worker on ${version} reported that its startup failed (${proof.detail})`
    : `no worker on ${version} finished starting within the startup ceiling (${proof.detail})`;
}

type InstallChange =
  | { kind: 'nothing-switched' }
  | { kind: 'superseded'; newerVersion: string }
  | { kind: 'switch-started' };

/**
 * How the install changed between two readings: while the target's installer
 * ran, and again before the previous version's installer starts
 * (readAgainBeforeTheRestore, which acts only on a superseded result). Before
 * the target's installer ran the install resolved to and was registered only
 * at the previous version (checked above);
 * the marketplace copy is compared with what it held then, because an install
 * can run without one (the cache alone) or carry one of another version (a
 * Claude Code marketplace clone). All three of its readings count: the
 * installer writes its package.json last, so a copy that failed partway
 * through shows only as a plugin manifest of another version or a worker
 * script gone, and that is a switch that started.
 */
function classifyInstallChange(before: InstallVersionsRead, after: InstallVersionsRead, targetVersion: string): InstallChange {
  const changedTo: string[] = [];
  if (after.resolved !== before.resolved && after.resolved !== null) changedTo.push(after.resolved);
  const beforeRegistered = before.registered.kind === 'read' ? before.registered.versions : [];
  const registrationChanged = after.registered.kind !== 'read'
    || before.registered.kind !== 'read'
    || after.registered.versions.join('\n') !== beforeRegistered.join('\n');
  if (after.registered.kind === 'read') changedTo.push(...after.registered.versions.filter((version) => !beforeRegistered.includes(version)));
  const marketplaceBefore = before.marketplace;
  const marketplaceAfter = after.marketplace;
  if (marketplaceAfter.packageVersion !== marketplaceBefore.packageVersion && marketplaceAfter.packageVersion !== null) {
    changedTo.push(marketplaceAfter.packageVersion);
  }
  if (marketplaceAfter.pluginManifestVersion !== marketplaceBefore.pluginManifestVersion && marketplaceAfter.pluginManifestVersion !== null) {
    changedTo.push(marketplaceAfter.pluginManifestVersion);
  }
  const marketplaceChanged = marketplaceAfter.packageVersion !== marketplaceBefore.packageVersion
    || marketplaceAfter.pluginManifestVersion !== marketplaceBefore.pluginManifestVersion
    || marketplaceAfter.hasWorkerScript !== marketplaceBefore.hasWorkerScript;
  const unchanged = after.resolved === before.resolved && !registrationChanged && !marketplaceChanged;
  if (unchanged) return { kind: 'nothing-switched' };
  const newerVersion = firstVersionNewerThan(changedTo, targetVersion);
  return newerVersion !== undefined ? { kind: 'superseded', newerVersion } : { kind: 'switch-started' };
}

/** The first of `versions` that is a claude-mem version newer than `targetVersion`. */
function firstVersionNewerThan(versions: readonly string[], targetVersion: string): string | undefined {
  return versions.find((version) => INSTALLED_VERSION_PATTERN.test(version) && compareVersionsDescending(version, targetVersion) < 0);
}

/**
 * Nothing switched: no reading moved, so nothing of the target was written.
 * The installer may still have stopped the worker, so make sure one runs on
 * the previous version (proveInstalledVersion starts one when none runs).
 *
 * The target is not blocked (blocksVersion false), whether or not the
 * previous version's worker comes back. A blocked version can never be
 * applied on this machine, so blocking it on a passing failure (an npx
 * download blip, the installer stopping at its 10 s worker stop) would strand
 * the install until a newer version is promoted, and the daily check interval
 * (AUTO_UPDATE_CHECK_INTERVAL_MS) already limits retries to one download a day.
 */
async function recoverOnPreviousVersion(attempt: AutoUpdateApplyAttempt, failure: AttemptFailure, deps: AutoUpdateApplyDeps): Promise<FinishedAttempt> {
  const { targetVersion, previousVersion } = attempt;
  const nothingSwitched = `Nothing switched: the install still resolves to and is registered at ${previousVersion}`;
  const retried = `Nothing of ${targetVersion} was written, so it is tried again at the next due check.`;
  const proven = await proveInstalledVersion(previousVersion, null, deps);
  if (proven.proven) {
    return {
      outcome: failedOutcome(attempt, deps.now(), 'failed', failure,
        `${nothingSwitched}, and a worker on it finished starting (pid ${proven.pid}). ${retried}`),
      restoreResult: 'not-needed',
      blocksVersion: false,
    };
  }
  const fix = await supervisorFix(attempt, deps);
  return {
    outcome: restoreFailedOutcome(attempt, deps.now(), failure,
      `${nothingSwitched}, but ${proven.why}. ${retried} ${fixSentence(fix, targetVersion)}`, fix),
    restoreResult: 'previous-worker-unproven',
    blocksVersion: false,
  };
}

/**
 * The switch started. First the database: a target worker stamps its schema
 * before it migrates (SessionStore.ts claimSchemaWriter), and an older
 * claude-mem refuses a newer stamp (connection.ts assertSchemaWriterCompatible),
 * so a previous version that cannot open the database is never put back; the
 * target's worker, which may still be migrating, is waited for instead.
 * Otherwise stamp the target's cache directory so every resolver skips it,
 * then rerun the previous version's own installer, which also rewrites the
 * marketplace copy and installed_plugins.json (the marker alone cannot), and
 * prove the previous version again. Right before that installer starts, the
 * install and the stamp are read again (readAgainBeforeTheRestore), since the
 * npm read before it awaited. Then the supervisor records that the restore
 * has begun (recordSupervisorPhase), since from then on the readings of an
 * attempt cut off without an outcome can no longer show whether the restore
 * ran (auto-update-check.ts gate 3). That installer deletes and recopies
 * cache/<previous> (install.ts copyPluginToCache), so a reinstall that also
 * fails can leave the previous version unable to start too: that outcome is
 * restore_failed, with the fix command.
 */
async function restorePreviousVersion(
  attempt: AutoUpdateApplyAttempt,
  failure: AttemptFailure,
  afterInstall: InstallVersionsRead,
  deps: AutoUpdateApplyDeps,
  progress: SupervisorProgress,
): Promise<FinishedAttempt> {
  const { targetVersion, previousVersion } = attempt;
  const where = describeInstallVersions(afterInstall);

  const schema = deps.readDatabaseSchemaStamp();
  if (schema.kind === 'unreadable') {
    return {
      outcome: restoreFailedOutcome(attempt, deps.now(), { stage: 'schema-stamp-unreadable', message: failure.message },
        `${where} The database's schema stamp could not be read (${schema.message}), so nothing showed that ${previousVersion} can still open it: ${previousVersion} was not reinstalled and ${targetVersion}'s cache folder was not stamped. ${fixSentence(AUTO_UPDATE_FORWARD_FIX, targetVersion)}`,
        AUTO_UPDATE_FORWARD_FIX),
      restoreResult: 'not-attempted',
      blocksVersion: true,
    };
  }
  if (isStampedNewerThanThePreviousVersionKnows(schema, deps)) {
    // The target is what can still open the database. Its worker stamps the
    // schema before it migrates, and the migrations can outlast the first
    // proof's wait: a worker still alive is waited for again, never started
    // over or stopped (proveInstalledVersion starts one only when none runs).
    const blockedBySchema = `The database is stamped with schema v${schema.schemaVersion}, newer than the v${deps.supervisorSchemaVersion} that ${previousVersion} knows, so ${previousVersion} cannot open the database any more: it was not reinstalled, and ${targetVersion}'s cache folder was not stamped.`;
    const proven = await proveInstalledVersion(targetVersion, null, deps);
    if (proven.proven) {
      return {
        outcome: {
          result: 'applied',
          targetVersion,
          previousVersion,
          finishedAt: deps.now(),
          message: `Updated ${previousVersion} → ${targetVersion} after a second wait: ${failure.message}. ${blockedBySchema} The install resolves to ${targetVersion}, and a worker on it then finished starting (pid ${proven.pid}).`,
        },
        restoreResult: null,
        blocksVersion: true,
      };
    }
    return {
      outcome: restoreFailedOutcome(attempt, deps.now(), { stage: 'restore-blocked-by-schema', message: failure.message },
        `${where} ${blockedBySchema} Waited again for a worker on ${targetVersion}, but ${proven.why}. ${fixSentence(AUTO_UPDATE_FORWARD_FIX, targetVersion)}`,
        AUTO_UPDATE_FORWARD_FIX),
      restoreResult: 'not-attempted',
      blocksVersion: true,
    };
  }

  const targetDirectory = deps.pluginCacheDirectory(targetVersion);
  const stamp = deps.stampOrphaned(targetDirectory, deps.now());
  const notes = `${where} ${describeStamp(stamp, targetDirectory)}`;
  const restoreFailed = (restoreResult: AutoUpdateRestoreResult, why: string, fix: AutoUpdateFix): FinishedAttempt => ({
    outcome: restoreFailedOutcome(attempt, deps.now(), failure,
      `${notes} Could not restore ${previousVersion}: ${why}. ${fixSentence(fix, targetVersion)}`, fix),
    restoreResult,
    blocksVersion: true,
  });

  const publication = await deps.readNpmPublication(previousVersion);
  if (publication.kind === 'not-published') {
    return restoreFailed('previous-not-published', `npm does not show it published by the workflow (missing: ${publication.missing.join(', ')}), so its installer was not run`, AUTO_UPDATE_FORWARD_FIX);
  }
  if (publication.kind === 'failed') {
    return restoreFailed('previous-publication-unknown', `its npm metadata could not be read (${publication.message}), so its installer was not run`, AUTO_UPDATE_FORWARD_FIX);
  }

  // npm shows it fully published and the database does not outrun it: it can be named.
  const previousFix: AutoUpdateFix = { command: autoUpdateFixCommand(previousVersion), when: 'now' };
  const workerPidBeforeRestore = await deps.getCurrentWorkerPid();
  const movedOnBeforeTheRestore = readAgainBeforeTheRestore(attempt, failure, afterInstall, notes, deps);
  if (movedOnBeforeTheRestore !== null) return movedOnBeforeTheRestore;
  progress.phase = 'restoring-previous-version';
  recordSupervisorPhase(attempt, progress.phase, deps);
  const restoreInstall = await deps.runInstaller(previousVersion);
  if (restoreInstall.kind === 'timed-out' && restoreInstall.installerStillRunning) {
    return {
      outcome: restoreFailedOutcome(attempt, deps.now(), { stage: 'installer-still-running', message: failure.message },
        `${notes} Could not restore ${previousVersion}: ${describeInstallerStillRunning(restoreInstall, previousVersion)}, so no other installer was started. ${fixSentence({ ...previousFix, when: 'once-the-running-update-has-finished' }, targetVersion)}`,
        { ...previousFix, when: 'once-the-running-update-has-finished' }),
      restoreResult: 'restore-installer-failed',
      blocksVersion: true,
    };
  }
  const restoreInstallFailure = installerFailure(restoreInstall, previousVersion);
  if (installerNeverStarted(restoreInstall)) {
    return restoreFailed('restore-installer-failed', restoreInstallFailure!.message, previousFix);
  }
  const proven = await proveInstalledVersion(previousVersion, workerPidBeforeRestore, deps);
  if (!proven.proven) {
    return restoreInstallFailure !== null
      ? restoreFailed('restore-installer-failed', `${restoreInstallFailure.message}, and ${proven.why}`, previousFix)
      : restoreFailed('restore-unproven', `its installer exited 0, but ${proven.why}`, previousFix);
  }
  return {
    outcome: failedOutcome(attempt, deps.now(), 'restored', failure,
      `${notes} Restored ${previousVersion}: its installer ${describeInstallerEnding(restoreInstall)}, the install resolves to it, and a worker on it finished starting (pid ${proven.pid}).`),
    restoreResult: 'restored',
    blocksVersion: true,
  };
}

/**
 * The install's readings and the database's schema stamp read again, right
 * before the previous version's installer starts (restorePreviousVersion).
 * The npm read and the worker pid read before it awaited, and a manual
 * update, Claude Code's own updater or a worker claiming the database may
 * have finished meanwhile; the previous version's installer would then
 * overwrite a newer install, or put back a version that cannot open the
 * database. Nothing is awaited between this read and the installer's start:
 * the phase recorded between them is a synchronous read and write of the
 * state file (recordSupervisorPhase), and the production runInstaller spawns
 * before its first await (auto-update-launch.ts runAutoUpdateInstaller). The
 * installer itself can still wait on the spawn lock after it has started,
 * which no reading here can see past.
 *  - A reading moved to a version newer than the target since the
 *    supervisor's reading after the target's installer (classifyInstallChange
 *    on the two): another update moved the install on, so nothing runs
 *    (failed, superseded-by-another-update), as when it shows after the
 *    target's installer.
 *  - The stamp is newer than the previous version knows: nothing runs
 *    (restore_failed, restore-blocked-by-schema), with the forward fix the
 *    first read names for it; one that cannot be read now is judged as at the
 *    first read (restore_failed, schema-stamp-unreadable).
 * The target's cache folder was stamped before the npm read and stays
 * stamped; the message says so. Null when the restore may run.
 */
function readAgainBeforeTheRestore(
  attempt: AutoUpdateApplyAttempt,
  failure: AttemptFailure,
  afterInstall: InstallVersionsRead,
  notes: string,
  deps: AutoUpdateApplyDeps,
): FinishedAttempt | null {
  const { targetVersion, previousVersion } = attempt;
  const readAgain = `Read again right before ${previousVersion}'s installer would have started:`;
  const beforeRestore = deps.readInstallVersions();
  const change = classifyInstallChange(afterInstall, beforeRestore, targetVersion);
  if (change.kind === 'superseded') {
    return {
      outcome: failedOutcome(attempt, deps.now(), 'failed',
        { stage: 'superseded-by-another-update', message: failure.message },
        `${notes} ${readAgain} ${describeInstallVersions(beforeRestore)} ${change.newerVersion} is newer than ${targetVersion}: another update moved the install on while the restore waited, so ${previousVersion} was not reinstalled.`),
      restoreResult: 'not-attempted',
      blocksVersion: true,
    };
  }
  const schema = deps.readDatabaseSchemaStamp();
  if (schema.kind === 'unreadable') {
    return {
      outcome: restoreFailedOutcome(attempt, deps.now(), { stage: 'schema-stamp-unreadable', message: failure.message },
        `${notes} ${readAgain} the database's schema stamp could not be read (${schema.message}), so nothing showed that ${previousVersion} can still open it, and it was not reinstalled. ${fixSentence(AUTO_UPDATE_FORWARD_FIX, targetVersion)}`,
        AUTO_UPDATE_FORWARD_FIX),
      restoreResult: 'not-attempted',
      blocksVersion: true,
    };
  }
  if (isStampedNewerThanThePreviousVersionKnows(schema, deps)) {
    return {
      outcome: restoreFailedOutcome(attempt, deps.now(), { stage: 'restore-blocked-by-schema', message: failure.message },
        `${notes} ${readAgain} the database is stamped with schema v${schema.schemaVersion}, newer than the v${deps.supervisorSchemaVersion} that ${previousVersion} knows: it was stamped while the restore waited, so ${previousVersion} cannot open the database any more and was not reinstalled. ${fixSentence(AUTO_UPDATE_FORWARD_FIX, targetVersion)}`,
        AUTO_UPDATE_FORWARD_FIX),
      restoreResult: 'not-attempted',
      blocksVersion: true,
    };
  }
  return null;
}

/**
 * The database is stamped with a schema newer than the previous version knows
 * (supervisorSchemaVersion: the supervisor runs that version's code), so an
 * older claude-mem refuses it (connection.ts assertSchemaWriterCompatible).
 */
function isStampedNewerThanThePreviousVersionKnows(
  schema: DatabaseSchemaStampRead,
  deps: Pick<AutoUpdateApplyDeps, 'supervisorSchemaVersion'>,
): schema is Extract<DatabaseSchemaStampRead, { kind: 'stamped' }> {
  return schema.kind === 'stamped' && schema.schemaVersion > deps.supervisorSchemaVersion;
}

/**
 * The fix a restore_failed outcome names when the target has not failed on
 * its own (its installer is still running, nothing of it was written, or the
 * supervisor itself threw), run now: the previous version's own installer
 * when the database's schema stamp is not newer than that version knows (the
 * supervisor runs that version's code, so it knows: supervisorSchemaVersion),
 * or there is no database, and npm shows that version fully published;
 * otherwise the target's own installer. The worker promoted the target and
 * npm showed it fully published before the attempt started, while `latest`
 * is set by every publish before the owner promotes it (npm-publish.yml runs
 * a plain `npm publish`), so it can be a release the owner holds or pulled
 * back. Where the target did fail on its own and the previous version cannot
 * be put back, restorePreviousVersion names the forward fix instead, for once
 * a newer release is out (AUTO_UPDATE_FORWARD_FIX).
 */
async function supervisorFix(attempt: AutoUpdateApplyAttempt, deps: AutoUpdateApplyDeps): Promise<AutoUpdateFix> {
  const schema = deps.readDatabaseSchemaStamp();
  const previousCannotOpenTheDatabase = schema.kind === 'unreadable' || isStampedNewerThanThePreviousVersionKnows(schema, deps);
  const previousCanBeNamed = !previousCannotOpenTheDatabase
    && (await deps.readNpmPublication(attempt.previousVersion)).kind === 'published';
  return { command: autoUpdateFixCommand(previousCanBeNamed ? attempt.previousVersion : attempt.targetVersion), when: 'now' };
}

/** The fix as the outcome's message ends with it: the command, and when the fix may run. */
function fixSentence(fix: AutoUpdateFix, targetVersion: string): string {
  if (fix.when === 'once-the-running-update-has-finished') return `Once it has exited, run: ${fix.command}`;
  if (fix.when === 'once-a-release-newer-than-the-target-is-out') return `Run: ${fix.command} once a release newer than ${targetVersion} is out.`;
  return `Run: ${fix.command}`;
}

/** Where an attempt that recorded no outcome left the install, by the supervisor's readings and rules (readInterruptedAttemptInstall). */
export type InterruptedAttemptInstall =
  /** It resolves to and is registered only at the previous version, and no marketplace copy holds any part of the target. */
  | { kind: 'on-previous-version'; where: string }
  /** A version newer than the target is in place: another update moved the install on, so nothing of this attempt is left to fix. */
  | { kind: 'moved-past-target'; where: string; newerVersion: string }
  /** Anything else: part of the target is in place and nothing proved the install works. */
  | { kind: 'half-switched'; where: string };

export interface InterruptedAttemptReadingDeps {
  readInstallVersions: () => InstallVersionsRead;
}

/**
 * Gate 3's reading (auto-update-check.ts) of an attempt whose supervisor
 * vanished without an outcome and whose install does not resolve to the
 * target: a reboot can kill the supervisor and its installer after the target
 * is registered, and nothing else would tell the user. The readings are the
 * supervisor's own (readInstallVersions); gate 3 names the fix for a
 * half-switched install, the target's own installer
 * (auto-update-state-file.ts interruptedAttemptFix). There is no reading from
 * before the installer to compare with, so the marketplace copy counts as
 * holding part of the target when it is damaged (some of its readings
 * missing, or the two versions apart) or intact at the target: the installer
 * writes no other version there, so a copy intact at another version (a
 * Claude Code clone) was not this attempt's doing.
 */
export async function readInterruptedAttemptInstall(
  attempt: { targetVersion: string; previousVersion: string },
  deps: InterruptedAttemptReadingDeps,
): Promise<InterruptedAttemptInstall> {
  const read = deps.readInstallVersions();
  const where = describeInstallVersions(read);
  const versionsRead = [
    ...(read.resolved === null ? [] : [read.resolved]),
    ...(read.registered.kind === 'read' ? read.registered.versions : []),
    ...[read.marketplace.packageVersion, read.marketplace.pluginManifestVersion].filter((version): version is string => version !== null),
  ];
  const newerVersion = firstVersionNewerThan(versionsRead, attempt.targetVersion);
  if (newerVersion !== undefined) return { kind: 'moved-past-target', where, newerVersion };
  if (resolvesAndIsRegisteredOnlyAt(read, attempt.previousVersion) && marketplaceCopyHoldsNoneOf(read.marketplace, attempt.targetVersion)) {
    return { kind: 'on-previous-version', where };
  }
  return { kind: 'half-switched', where };
}

/**
 * No part of `targetVersion` is in the marketplace copy, read with no reading
 * from before the installer to compare with: there is no copy, or it is whole
 * at another version. The installer writes no other version there, so a copy
 * whole at another version (a Claude Code clone) is not the attempt's doing,
 * while a damaged one may be.
 */
function marketplaceCopyHoldsNoneOf(copy: MarketplaceCopyRead, targetVersion: string): boolean {
  const marketplace = marketplaceCopyState(copy);
  return marketplace.kind === 'absent' || (marketplace.kind === 'intact' && marketplace.version !== targetVersion);
}

/** The resolver picks `version`, and the npx installer's registration in installed_plugins.json names that version and no other. */
function resolvesAndIsRegisteredOnlyAt(read: InstallVersionsRead, version: string): boolean {
  return read.resolved === version
    && read.registered.kind === 'read'
    && read.registered.versions.length > 0
    && read.registered.versions.every((registeredVersion) => registeredVersion === version);
}

function describeInstallVersions(read: InstallVersionsRead): string {
  const registered = read.registered.kind === 'unreadable'
    ? `installed_plugins.json cannot be read (${read.registered.message})`
    : read.registered.versions.length === 0
      ? 'installed_plugins.json registers no version'
      : `installed_plugins.json registers ${read.registered.versions.join(', ')}`;
  return `The install resolves to ${read.resolved ?? 'no version'}; ${registered}; ${describeMarketplaceCopy(read.marketplace)}.`;
}

type MarketplaceCopyState = { kind: 'absent' } | { kind: 'intact'; version: string } | { kind: 'damaged' };

/** No copy at all; a whole copy (both versions recorded and equal, the worker script there); or anything between. */
function marketplaceCopyState(copy: MarketplaceCopyRead): MarketplaceCopyState {
  if (copy.packageVersion === null && copy.pluginManifestVersion === null && !copy.hasWorkerScript) return { kind: 'absent' };
  if (copy.packageVersion !== null && copy.packageVersion === copy.pluginManifestVersion && copy.hasWorkerScript) {
    return { kind: 'intact', version: copy.packageVersion };
  }
  return { kind: 'damaged' };
}

function describeMarketplaceCopy(copy: MarketplaceCopyRead): string {
  const state = marketplaceCopyState(copy);
  if (state.kind === 'absent') return 'there is no marketplace copy';
  if (state.kind === 'intact') return `the marketplace copy is ${state.version}`;
  return `the marketplace copy is incomplete: its package.json is ${copy.packageVersion ?? 'missing or versionless'}, `
    + `its plugin manifest ${copy.pluginManifestVersion ?? 'missing or versionless'}, and its worker script ${copy.hasWorkerScript ? 'in place' : 'missing'}`;
}

function describeStamp(stamp: OrphanedMarkerResult, targetDirectory: string): string {
  const marker = path.join(targetDirectory, ORPHANED_MARKER_FILENAME);
  if (stamp.kind === 'stamped') return `Stamped ${marker}, so no resolver picks it.`;
  if (stamp.kind === 'already-stamped') return `${marker} was already there, so no resolver picks it.`;
  if (stamp.kind === 'no-directory') return `${targetDirectory} does not exist, so there was nothing to stamp.`;
  return `Could not write ${marker} (${stamp.message}), so resolvers may still pick it.`;
}

/** A failed or restored outcome. A restore_failed one goes through restoreFailedOutcome, which also records its fix command. */
function failedOutcome(
  attempt: AutoUpdateApplyAttempt,
  finishedAt: number,
  result: Extract<AutoUpdateAttemptOutcome['result'], 'failed' | 'restored'>,
  failure: AttemptFailure,
  whatHappenedNext: string,
): AutoUpdateAttemptOutcome {
  return outcomeAfterFailure(attempt, finishedAt, result, failure, whatHappenedNext);
}

/**
 * A restore_failed outcome, with its fix: the command its message names and
 * when to run it, chosen by the rule at the call site, recorded on their own
 * so the doctor row and the SessionStart notice never parse the message.
 */
function restoreFailedOutcome(
  attempt: AutoUpdateApplyAttempt,
  finishedAt: number,
  failure: AttemptFailure,
  whatHappenedNext: string,
  fix: AutoUpdateFix,
): AutoUpdateAttemptOutcome {
  return {
    ...outcomeAfterFailure(attempt, finishedAt, 'restore_failed', failure, whatHappenedNext),
    fixCommand: fix.command,
    fixCommandWhen: fix.when,
  };
}

function outcomeAfterFailure(
  attempt: AutoUpdateApplyAttempt,
  finishedAt: number,
  result: Exclude<AutoUpdateAttemptOutcome['result'], 'applied'>,
  failure: AttemptFailure,
  whatHappenedNext: string,
): AutoUpdateAttemptOutcome {
  return {
    result,
    targetVersion: attempt.targetVersion,
    previousVersion: attempt.previousVersion,
    finishedAt,
    failureStage: failure.stage,
    message: `${capitalize(failure.message)}. ${whatHappenedNext}`,
  };
}

/**
 * An exception mid-run. Where the install was left is read again: still
 * resolved to and registered only at the previous version is `failed`;
 * anywhere else, or unreadable, is `restore_failed`, since nothing proved it.
 * Every read here is guarded: this must always produce an outcome.
 *
 * The target is blocked by the rule recoverOnPreviousVersion applies: not when
 * nothing switched. With no reading from before the installer to compare
 * with, nothing switched is what readInterruptedAttemptInstall reads as on the
 * previous version (no part of the target in the marketplace copy either), and
 * no restore begun (`phase`): the restore runs only once the switch had
 * started, and once the previous version's installer has run, the install
 * reads as it did before the update. Any other outcome blocks the target.
 */
async function outcomeAfterUnexpectedError(
  attempt: AutoUpdateApplyAttempt,
  deps: AutoUpdateApplyDeps,
  error: unknown,
  phase: AutoUpdateSupervisorPhase,
): Promise<FinishedAttempt> {
  let whereTheInstallIs: string;
  let leftOnPreviousVersion = false;
  let noPartOfTheTargetInPlace = false;
  try {
    const read = deps.readInstallVersions();
    leftOnPreviousVersion = resolvesAndIsRegisteredOnlyAt(read, attempt.previousVersion);
    noPartOfTheTargetInPlace = leftOnPreviousVersion && marketplaceCopyHoldsNoneOf(read.marketplace, attempt.targetVersion);
    whereTheInstallIs = describeInstallVersions(read);
  } catch (readError: unknown) {
    logger.error('AUTO_UPDATE', 'Could not read where the install is after the supervisor\'s error', describeAttempt(attempt),
      readError instanceof Error ? readError : new Error(String(readError)));
    whereTheInstallIs = `Where the install is could not be read (${errorMessageOf(readError)}).`;
  }
  const failure: AttemptFailure = { stage: 'supervisor-exception', message: `The auto-update supervisor stopped on an unexpected error: ${errorMessageOf(error)}` };
  if (leftOnPreviousVersion) {
    const nothingSwitched = noPartOfTheTargetInPlace && phase !== 'restoring-previous-version';
    const whatHappenedNext = nothingSwitched
      ? `${whereTheInstallIs} Nothing of ${attempt.targetVersion} was written, so it is tried again at the next due check.`
      : whereTheInstallIs;
    return { outcome: failedOutcome(attempt, deps.now(), 'failed', failure, whatHappenedNext), restoreResult: 'unknown', blocksVersion: !nothingSwitched };
  }
  let fix: AutoUpdateFix;
  try {
    fix = await supervisorFix(attempt, deps);
  } catch (fixError: unknown) {
    logger.error('AUTO_UPDATE', 'Could not check whether the previous version can be named as the fix; naming the target\'s installer', describeAttempt(attempt),
      fixError instanceof Error ? fixError : new Error(String(fixError)));
    fix = { command: autoUpdateFixCommand(attempt.targetVersion), when: 'now' };
  }
  return {
    outcome: restoreFailedOutcome(attempt, deps.now(), failure, `${whereTheInstallIs} Nothing restored ${attempt.previousVersion}. ${fixSentence(fix, attempt.targetVersion)}`, fix),
    restoreResult: 'unknown',
    blocksVersion: true,
  };
}

/**
 * The final write. It replaces the in-flight attempt only while it is this
 * supervisor's (same startedAt) or already null: the worker's gate 3 records
 * an attempt it took for vanished as failed and clears it, and may launch a
 * new one later. A different attempt in flight is left alone. A version that
 * applied is removed from versionsThatFailedToApply, where gate 3 put it if it
 * took this supervisor for vanished; so is one of which nothing was written
 * (blocksVersion false), which is tried again at the next due check. Any other
 * result adds it, so it is never retried automatically.
 */
function recordFinalOutcome(
  attempt: AutoUpdateApplyAttempt,
  finished: FinishedAttempt,
  deps: AutoUpdateApplyDeps,
): 'recorded' | 'left-to-another-attempt' {
  const { outcome } = finished;
  const state = deps.readState();
  const inFlight = state.inFlightAttempt;
  if (inFlight !== null && inFlight.startedAt !== attempt.startedAt) {
    logger.warn('AUTO_UPDATE', 'Another auto-update attempt is in flight, so this supervisor leaves the state file as it is', {
      ...describeAttempt(attempt),
      inFlightStartedAt: new Date(inFlight.startedAt).toISOString(),
      inFlightTargetVersion: inFlight.targetVersion,
      result: outcome.result,
      failureStage: outcome.failureStage,
      outcomeMessage: outcome.message,
    });
    return 'left-to-another-attempt';
  }
  state.inFlightAttempt = null;
  state.lastAttemptOutcome = outcome;
  if (outcome.result === 'applied') {
    state.versionsThatFailedToApply = state.versionsThatFailedToApply.filter((version) => version !== attempt.targetVersion);
    state.busyDeferralStartedAt = null;
    state.busyDeferralObservedBusyMs = 0;
    state.busyDeferralLastBusyObservationAt = null;
  } else if (!finished.blocksVersion) {
    state.versionsThatFailedToApply = state.versionsThatFailedToApply.filter((version) => version !== attempt.targetVersion);
  } else if (!state.versionsThatFailedToApply.includes(attempt.targetVersion)) {
    state.versionsThatFailedToApply.push(attempt.targetVersion);
  }
  deps.writeState(state);
  return 'recorded';
}

function sendOutcomeTelemetry(attempt: AutoUpdateApplyAttempt, finished: FinishedAttempt, deps: AutoUpdateApplyDeps): void {
  if (finished.outcome.result === 'applied') {
    deps.captureEvent('auto_update_applied', { from_version: attempt.previousVersion, to_version: attempt.targetVersion });
    return;
  }
  deps.captureEvent('auto_update_failed', {
    from_version: attempt.previousVersion,
    to_version: attempt.targetVersion,
    failure_stage: finished.outcome.failureStage,
    restore_result: finished.restoreResult ?? 'unknown',
  });
}

function logOutcome(attempt: AutoUpdateApplyAttempt, outcome: AutoUpdateAttemptOutcome): void {
  const details = { ...describeAttempt(attempt), result: outcome.result, failureStage: outcome.failureStage, outcomeMessage: outcome.message };
  const message = `Auto-update attempt finished: ${outcome.result}`;
  if (outcome.result === 'applied') logger.info('AUTO_UPDATE', message, details);
  else if (outcome.result === 'restore_failed') logger.error('AUTO_UPDATE', message, details);
  else logger.warn('AUTO_UPDATE', message, details);
}

function describeAttempt(attempt: AutoUpdateApplyAttempt): Record<string, unknown> {
  return {
    targetVersion: attempt.targetVersion,
    previousVersion: attempt.previousVersion,
    attemptStartedAt: new Date(attempt.startedAt).toISOString(),
  };
}

/** Unit conversion, so a timed-out installer's message states its deadline in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
