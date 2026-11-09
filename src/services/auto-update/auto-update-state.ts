/**
 * The auto-updater's memory between ticks and between processes: the worker's
 * daily check (auto-update-check.ts) and the supervisor that applies an update
 * both read and write it, and a worker that has finished starting marks what
 * its start proves fixed (resolveAutoUpdateFailuresOnWorkerReady).
 *
 * It lives in DATA_DIR, never in the plugin folder, which every update
 * replaces. Its shape, and the readings the SessionStart launcher shares, are
 * in auto-update-state-file.ts, which this module re-exports. Here a read logs
 * at ERROR what was wrong with the file (a file that does not parse, or is not
 * a JSON object, reads as the defaults; a known field with the wrong type
 * reads as its default; a field this version does not know is kept), and the
 * next normal save replaces whatever was wrong.
 */

import { join } from 'path';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  AUTO_UPDATE_STATE_FILENAME,
  markAutoUpdateFailuresResolvedByReadyWorker,
  readAutoUpdateStateFile,
  type AutoUpdateFailuresResolved,
  type AutoUpdateState,
} from './auto-update-state-file.js';

export {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS,
  AUTO_UPDATE_FORWARD_FIX,
  AUTO_UPDATE_FORWARD_FIX_COMMAND,
  AUTO_UPDATE_STATE_FILENAME,
  autoUpdateBrokenInstall,
  autoUpdateFixCommand,
  autoUpdateFixInstruction,
  autoUpdateFixOfOutcome,
  defaultAutoUpdateState,
  describeAutoUpdateBrokenInstall,
  describeAutoUpdateStateFileProblem,
  interruptedAttemptFix,
  isUnresolvedRestoreFailure,
  markAutoUpdateFailuresResolvedByReadyWorker,
  readAutoUpdateStateFile,
  readInFlightAttempt,
  targetVersionOf,
  validateAutoUpdateState,
  type AutoUpdateAttemptOutcome,
  type AutoUpdateAttemptResult,
  type AutoUpdateBrokenInstall,
  type AutoUpdateDecisionRecord,
  type AutoUpdateFailuresResolved,
  type AutoUpdateFix,
  type AutoUpdateFixCommandWhen,
  type AutoUpdateInFlightAttempt,
  type AutoUpdateState,
  type AutoUpdateStateFileProblem,
  type AutoUpdateStateFileRead,
  type AutoUpdateSupervisorPhase,
  type InFlightAttemptReading,
} from './auto-update-state-file.js';

export function autoUpdateStatePath(dataDir: string = DATA_DIR): string {
  return join(dataDir, AUTO_UPDATE_STATE_FILENAME);
}

/**
 * Read the state without writing anything (auto-update-state-file.ts
 * readAutoUpdateStateFile), logging at ERROR what was wrong with the file.
 * The object returned also carries the fields this version does not know, so
 * the caller's next save keeps them.
 *
 * A read error other than a missing file (permissions, a directory in the
 * way) throws: guessing would forget an attempt in flight or a version that
 * failed, so the caller must not go on without the file.
 */
export function readAutoUpdateState(statePath: string = autoUpdateStatePath()): AutoUpdateState {
  const { state, problem } = readAutoUpdateStateFile(statePath);
  if (problem?.kind === 'not-json') {
    logger.error('AUTO_UPDATE', 'Auto-update state file is not valid JSON; reading it as the defaults until the next save replaces it', {
      statePath,
    }, problem.error instanceof Error ? problem.error : new Error(String(problem.error)));
  } else if (problem?.kind === 'invalid-fields') {
    logger.error('AUTO_UPDATE', 'Auto-update state file has invalid fields; reading them as the defaults until the next save replaces them', {
      statePath,
      invalidFields: problem.invalidFields.join(', '),
    });
  }
  return state;
}

export function writeAutoUpdateState(state: AutoUpdateState, statePath: string = autoUpdateStatePath()): void {
  writeJsonFileAtomic(statePath, state);
}

/**
 * The worker's step once it has finished starting: mark resolved what its
 * start proves fixed (auto-update-state-file.ts
 * markAutoUpdateFailuresResolvedByReadyWorker says what and when), and save
 * the state with writeJsonFileAtomic only when something was marked. A
 * missing state file is left missing. Throws when the file cannot be read or
 * written; the worker logs that and goes on.
 */
export function resolveAutoUpdateFailuresOnWorkerReady(options: {
  now: number;
  workerVersion: string;
  resolvedVersion: string | null;
  isProcessAlive: (pid: number) => boolean;
  statePath?: string;
}): AutoUpdateFailuresResolved {
  const statePath = options.statePath ?? autoUpdateStatePath();
  const state = readAutoUpdateState(statePath);
  const resolved = markAutoUpdateFailuresResolvedByReadyWorker(state, options);
  if (resolved.outcome !== null || resolved.interruptedAttempt !== null) writeAutoUpdateState(state, statePath);
  return resolved;
}
