/**
 * The auto-updater's memory between ticks and between processes: the worker's
 * daily check (auto-update-check.ts) and the supervisor that applies an update
 * both read and write it.
 *
 * It lives in DATA_DIR, never in the plugin folder, which every update
 * replaces. Reading never writes:
 *  - a missing file reads as the defaults;
 *  - a file that does not parse, or is not a JSON object, is logged at ERROR
 *    and read as the defaults in memory;
 *  - a known field with the wrong type is logged at ERROR and read as its
 *    default;
 *  - a field this version does not know (one a later version added) is kept
 *    on the object read, so writing that object back keeps it.
 * The next normal save replaces whatever was wrong. Nothing wrong is ever
 * silently trusted.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export type AutoUpdateAttemptResult = 'applied' | 'failed' | 'restored' | 'restore_failed';

const ATTEMPT_RESULTS: ReadonlySet<string> = new Set<AutoUpdateAttemptResult>(['applied', 'failed', 'restored', 'restore_failed']);

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
}

export interface AutoUpdateAttemptOutcome {
  result: AutoUpdateAttemptResult;
  targetVersion: string;
  previousVersion: string;
  /** Epoch ms. */
  finishedAt: number;
  failureStage?: string;
  message?: string;
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
}

export const AUTO_UPDATE_STATE_FILENAME = 'auto-update-state.json';

export function autoUpdateStatePath(dataDir: string = DATA_DIR): string {
  return join(dataDir, AUTO_UPDATE_STATE_FILENAME);
}

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
  };
}

/**
 * Read the state without writing anything (see the header for what each kind
 * of bad file reads as). The object returned also carries the fields this
 * version does not know, so the caller's next save keeps them.
 *
 * A read error other than a missing file (permissions, a directory in the
 * way) throws: guessing would forget an attempt in flight or a version that
 * failed, so the caller must not go on without the file.
 */
export function readAutoUpdateState(statePath: string = autoUpdateStatePath()): AutoUpdateState {
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultAutoUpdateState();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonWithBom(raw);
  } catch (error: unknown) {
    logger.error('AUTO_UPDATE', 'Auto-update state file is not valid JSON; reading it as the defaults until the next save replaces it', {
      statePath,
    }, error instanceof Error ? error : new Error(String(error)));
    return defaultAutoUpdateState();
  }

  const { state, invalidFields } = validateAutoUpdateState(parsed);
  if (invalidFields.length > 0) {
    logger.error('AUTO_UPDATE', 'Auto-update state file has invalid fields; reading them as the defaults until the next save replaces them', {
      statePath,
      invalidFields: invalidFields.join(', '),
    });
  }
  return state;
}

export function writeAutoUpdateState(state: AutoUpdateState, statePath: string = autoUpdateStatePath()): void {
  writeJsonFileAtomic(statePath, state);
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

function isInFlightAttempt(value: unknown): boolean {
  return isPlainObject(value)
    && isNonEmptyString(value.targetVersion)
    && isNonEmptyString(value.previousVersion)
    && isNonNegativeMilliseconds(value.startedAt)
    && (value.supervisorPid === null || isPid(value.supervisorPid));
}

function isAttemptOutcome(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.result === 'string' && ATTEMPT_RESULTS.has(value.result)
    && isNonEmptyString(value.targetVersion)
    && isNonEmptyString(value.previousVersion)
    && isNonNegativeMilliseconds(value.finishedAt)
    && (value.failureStage === undefined || typeof value.failureStage === 'string')
    && (value.message === undefined || typeof value.message === 'string');
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
