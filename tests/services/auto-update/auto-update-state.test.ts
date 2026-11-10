import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { AUTO_UPDATE_SUPERVISOR_DEADLINE_MS } from '../../../src/services/auto-update/auto-update-deadlines.js';
import type { ClaudeMemInstallShape } from '../../../src/services/auto-update/auto-update-install-shape.js';
import {
  AUTO_UPDATE_FORWARD_FIX_COMMAND,
  AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS,
  AUTO_UPDATE_STATE_FILENAME,
  autoUpdateBrokenInstall,
  autoUpdateFixOfOutcome,
  autoUpdateStatePath,
  defaultAutoUpdateState,
  readAutoUpdateState,
  readAutoUpdateStateFile,
  readInFlightAttempt,
  resolveAutoUpdateFailuresOnWorkerReady,
  writeAutoUpdateState,
  type AutoUpdateAttemptOutcome,
  type AutoUpdateInFlightAttempt,
  type AutoUpdateState,
} from '../../../src/services/auto-update/auto-update-state.js';
import { AUTO_UPDATE_CHECK_INTERVAL_MS } from '../../../src/services/auto-update/auto-update-check.js';
import { logger } from '../../../src/utils/logger.js';

// Project-local scratch (gitignored), never the system temp folder, as in
// tests/worker/http/routes/setup-state-routes.test.ts.
const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

const fullState: AutoUpdateState = {
  lastNetworkCheckAt: NOW,
  lastSeenPromotedVersion: '15.12.0',
  busyDeferralStartedAt: NOW - 3_600_000,
  busyDeferralObservedBusyMs: 1_800_000,
  busyDeferralLastBusyObservationAt: NOW - 1_000,
  inFlightAttempt: { targetVersion: '15.12.0', previousVersion: '15.11.0', startedAt: NOW, supervisorPid: 4242, supervisorPhase: 'restoring-previous-version', supervisorDeadlineMs: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS },
  lastAttemptOutcome: {
    result: 'restore_failed',
    targetVersion: '15.11.0',
    previousVersion: '15.10.1',
    finishedAt: NOW - 5_000,
    failureStage: 'installer-timeout',
    message: 'Run: npx claude-mem@15.10.1 update',
    fixCommand: 'npx claude-mem@15.10.1 update',
    fixCommandWhen: 'now',
    resolvedAt: NOW - 1_000,
    resolvedWithWorkerVersion: '15.10.1',
  },
  versionsThatFailedToApply: ['15.11.0'],
  lastCheckError: { at: NOW, message: 'HTTP 503' },
  claudeCodeBackgroundUpdateTurnedOffAt: NOW - 7_200_000,
  promotedFileAndNpmMetadataReadAt: NOW - 3_600_000,
  claudeCodeBackgroundUpdateLeftOnReason: 'npx is not on the worker\'s PATH, so claude-mem\'s updater could not run its installer',
  lastDecision: { decision: 'not-due', reason: 'checked less than a day ago, so the next check waits', decidedAt: NOW - 60_000 },
};

describe('auto-update state file', () => {
  let tempDir: string;
  let statePath: string;
  let loggedErrors: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-state-'));
    statePath = path.join(tempDir, AUTO_UPDATE_STATE_FILENAME);
    loggedErrors = spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const fileContents = (): unknown => JSON.parse(readFileSync(statePath, 'utf-8'));

  it('lives in the data dir', () => {
    expect(autoUpdateStatePath(tempDir)).toBe(statePath);
  });

  it('reads a missing file as the defaults without creating it', () => {
    expect(readAutoUpdateState(statePath)).toEqual(defaultAutoUpdateState());
    expect(existsSync(statePath)).toBe(false);
    expect(loggedErrors).not.toHaveBeenCalled();
  });

  it('reads back what it wrote', () => {
    writeAutoUpdateState(fullState, statePath);
    expect(readAutoUpdateState(statePath)).toEqual(fullState);
    expect(loggedErrors).not.toHaveBeenCalled();
  });

  it('keeps fields it does not know through a read and a write', () => {
    const fromALaterVersion = {
      ...fullState,
      rolloutCohort: { percent: 10, bucket: 'b' },
      betaChannelJoinedAt: NOW - 60_000,
    };
    writeFileSync(statePath, JSON.stringify(fromALaterVersion));

    const state = readAutoUpdateState(statePath);
    expect(state).toEqual(fromALaterVersion);
    state.lastNetworkCheckAt = NOW + 1_000;
    writeAutoUpdateState(state, statePath);

    expect(fileContents()).toEqual({ ...fromALaterVersion, lastNetworkCheckAt: NOW + 1_000 });
    expect(loggedErrors).not.toHaveBeenCalled();
  });

  it('keeps an unknown field named __proto__ as plain data', () => {
    writeFileSync(statePath, '{"lastNetworkCheckAt": 17, "__proto__": {"lastSeenPromotedVersion": "99.0.0"}}');
    const state = readAutoUpdateState(statePath);
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
    expect(state.lastSeenPromotedVersion).toBeNull();
    writeAutoUpdateState(state, statePath);
    expect(readFileSync(statePath, 'utf-8')).toContain('"__proto__"');
  });

  it('logs a file that does not parse and reads it as the defaults, without rewriting it', () => {
    const corrupt = '{"lastNetworkCheckAt": 17';
    writeFileSync(statePath, corrupt);
    expect(readAutoUpdateState(statePath)).toEqual(defaultAutoUpdateState());
    expect(readFileSync(statePath, 'utf-8')).toBe(corrupt);
    expect(loggedErrors).toHaveBeenCalledTimes(1);
    expect(String(loggedErrors.mock.calls[0][1])).toContain('not valid JSON');
  });

  it('logs a file that is JSON but not an object and reads it as the defaults, without rewriting it', () => {
    writeFileSync(statePath, '["15.12.0"]');
    expect(readAutoUpdateState(statePath)).toEqual(defaultAutoUpdateState());
    expect(readFileSync(statePath, 'utf-8')).toBe('["15.12.0"]');
    expect(loggedErrors).toHaveBeenCalledTimes(1);
  });

  it('lets the next normal save replace a corrupt file', () => {
    writeFileSync(statePath, 'not json at all');
    const state = readAutoUpdateState(statePath);
    state.lastNetworkCheckAt = NOW;
    writeAutoUpdateState(state, statePath);
    expect(fileContents()).toEqual({ ...defaultAutoUpdateState(), lastNetworkCheckAt: NOW });
  });

  it('logs a field with the wrong type and reads only that field as its default, without rewriting the file', () => {
    const withWrongFields = JSON.stringify({
      lastNetworkCheckAt: 'yesterday',
      lastSeenPromotedVersion: '15.12.0',
      busyDeferralObservedBusyMs: -5,
      inFlightAttempt: { targetVersion: '15.12.0', previousVersion: '15.11.0', startedAt: NOW, supervisorPid: -1 },
      versionsThatFailedToApply: ['15.11.0', 42, '15.12.1'],
      claudeCodeBackgroundUpdateTurnedOffAt: 'yesterday',
      promotedFileAndNpmMetadataReadAt: -1,
      claudeCodeBackgroundUpdateLeftOnReason: '   ',
      rolloutCohort: { percent: 10 },
    });
    writeFileSync(statePath, withWrongFields);

    const state = readAutoUpdateState(statePath);

    expect(state).toEqual({
      ...defaultAutoUpdateState(),
      lastSeenPromotedVersion: '15.12.0',
      // Valid entries survive: dropping one would let a failed version be tried again.
      versionsThatFailedToApply: ['15.11.0', '15.12.1'],
      // A field this version does not know survives the others being wrong.
      rolloutCohort: { percent: 10 },
    } as AutoUpdateState);
    expect(readFileSync(statePath, 'utf-8')).toBe(withWrongFields);
    expect(loggedErrors).toHaveBeenCalledTimes(1);
    expect(loggedErrors.mock.calls[0][2]).toMatchObject({
      invalidFields: 'lastNetworkCheckAt, busyDeferralObservedBusyMs, inFlightAttempt, claudeCodeBackgroundUpdateTurnedOffAt, promotedFileAndNpmMetadataReadAt, claudeCodeBackgroundUpdateLeftOnReason, versionsThatFailedToApply',
    });
  });

  it('defaults a field that is absent quietly: a file from an older version is not an error', () => {
    writeFileSync(statePath, JSON.stringify({ lastNetworkCheckAt: NOW }));
    expect(readAutoUpdateState(statePath)).toEqual({ ...defaultAutoUpdateState(), lastNetworkCheckAt: NOW });
    expect(loggedErrors).not.toHaveBeenCalled();
  });

  it('throws on a read error other than a missing file, instead of guessing', () => {
    mkdirSync(statePath);
    expect(() => readAutoUpdateState(statePath)).toThrow();
  });

  it('reads a file from before fixCommand, fixCommandWhen, resolvedAt, supervisorDeadlineMs, supervisorPhase and lastDecision existed, quietly', () => {
    const olderOutcome = { result: 'restore_failed', targetVersion: '15.11.0', previousVersion: '15.10.1', finishedAt: NOW, failureStage: 'prove-install', message: 'Run: npx claude-mem@15.10.1 update' };
    const olderAttempt = { targetVersion: '15.12.0', previousVersion: '15.11.0', startedAt: NOW, supervisorPid: 4242 };
    writeFileSync(statePath, JSON.stringify({ lastAttemptOutcome: olderOutcome, inFlightAttempt: olderAttempt }));

    expect(readAutoUpdateState(statePath)).toEqual({ ...defaultAutoUpdateState(), lastAttemptOutcome: olderOutcome, inFlightAttempt: olderAttempt } as AutoUpdateState);
    expect(loggedErrors).not.toHaveBeenCalled();
  });

  it('reads an older restore_failed outcome that records only fixCommand, its fix to run now', () => {
    const olderOutcome = { result: 'restore_failed', targetVersion: '15.13.0', previousVersion: '15.12.0', finishedAt: NOW, failureStage: 'restore-unproven', message: 'Run: npx claude-mem@15.12.0 update', fixCommand: 'npx claude-mem@15.12.0 update' };
    writeFileSync(statePath, JSON.stringify({ lastAttemptOutcome: olderOutcome }));

    const outcome = readAutoUpdateState(statePath).lastAttemptOutcome!;
    expect(outcome).toEqual(olderOutcome as AutoUpdateAttemptOutcome);
    expect(autoUpdateFixOfOutcome(outcome)).toEqual({ command: 'npx claude-mem@15.12.0 update', when: 'now' });
    expect(loggedErrors).not.toHaveBeenCalled();
  });

  it('logs a fixCommand, fixCommandWhen, resolvedAt, resolvedWithWorkerVersion, supervisorDeadlineMs or lastDecision of the wrong type, reading that field as none', () => {
    writeFileSync(statePath, JSON.stringify({
      lastAttemptOutcome: { ...fullState.lastAttemptOutcome, fixCommand: '  ' },
      inFlightAttempt: { ...fullState.inFlightAttempt, supervisorDeadlineMs: -1 },
      lastDecision: { decision: 'not-due', reason: '', decidedAt: NOW },
    }));
    expect(readAutoUpdateState(statePath)).toEqual(defaultAutoUpdateState());
    expect(loggedErrors.mock.calls[0][2]).toMatchObject({ invalidFields: 'inFlightAttempt, lastAttemptOutcome, lastDecision' });

    for (const wrong of [{ resolvedAt: 'yesterday' }, { fixCommandWhen: 'whenever' }, { resolvedWithWorkerVersion: 15 }]) {
      writeFileSync(statePath, JSON.stringify({ lastAttemptOutcome: { ...fullState.lastAttemptOutcome, ...wrong } }));
      expect(readAutoUpdateState(statePath).lastAttemptOutcome).toBeNull();
    }
  });

  it('reads both supervisor phases, and logs one it does not know as an invalid attempt, never guessing how far the supervisor got', () => {
    for (const supervisorPhase of ['installing-target', 'restoring-previous-version'] as const) {
      writeFileSync(statePath, JSON.stringify({ inFlightAttempt: { ...fullState.inFlightAttempt, supervisorPhase } }));
      expect(readAutoUpdateState(statePath).inFlightAttempt).toEqual({ ...fullState.inFlightAttempt!, supervisorPhase });
    }
    expect(loggedErrors).not.toHaveBeenCalled();
    for (const supervisorPhase of ['restoring', '', 2]) {
      writeFileSync(statePath, JSON.stringify({ inFlightAttempt: { ...fullState.inFlightAttempt, supervisorPhase } }));
      expect(readAutoUpdateState(statePath).inFlightAttempt).toBeNull();
    }
    expect(loggedErrors.mock.calls.map((call) => call[2])).toEqual([0, 1, 2].map(() => expect.objectContaining({ invalidFields: 'inFlightAttempt' })));
  });

  it('readAutoUpdateStateFile reports what was wrong instead of logging it, and whether the file exists', () => {
    writeFileSync(statePath, '{"lastNetworkCheckAt": 17');
    expect(readAutoUpdateStateFile(statePath)).toMatchObject({ state: defaultAutoUpdateState(), exists: true, problem: { kind: 'not-json' } });
    writeFileSync(statePath, JSON.stringify({ lastNetworkCheckAt: 'yesterday' }));
    expect(readAutoUpdateStateFile(statePath)).toEqual({ state: defaultAutoUpdateState(), exists: true, problem: { kind: 'invalid-fields', invalidFields: ['lastNetworkCheckAt'] } });
    rmSync(statePath);
    expect(readAutoUpdateStateFile(statePath)).toEqual({ state: defaultAutoUpdateState(), exists: false, problem: null });
    expect(loggedErrors).not.toHaveBeenCalled();
  });
});

/** A pid the scripted liveness probe reports as running, and one it reports as gone. */
const LIVE_SUPERVISOR_PID = 4242;
const DEAD_SUPERVISOR_PID = 4343;
const isProcessAlive = (pid: number): boolean => pid === LIVE_SUPERVISOR_PID;
const MINUTE_MS = 60_000;

const outcome = (result: AutoUpdateAttemptOutcome['result'], extra: Partial<AutoUpdateAttemptOutcome> = {}): AutoUpdateAttemptOutcome => ({
  result,
  targetVersion: '15.13.0',
  previousVersion: '15.12.0',
  finishedAt: NOW - 10 * MINUTE_MS,
  failureStage: result === 'applied' ? undefined : 'prove-install',
  message: 'what happened',
  ...(result === 'restore_failed' ? { fixCommand: 'npx claude-mem@15.12.0 update', fixCommandWhen: 'now' as const } : {}),
  ...extra,
});

/** An attempt the worker launched `ageMs` ago, with the deadline it recorded. */
const attemptStarted = (ageMs: number, supervisorPid: number | null, extra: Partial<AutoUpdateInFlightAttempt> = {}): AutoUpdateInFlightAttempt => ({
  targetVersion: '15.14.0',
  previousVersion: '15.12.0',
  startedAt: NOW - ageMs,
  supervisorPid,
  supervisorDeadlineMs: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS,
  ...extra,
});

const PAST_THE_DEADLINE_MS = AUTO_UPDATE_SUPERVISOR_DEADLINE_MS + MINUTE_MS;

const stateWith = (fields: Partial<AutoUpdateState>): AutoUpdateState => ({ ...defaultAutoUpdateState(), ...structuredClone(fields) });

describe('readInFlightAttempt (the rule every reader outside gate 3 shares)', () => {
  const read = (attempt: AutoUpdateInFlightAttempt) => readInFlightAttempt(attempt, NOW, isProcessAlive);

  it('a recorded supervisor that is gone: interrupted at once, even inside the deadline (a reboot), so the notice never waits it out', () => {
    expect(read(attemptStarted(MINUTE_MS, DEAD_SUPERVISOR_PID))).toBe('interrupted');
    expect(read(attemptStarted(PAST_THE_DEADLINE_MS, DEAD_SUPERVISOR_PID))).toBe('interrupted');
  });

  it('a recorded supervisor still alive: running up to the ceiling gate 3 uses, then taken for a reused pid', () => {
    expect(AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS).toBe(AUTO_UPDATE_CHECK_INTERVAL_MS);
    expect(read(attemptStarted(PAST_THE_DEADLINE_MS, LIVE_SUPERVISOR_PID))).toBe('running');
    expect(read(attemptStarted(AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS, LIVE_SUPERVISOR_PID))).toBe('running');
    expect(read(attemptStarted(AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS + MINUTE_MS, LIVE_SUPERVISOR_PID))).toBe('interrupted');
  });

  it('no supervisor recorded: running inside the recorded deadline, never started past it, and running when no deadline was recorded', () => {
    expect(read(attemptStarted(AUTO_UPDATE_SUPERVISOR_DEADLINE_MS, null))).toBe('running');
    expect(read(attemptStarted(PAST_THE_DEADLINE_MS, null))).toBe('never-started');
    const noDeadline = attemptStarted(PAST_THE_DEADLINE_MS, null);
    delete noDeadline.supervisorDeadlineMs;
    expect(read(noDeadline)).toBe('running');
  });

  it('an age taken in either direction: an attempt dated past now (the clock moved back) by more than the ceiling is interrupted', () => {
    expect(read(attemptStarted(-(AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS + MINUTE_MS), LIVE_SUPERVISOR_PID))).toBe('interrupted');
  });

  it('resolved once a ready worker marked it', () => {
    expect(read(attemptStarted(PAST_THE_DEADLINE_MS, DEAD_SUPERVISOR_PID, { resolvedAt: NOW - MINUTE_MS }))).toBe('resolved');
  });
});

describe('autoUpdateBrokenInstall (the SessionStart notice and the doctor warning)', () => {
  const HALF_WRITTEN: ClaudeMemInstallShape = { kind: 'looks-half-written', what: 'the folder Claude Code loads claude-mem from (/cache/15.14.0) has no node_modules' };
  let shapeReads: number;
  const broken = (fields: Partial<AutoUpdateState>, shape: ClaudeMemInstallShape = HALF_WRITTEN) => {
    shapeReads = 0;
    return autoUpdateBrokenInstall(stateWith(fields), NOW, isProcessAlive, () => { shapeReads++; return shape; });
  };

  it('restore_failed from a file written before fixCommand existed: the forward fix, for once a newer release is out, never a command parsed from the message', () => {
    const older = outcome('restore_failed', { message: 'Run: npx claude-mem@15.12.0 update' });
    delete older.fixCommand;
    delete older.fixCommandWhen;
    expect(broken({ lastAttemptOutcome: older })).toMatchObject({
      kind: 'restore-failed',
      fix: { command: AUTO_UPDATE_FORWARD_FIX_COMMAND, when: 'once-a-release-newer-than-the-target-is-out' },
    });
  });

  it('nothing recorded yet: nothing, and the install is not read', () => {
    expect(broken({})).toBeNull();
    expect(shapeReads).toBe(0);
  });

  it('a gone attempt on a whole install still lets an older restore_failed show', () => {
    expect(broken({ inFlightAttempt: attemptStarted(MINUTE_MS, DEAD_SUPERVISOR_PID), lastAttemptOutcome: outcome('restore_failed') }, { kind: 'looks-whole' }))
      .toMatchObject({ kind: 'restore-failed' });
  });
});

// The worker's step once it has finished starting (worker-service.ts): a
// ready worker on the version the install resolves to shows the install
// works, however it was fixed.
describe('resolveAutoUpdateFailuresOnWorkerReady (a worker that finished starting)', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-resolve-'));
    statePath = path.join(tempDir, AUTO_UPDATE_STATE_FILENAME);
    spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const readyWorker = (workerVersion: string, resolvedVersion: string | null = workerVersion) =>
    resolveAutoUpdateFailuresOnWorkerReady({ statePath, now: NOW, workerVersion, resolvedVersion, isProcessAlive });
  const onDisk = (): AutoUpdateState & Record<string, unknown> => JSON.parse(readFileSync(statePath, 'utf-8'));
  const restoreFailed = outcome('restore_failed', { fixCommand: 'npx claude-mem@15.13.0 update', failureStage: 'supervisor-vanished' });

  it('fixed with npx: the person ran the fix, and a worker on the version it installed finished starting', () => {
    const before = { ...stateWith({ lastAttemptOutcome: restoreFailed, versionsThatFailedToApply: ['15.13.0'] }), aFieldALaterVersionAdded: { kept: true } };
    writeFileSync(statePath, JSON.stringify(before));

    const resolved = readyWorker('15.13.0');

    expect(resolved.outcome).toMatchObject({ result: 'restore_failed', resolvedAt: NOW, resolvedWithWorkerVersion: '15.13.0' });
    // Everything else is kept: the result, stage, message and fix, the blocked version, a field this version does not know.
    expect(onDisk()).toEqual({ ...before, lastAttemptOutcome: { ...restoreFailed, resolvedAt: NOW, resolvedWithWorkerVersion: '15.13.0' } });
    expect(autoUpdateBrokenInstall(readAutoUpdateState(statePath), NOW, isProcessAlive, () => ({ kind: 'looks-whole' }))).toBeNull();
  });

  it('fixed by a version change made outside the npx installer (Claude Code\'s /plugin update, a repair, an older installer): any version, as long as the worker runs the one the install resolves to', () => {
    writeFileSync(statePath, JSON.stringify(stateWith({ lastAttemptOutcome: restoreFailed })));
    expect(readyWorker('15.14.0').outcome).toMatchObject({ resolvedAt: NOW, resolvedWithWorkerVersion: '15.14.0' });
  });

  it('a previous worker that came up after the supervisor gave up on it: resolved, on the previous version', () => {
    const gaveUp = outcome('restore_failed', { failureStage: 'installer-exit', fixCommand: 'npx claude-mem@15.12.0 update', message: 'Nothing switched ... but no worker on 15.12.0 finished starting' });
    writeFileSync(statePath, JSON.stringify(stateWith({ lastAttemptOutcome: gaveUp })));
    expect(readyWorker('15.12.0').outcome).toMatchObject({ result: 'restore_failed', resolvedAt: NOW, resolvedWithWorkerVersion: '15.12.0' });
  });

  it('an attempt cut off without an outcome: marked resolved and left in flight, for the worker\'s gate 3 to record', () => {
    const cutOff = attemptStarted(MINUTE_MS, DEAD_SUPERVISOR_PID);
    writeFileSync(statePath, JSON.stringify(stateWith({ inFlightAttempt: cutOff })));

    expect(readyWorker('15.12.0').interruptedAttempt).toMatchObject({ targetVersion: '15.14.0', resolvedAt: NOW, resolvedWithWorkerVersion: '15.12.0' });
    expect(readAutoUpdateState(statePath).inFlightAttempt).toEqual({ ...cutOff, resolvedAt: NOW, resolvedWithWorkerVersion: '15.12.0' });
  });

  it('a worker on another version than the install resolves to, or nothing resolving: nothing marked, nothing written', () => {
    const raw = JSON.stringify(stateWith({ lastAttemptOutcome: restoreFailed, inFlightAttempt: attemptStarted(MINUTE_MS, DEAD_SUPERVISOR_PID) }));
    writeFileSync(statePath, raw);
    // Pi or DSH started a worker from a marketplace copy of another version.
    expect(readyWorker('15.12.0', '15.13.0')).toEqual({ outcome: null, interruptedAttempt: null });
    expect(readyWorker('15.12.0', null)).toEqual({ outcome: null, interruptedAttempt: null });
    expect(readFileSync(statePath, 'utf-8')).toBe(raw);
  });

  it('never while an attempt\'s supervisor may still be working: this worker may be the one its installer started', () => {
    for (const running of [attemptStarted(PAST_THE_DEADLINE_MS, LIVE_SUPERVISOR_PID), attemptStarted(MINUTE_MS, null)]) {
      const raw = JSON.stringify(stateWith({ inFlightAttempt: running, lastAttemptOutcome: restoreFailed }));
      writeFileSync(statePath, raw);
      expect(readyWorker('15.14.0')).toEqual({ outcome: null, interruptedAttempt: null });
      expect(readFileSync(statePath, 'utf-8')).toBe(raw);
    }
  });

  it('leaves an attempt that never started to gate 3, while still resolving the outcome', () => {
    writeFileSync(statePath, JSON.stringify(stateWith({ inFlightAttempt: attemptStarted(PAST_THE_DEADLINE_MS, null), lastAttemptOutcome: restoreFailed })));
    const resolved = readyWorker('15.12.0');
    expect(resolved.interruptedAttempt).toBeNull();
    expect(resolved.outcome).toMatchObject({ resolvedAt: NOW });
    expect(onDisk().inFlightAttempt).toEqual(attemptStarted(PAST_THE_DEADLINE_MS, null));
  });

  for (const result of ['applied', 'failed', 'restored'] as const) {
    it(`leaves ${result} as it is, and writes nothing: it never needed a fix`, () => {
      const raw = JSON.stringify(stateWith({ lastAttemptOutcome: outcome(result) }));
      writeFileSync(statePath, raw);
      expect(readyWorker('15.12.0')).toEqual({ outcome: null, interruptedAttempt: null });
      expect(readFileSync(statePath, 'utf-8')).toBe(raw);
    });
  }

  it('keeps the time of the first resolution: an outcome already resolved is not written again', () => {
    const raw = JSON.stringify(stateWith({ lastAttemptOutcome: { ...restoreFailed, resolvedAt: NOW - 60 * MINUTE_MS, resolvedWithWorkerVersion: '15.13.0' } }));
    writeFileSync(statePath, raw);
    expect(readyWorker('15.13.0').outcome).toBeNull();
    expect(readFileSync(statePath, 'utf-8')).toBe(raw);
  });

  it('leaves a missing state file missing, and throws on one it cannot read, for the worker to log', () => {
    expect(readyWorker('15.12.0')).toEqual({ outcome: null, interruptedAttempt: null });
    expect(existsSync(statePath)).toBe(false);
    mkdirSync(statePath);
    expect(() => readyWorker('15.12.0')).toThrow();
  });
});
