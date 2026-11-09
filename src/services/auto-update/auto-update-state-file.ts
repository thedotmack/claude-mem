/**
 * The auto-update state file's shape, and the readings of it that more than
 * one process makes: the worker's check, the supervisor, the worker once it
 * is ready, the doctor row and the SessionStart launcher.
 *
 * It imports nothing at runtime but node's fs and the BOM-aware JSON parser,
 * so the SessionStart launcher (src/launcher/ensure-launcher.ts) can bundle
 * it: that script runs under plain node, and its bundle must stay small.
 * Where the file lives (DATA_DIR), logging what is wrong with it, and writing
 * it are auto-update-state.ts's, which re-exports everything here.
 *
 * Reading never writes:
 *  - a missing file reads as the defaults;
 *  - a file that does not parse, or is not a JSON object, reads as the
 *    defaults, and the read says so;
 *  - a known field with the wrong type reads as its default, and the read
 *    names it;
 *  - a field this version does not know (one a later version added) is kept
 *    on the object read, so writing that object back keeps it.
 * Nothing wrong is ever silently trusted.
 */

import { readFileSync } from 'fs';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import type { ClaudeMemInstallShape } from './auto-update-install-shape.js';

/**
 * One network check a day. Releases land on about 17 of every 30 days (28
 * releases on 17 days in the 30 days to 2026-11-06), so one check a day picks
 * up each release day's promoted version. A failed fetch counts as a check, so
 * a broken network never turns into hourly retries. Here, not in
 * auto-update-check.ts, which re-exports it, because the live-supervisor
 * ceiling below is defined by it and the launcher reads that ceiling.
 */
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a recorded supervisor pid that is still alive counts as the
 * attempt's supervisor: one check cycle. A laptop that sleeps during an
 * install wakes past the wall-clock deadline with its supervisor still
 * running, and taking that supervisor for gone would block its version for
 * good. Past a full day a live pid is treated as reused by another process, so
 * updates are never blocked longer than a day. The worker's gate 3 and every
 * reader here (readInFlightAttempt) use it.
 */
export const AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS = AUTO_UPDATE_CHECK_INTERVAL_MS;

export type AutoUpdateAttemptResult = 'applied' | 'failed' | 'restored' | 'restore_failed';

const ATTEMPT_RESULTS: ReadonlySet<string> = new Set<AutoUpdateAttemptResult>(['applied', 'failed', 'restored', 'restore_failed']);

/**
 * When the person runs a restore_failed outcome's fix command, as the
 * supervisor names it (auto-update-apply.ts):
 *  - now;
 *  - once the update still running has finished: an installer outlived the
 *    tree-kill at its deadline (failureStage installer-still-running), and a
 *    second installer would write the same files;
 *  - once a release newer than the target is out: the target failed on its
 *    own and the previous version cannot be put back (the database is stamped
 *    with a schema it cannot open, or the stamp could not be read, or npm does
 *    not show that version fully published), so only a newer release fixes
 *    it, and the command is the forward fix.
 */
export type AutoUpdateFixCommandWhen = 'now' | 'once-the-running-update-has-finished' | 'once-a-release-newer-than-the-target-is-out';

const FIX_COMMAND_WHENS: ReadonlySet<string> = new Set<AutoUpdateFixCommandWhen>([
  'now',
  'once-the-running-update-has-finished',
  'once-a-release-newer-than-the-target-is-out',
]);

/** The one command that puts an install right, and when to run it. */
export interface AutoUpdateFix {
  command: string;
  when: AutoUpdateFixCommandWhen;
}

/**
 * How far the supervisor got in its attempt (auto-update-apply.ts), as it
 * records it in the attempt in flight:
 *  - installing the target: written with its claim, before the target's
 *    installer runs;
 *  - restoring the previous version: written right before the previous
 *    version's installer runs, once the target's switch has failed.
 * The worker's gate 3 reads it for an attempt whose supervisor vanished: the
 * install's readings alone cannot tell one nothing touched from one the
 * restore put back before the supervisor was killed.
 */
export type AutoUpdateSupervisorPhase = 'installing-target' | 'restoring-previous-version';

const SUPERVISOR_PHASES: ReadonlySet<string> = new Set<AutoUpdateSupervisorPhase>(['installing-target', 'restoring-previous-version']);

export interface AutoUpdateInFlightAttempt {
  targetVersion: string;
  previousVersion: string;
  /**
   * Epoch ms when the worker launched the attempt. It is also the attempt's
   * identity: the worker passes it to the supervisor (--attempt-started-at),
   * and the supervisor writes only while the attempt in flight has it
   * (auto-update-apply.ts).
   */
  startedAt: number;
  /** The supervisor's pid, null until the supervisor records it. */
  supervisorPid: number | null;
  /**
   * How far the supervisor got (AutoUpdateSupervisorPhase). Absent until a
   * supervisor claims the attempt, and in a file a supervisor from before it
   * was recorded wrote: gate 3 then judges a vanished attempt as before.
   */
  supervisorPhase?: AutoUpdateSupervisorPhase;
  /**
   * How long the attempt may run: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS as the
   * worker that launched it computed it (auto-update-launch.ts
   * launchAutoUpdateSupervisor). Recorded so a reader that cannot compute it
   * judges a supervisor that never started by the same bound: the SessionStart
   * launcher runs under plain node, without the installer and process-manager
   * modules the deadline is built from (auto-update-deadlines.ts). Absent in a
   * file written before it was recorded.
   */
  supervisorDeadlineMs?: number;
  /**
   * Epoch ms when a worker finished starting on the version the install
   * resolves to after this attempt's supervisor was gone
   * (markAutoUpdateFailuresResolvedByReadyWorker): the install works. The
   * worker's gate 3 still records how the attempt ended, and carries this onto
   * that outcome.
   */
  resolvedAt?: number;
  /** The version of that worker, which is the version the install resolved to then. */
  resolvedWithWorkerVersion?: string;
}

export interface AutoUpdateAttemptOutcome {
  result: AutoUpdateAttemptResult;
  targetVersion: string;
  previousVersion: string;
  /** Epoch ms. */
  finishedAt: number;
  failureStage?: string;
  message?: string;
  /**
   * The one command that puts the install right. The supervisor and the
   * worker's gate 3 set it on every restore_failed outcome they record, with
   * fixCommandWhen, by the rule that names it in `message`
   * (auto-update-apply.ts), so the doctor row and the SessionStart notice never
   * parse the message. Absent on every other result, and on a restore_failed
   * outcome written before it existed (autoUpdateFixOfOutcome names the
   * forward fix for that one).
   */
  fixCommand?: string;
  /** When to run fixCommand. Absent in a file written before it was recorded, which reads as now. */
  fixCommandWhen?: AutoUpdateFixCommandWhen;
  /**
   * Epoch ms when a worker finished starting on the version the install
   * resolves to after this restore_failed outcome
   * (markAutoUpdateFailuresResolvedByReadyWorker): the install works again,
   * so neither the doctor row nor the notice warns.
   */
  resolvedAt?: number;
  /** The version of that worker. */
  resolvedWithWorkerVersion?: string;
}

/**
 * The worker's last decision on a tick with no attempt in flight
 * (auto-update-check.ts runAutoUpdateCheck), for the doctor row: doctor runs in
 * a terminal whose environment can differ from the worker's, so only the
 * worker can say what it decided.
 */
export interface AutoUpdateDecisionRecord {
  /** The decision's name (auto-update-check.ts AutoUpdateDecisionName). */
  decision: string;
  /** Why, in plain words (auto-update-check.ts describeAutoUpdateDecision). */
  reason: string;
  /** Epoch ms of the tick. */
  decidedAt: number;
}

export interface AutoUpdateState {
  /** Epoch ms of the last promoted-file fetch, success or failure. */
  lastNetworkCheckAt: number | null;
  lastSeenPromotedVersion: string | null;
  /** Epoch ms of the first tick that wanted to apply but found the worker busy; null while no update is deferred. */
  busyDeferralStartedAt: number | null;
  /**
   * Busy time observed during the current deferral, in ms: each tick that
   * finds the worker busy adds the time since the previous busy tick, at most
   * one tick interval (recordBusyObservation in auto-update-check.ts). Only
   * read while busyDeferralStartedAt is set.
   */
  busyDeferralObservedBusyMs: number;
  /** Epoch ms of the last tick that found the worker busy during the current deferral. */
  busyDeferralLastBusyObservationAt: number | null;
  inFlightAttempt: AutoUpdateInFlightAttempt | null;
  lastAttemptOutcome: AutoUpdateAttemptOutcome | null;
  /** Never retried automatically; a newer promoted version is tried normally. */
  versionsThatFailedToApply: string[];
  lastCheckError: { at: number; message: string } | null;
  /**
   * Epoch ms of the last tick that turned off Claude Code's background update
   * of the thedotmack marketplace (autoUpdate true → false in Claude Code's
   * known_marketplaces.json, auto-update-check.ts
   * settleClaudeCodeBackgroundUpdate); null until a tick has.
   */
  claudeCodeBackgroundUpdateTurnedOffAt: number | null;
  /**
   * Epoch ms of the last check that read both the promoted file and npm's
   * metadata for the promoted version, shown published by the workflow: proof
   * that claude-mem's updater reaches both from this machine. Claude Code's
   * background update is turned off only once this is set. null until a check
   * has.
   */
  promotedFileAndNpmMetadataReadAt: number | null;
  /**
   * Why the last tick that found Claude Code's background update of the
   * thedotmack marketplace on left it on (claude-mem's updater not yet shown
   * to work here, no npx on the worker's PATH, or a write that failed), for
   * the doctor row; null when nothing is left on.
   */
  claudeCodeBackgroundUpdateLeftOnReason: string | null;
  /** The worker's last decision (AutoUpdateDecisionRecord); null until a tick has recorded one. */
  lastDecision: AutoUpdateDecisionRecord | null;
}

export const AUTO_UPDATE_STATE_FILENAME = 'auto-update-state.json';

export function defaultAutoUpdateState(): AutoUpdateState {
  return {
    lastNetworkCheckAt: null,
    lastSeenPromotedVersion: null,
    busyDeferralStartedAt: null,
    busyDeferralObservedBusyMs: 0,
    busyDeferralLastBusyObservationAt: null,
    inFlightAttempt: null,
    lastAttemptOutcome: null,
    versionsThatFailedToApply: [],
    lastCheckError: null,
    claudeCodeBackgroundUpdateTurnedOffAt: null,
    promotedFileAndNpmMetadataReadAt: null,
    claudeCodeBackgroundUpdateLeftOnReason: null,
    lastDecision: null,
  };
}

/** What was wrong with a state file that was read as the defaults, in whole or in part. */
export type AutoUpdateStateFileProblem =
  /** It does not parse; the whole file reads as the defaults. */
  | { kind: 'not-json'; error: unknown }
  /** These known fields had the wrong shape and read as their defaults ('(whole file: not a JSON object)' when it held no object). */
  | { kind: 'invalid-fields'; invalidFields: string[] };

export interface AutoUpdateStateFileRead {
  state: AutoUpdateState;
  /** False when there is no state file: no check has run here yet. */
  exists: boolean;
  /** Null when nothing was wrong. */
  problem: AutoUpdateStateFileProblem | null;
}

/**
 * Read the state without writing or logging anything; what was wrong comes
 * back as `problem` for the caller to report (auto-update-state.ts
 * readAutoUpdateState logs it, doctor shows it, the launcher writes it to its
 * debug log). The object read also carries the fields this version does not
 * know, so the caller's next save keeps them.
 *
 * A read error other than a missing file (permissions, a directory in the
 * way) throws: guessing would forget an attempt in flight or a version that
 * failed, so the caller must not go on without the file.
 */
export function readAutoUpdateStateFile(statePath: string): AutoUpdateStateFileRead {
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: defaultAutoUpdateState(), exists: false, problem: null };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonWithBom(raw);
  } catch (error: unknown) {
    return { state: defaultAutoUpdateState(), exists: true, problem: { kind: 'not-json', error } };
  }

  const { state, invalidFields } = validateAutoUpdateState(parsed);
  return { state, exists: true, problem: invalidFields.length > 0 ? { kind: 'invalid-fields', invalidFields } : null };
}

/** What a state-file problem says, in one sentence, for the doctor row and the launcher's debug log. */
export function describeAutoUpdateStateFileProblem(statePath: string, problem: AutoUpdateStateFileProblem): string {
  if (problem.kind === 'not-json') {
    return `${statePath} is not valid JSON (${problem.error instanceof Error ? problem.error.message : String(problem.error)}), so it reads as the defaults until the next save replaces it`;
  }
  return `${statePath} has invalid fields (${problem.invalidFields.join(', ')}), so they read as the defaults until the next save replaces them`;
}

/**
 * Keep every known field that has the declared shape, default the rest, and
 * keep every field this version does not know as it was. A known field that
 * is absent takes its default quietly (a file from an older version); one
 * that is present but wrong is reported in invalidFields.
 */
export function validateAutoUpdateState(parsed: unknown): { state: AutoUpdateState; invalidFields: string[] } {
  if (!isPlainObject(parsed)) return { state: defaultAutoUpdateState(), invalidFields: ['(whole file: not a JSON object)'] };

  // Spread, not assignment, copies the unknown fields: it defines each one as
  // an own property, so even a key named __proto__ stays plain data.
  const state: AutoUpdateState = { ...parsed, ...defaultAutoUpdateState() };
  const invalidFields: string[] = [];
  const take = <K extends keyof AutoUpdateState>(key: K, isValid: (value: unknown) => boolean): void => {
    const value = parsed[key];
    if (value === undefined) return;
    if (isValid(value)) state[key] = value as AutoUpdateState[K];
    else invalidFields.push(key);
  };

  take('lastNetworkCheckAt', (value) => value === null || isNonNegativeMilliseconds(value));
  take('lastSeenPromotedVersion', (value) => value === null || isNonEmptyString(value));
  take('busyDeferralStartedAt', (value) => value === null || isNonNegativeMilliseconds(value));
  take('busyDeferralObservedBusyMs', isNonNegativeMilliseconds);
  take('busyDeferralLastBusyObservationAt', (value) => value === null || isNonNegativeMilliseconds(value));
  take('inFlightAttempt', (value) => value === null || isInFlightAttempt(value));
  take('lastAttemptOutcome', (value) => value === null || isAttemptOutcome(value));
  take('lastCheckError', (value) => value === null || (isPlainObject(value) && isNonNegativeMilliseconds(value.at) && typeof value.message === 'string'));
  take('claudeCodeBackgroundUpdateTurnedOffAt', (value) => value === null || isNonNegativeMilliseconds(value));
  take('promotedFileAndNpmMetadataReadAt', (value) => value === null || isNonNegativeMilliseconds(value));
  take('claudeCodeBackgroundUpdateLeftOnReason', (value) => value === null || isNonEmptyString(value));
  take('lastDecision', (value) => value === null || isDecisionRecord(value));

  // Entries are filtered, not the list reset: dropping a valid entry would let
  // a version that already failed be tried again.
  const failed = parsed.versionsThatFailedToApply;
  if (failed !== undefined) {
    if (Array.isArray(failed)) {
      state.versionsThatFailedToApply = failed.filter(isNonEmptyString);
      if (state.versionsThatFailedToApply.length !== failed.length) invalidFields.push('versionsThatFailedToApply');
    } else {
      invalidFields.push('versionsThatFailedToApply');
    }
  }

  return { state, invalidFields };
}

// ─── Fix commands ──────────────────────────────────────────────────────────

/** The command that runs `version`'s own installer: the previous version's to put it back, the target's to finish an update. */
export function autoUpdateFixCommand(version: string): string {
  return `npx claude-mem@${version} update`;
}

/**
 * The fix that moves an install past a target that failed on its own, when
 * the previous version cannot be put back. It names `latest`, which every
 * publish sets before the owner promotes it (npm-publish.yml runs a plain
 * `npm publish`), so it is only named to run once a release newer than the
 * target is out, never as an update's own target.
 */
export const AUTO_UPDATE_FORWARD_FIX_COMMAND = 'npx claude-mem@latest update';

/** The forward fix with the only time it may run. */
export const AUTO_UPDATE_FORWARD_FIX: Readonly<AutoUpdateFix> = Object.freeze({
  command: AUTO_UPDATE_FORWARD_FIX_COMMAND,
  when: 'once-a-release-newer-than-the-target-is-out',
});

/**
 * A restore_failed outcome's fix as recorded. One written before fixCommand
 * existed gets the forward fix, never a command parsed from the message; one
 * written before fixCommandWhen existed runs now, as it said then.
 */
export function autoUpdateFixOfOutcome(outcome: AutoUpdateAttemptOutcome): AutoUpdateFix {
  if (outcome.fixCommand === undefined) return { ...AUTO_UPDATE_FORWARD_FIX };
  return { command: outcome.fixCommand, when: outcome.fixCommandWhen ?? 'now' };
}

/**
 * The whole fix instruction, command and when, that the SessionStart notice
 * and the doctor row both end with, so they name the same step.
 * `targetVersion` is the version the update tried to install.
 */
export function autoUpdateFixInstruction(fix: AutoUpdateFix, targetVersion: string): string {
  const run = `run \`${fix.command}\`, then restart Claude Code.`;
  if (fix.when === 'once-the-running-update-has-finished') return `Fix: once the update that is still running has finished, ${run}`;
  if (fix.when === 'once-a-release-newer-than-the-target-is-out') return `Fix: once a claude-mem release newer than ${targetVersion} is out, ${run}`;
  return `Fix: ${run}`;
}

// ─── An attempt in flight, and an install the auto-updater may have left broken ─

/** Where the attempt in flight stands, as every reader outside the worker's gate 3 judges it (readInFlightAttempt). */
export type InFlightAttemptReading =
  /** Its supervisor may still be working: its recorded pid is alive within the ceiling, or none is recorded yet within the recorded deadline. */
  | 'running'
  /** No supervisor recorded its pid by the recorded deadline: nothing ran (gate 3 records it as supervisor-never-started). */
  | 'never-started'
  /** Its recorded supervisor is gone (a reboot), or a pid still alive past a day is another process: no outcome was recorded. */
  | 'interrupted'
  /** A worker finished starting on the version the install resolves to after its supervisor was gone. */
  | 'resolved';

/**
 * The attempt in flight, read with the rule every reader outside gate 3
 * shares: its supervisor is gone when its recorded pid is not alive, or is
 * still alive past AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS (the ceiling gate 3
 * uses, past which a live pid is taken for reused), or when no pid was
 * recorded by the deadline the worker recorded with the attempt. A dead pid
 * counts at once, so after a reboot the notice does not wait out the deadline;
 * whether the install then needs a fix is the install-shape check's to say
 * (autoUpdateBrokenInstall). The age is taken in either direction, as in gate
 * 3, so a clock moved back cannot hold it running forever. Liveness is the
 * caller's signal-0 probe, which delivers no signal. Gate 3 itself also waits
 * out the deadline for a dead pid, because killing a supervisor alone leaves
 * its installer running and gate 3 records the outcome.
 */
export function readInFlightAttempt(
  attempt: AutoUpdateInFlightAttempt,
  now: number,
  isProcessAlive: (pid: number) => boolean,
): InFlightAttemptReading {
  if (attempt.resolvedAt !== undefined) return 'resolved';
  const ageMs = Math.abs(now - attempt.startedAt);
  if (attempt.supervisorPid !== null) {
    if (!isProcessAlive(attempt.supervisorPid)) return 'interrupted';
    return ageMs > AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS ? 'interrupted' : 'running';
  }
  if (attempt.supervisorDeadlineMs !== undefined && ageMs > attempt.supervisorDeadlineMs) return 'never-started';
  return 'running';
}

/** Why the install may not work after an automatic update, and the fix. */
export type AutoUpdateBrokenInstall =
  /**
   * An attempt whose supervisor is gone without an outcome, on an install the
   * cheap file checks find half-written (`halfWritten` says what). Its fix is
   * the target's own installer: the worker promoted it and npm showed it fully
   * published before the attempt started, while `latest` may be a release the
   * owner holds or pulled back.
   */
  | { kind: 'interrupted'; attempt: AutoUpdateInFlightAttempt; halfWritten: string; fix: AutoUpdateFix }
  /** A restore_failed outcome no ready worker has resolved yet, with the fix it recorded. */
  | { kind: 'restore-failed'; outcome: AutoUpdateAttemptOutcome; fix: AutoUpdateFix };

/** The fix of an attempt cut off without an outcome: run the target's installer now (the reason is on AutoUpdateBrokenInstall). */
export function interruptedAttemptFix(attempt: Pick<AutoUpdateInFlightAttempt, 'targetVersion'>): AutoUpdateFix {
  return { command: autoUpdateFixCommand(attempt.targetVersion), when: 'now' };
}

/**
 * The one case the auto-updater tells a session about (plan Decision 7), the
 * same one the doctor row warns about with a fix: an install an automatic
 * update may have left not working. Null while an attempt is running: its
 * supervisor records the outcome, and a fix run beside it would race its
 * installer. An attempt whose supervisor is gone counts only when
 * `readInstallShape` finds the install half-written; otherwise the install
 * works, and the worker's gate 3 records how the attempt ended. Its shape is
 * read only then, so a normal session start reads no more than the state file.
 */
export function autoUpdateBrokenInstall(
  state: AutoUpdateState,
  now: number,
  isProcessAlive: (pid: number) => boolean,
  readInstallShape: () => ClaudeMemInstallShape,
): AutoUpdateBrokenInstall | null {
  const attempt = state.inFlightAttempt;
  if (attempt !== null) {
    const reading = readInFlightAttempt(attempt, now, isProcessAlive);
    if (reading === 'running') return null;
    if (reading === 'interrupted' || reading === 'never-started') {
      const shape = readInstallShape();
      if (shape.kind === 'looks-half-written') return { kind: 'interrupted', attempt, halfWritten: shape.what, fix: interruptedAttemptFix(attempt) };
    }
  }
  const outcome = state.lastAttemptOutcome;
  if (outcome === null || !isUnresolvedRestoreFailure(outcome)) return null;
  return { kind: 'restore-failed', outcome, fix: autoUpdateFixOfOutcome(outcome) };
}

/** What happened, as the notice and the doctor row both say it: "the automatic update to 15.13.0 failed". */
export function describeAutoUpdateBrokenInstall(broken: AutoUpdateBrokenInstall): string {
  return broken.kind === 'interrupted'
    ? `the automatic update to ${broken.attempt.targetVersion} did not finish (${broken.halfWritten})`
    : `the automatic update to ${broken.outcome.targetVersion} failed`;
}

/** The version the update tried to install, which the fix instruction can name. */
export function targetVersionOf(broken: AutoUpdateBrokenInstall): string {
  return broken.kind === 'interrupted' ? broken.attempt.targetVersion : broken.outcome.targetVersion;
}

/**
 * Whether this outcome leaves the person something to do: restore_failed, and
 * not resolved since. failed, applied and restored each left a working
 * install, the previous version or the target.
 */
export function isUnresolvedRestoreFailure(outcome: AutoUpdateAttemptOutcome): boolean {
  return outcome.result === 'restore_failed' && outcome.resolvedAt === undefined;
}

/** What markAutoUpdateFailuresResolvedByReadyWorker marked; null where it marked nothing. */
export interface AutoUpdateFailuresResolved {
  outcome: AutoUpdateAttemptOutcome | null;
  interruptedAttempt: AutoUpdateInFlightAttempt | null;
}

/**
 * The worker's step once it has finished starting (worker-service.ts, right
 * after initialization completes): when its own version is the version the
 * install resolves to, the install works, however it was fixed (the fix
 * command, Claude Code's /plugin update, `npx claude-mem repair`, an older
 * installer, or a previous worker that came up after the supervisor gave up).
 * So it marks resolved, in `state`, with the time and its version, an
 * unresolved restore_failed outcome (isUnresolvedRestoreFailure) and an
 * attempt in flight whose supervisor is gone without an outcome
 * (readInFlightAttempt 'interrupted'). Nothing else changes: the outcome keeps
 * its result, stage, message and fix, the attempt stays in flight for gate 3
 * to record, and a version that failed stays blocked. Nothing at all is marked
 * while an attempt's supervisor may still be working ('running'): that
 * supervisor records its own outcome, and this worker may be the one its
 * installer just started.
 */
export function markAutoUpdateFailuresResolvedByReadyWorker(
  state: AutoUpdateState,
  readyWorker: {
    now: number;
    /** The ready worker's own version (its baked package version). */
    workerVersion: string;
    /** The version the install resolves to now (worker-utils.ts resolvePluginRoot), null when nothing resolves. */
    resolvedVersion: string | null;
    isProcessAlive: (pid: number) => boolean;
  },
): AutoUpdateFailuresResolved {
  const resolved: AutoUpdateFailuresResolved = { outcome: null, interruptedAttempt: null };
  const { now, workerVersion, resolvedVersion, isProcessAlive } = readyWorker;
  if (resolvedVersion === null || workerVersion !== resolvedVersion) return resolved;
  const attempt = state.inFlightAttempt;
  if (attempt !== null) {
    const reading = readInFlightAttempt(attempt, now, isProcessAlive);
    if (reading === 'running') return resolved;
    if (reading === 'interrupted') {
      attempt.resolvedAt = now;
      attempt.resolvedWithWorkerVersion = workerVersion;
      resolved.interruptedAttempt = attempt;
    }
  }
  const outcome = state.lastAttemptOutcome;
  if (outcome !== null && isUnresolvedRestoreFailure(outcome)) {
    outcome.resolvedAt = now;
    outcome.resolvedWithWorkerVersion = workerVersion;
    resolved.outcome = outcome;
  }
  return resolved;
}

// ─── Shape checks ──────────────────────────────────────────────────────────

function isInFlightAttempt(value: unknown): boolean {
  return isPlainObject(value)
    && isNonEmptyString(value.targetVersion)
    && isNonEmptyString(value.previousVersion)
    && isNonNegativeMilliseconds(value.startedAt)
    && (value.supervisorPid === null || isPid(value.supervisorPid))
    && (value.supervisorPhase === undefined || (typeof value.supervisorPhase === 'string' && SUPERVISOR_PHASES.has(value.supervisorPhase)))
    && (value.supervisorDeadlineMs === undefined || isNonNegativeMilliseconds(value.supervisorDeadlineMs))
    && (value.resolvedAt === undefined || isNonNegativeMilliseconds(value.resolvedAt))
    && (value.resolvedWithWorkerVersion === undefined || isNonEmptyString(value.resolvedWithWorkerVersion));
}

function isAttemptOutcome(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.result === 'string' && ATTEMPT_RESULTS.has(value.result)
    && isNonEmptyString(value.targetVersion)
    && isNonEmptyString(value.previousVersion)
    && isNonNegativeMilliseconds(value.finishedAt)
    && (value.failureStage === undefined || typeof value.failureStage === 'string')
    && (value.message === undefined || typeof value.message === 'string')
    && (value.fixCommand === undefined || isNonEmptyString(value.fixCommand))
    && (value.fixCommandWhen === undefined || (typeof value.fixCommandWhen === 'string' && FIX_COMMAND_WHENS.has(value.fixCommandWhen)))
    && (value.resolvedAt === undefined || isNonNegativeMilliseconds(value.resolvedAt))
    && (value.resolvedWithWorkerVersion === undefined || isNonEmptyString(value.resolvedWithWorkerVersion));
}

function isDecisionRecord(value: unknown): boolean {
  return isPlainObject(value)
    && isNonEmptyString(value.decision)
    && isNonEmptyString(value.reason)
    && isNonNegativeMilliseconds(value.decidedAt);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An epoch-ms instant or a duration in ms: both are finite and never negative. */
function isNonNegativeMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
