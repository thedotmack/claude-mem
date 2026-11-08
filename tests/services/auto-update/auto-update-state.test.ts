import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import {
  AUTO_UPDATE_STATE_FILENAME,
  autoUpdateStatePath,
  defaultAutoUpdateState,
  readAutoUpdateState,
  writeAutoUpdateState,
  type AutoUpdateState,
} from '../../../src/services/auto-update/auto-update-state.js';
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
  inFlightAttempt: { targetVersion: '15.12.0', previousVersion: '15.11.0', startedAt: NOW, supervisorPid: 4242 },
  lastAttemptOutcome: {
    result: 'restore_failed',
    targetVersion: '15.11.0',
    previousVersion: '15.10.1',
    finishedAt: NOW - 5_000,
    failureStage: 'installer-timeout',
    message: 'Run: npx claude-mem@15.10.1 update',
  },
  versionsThatFailedToApply: ['15.11.0'],
  lastCheckError: { at: NOW, message: 'HTTP 503' },
  claudeCodeBackgroundUpdateTurnedOffAt: NOW - 7_200_000,
  promotedFileAndNpmMetadataReadAt: NOW - 3_600_000,
  claudeCodeBackgroundUpdateLeftOnReason: 'npx is not on the worker\'s PATH, so claude-mem\'s updater could not run its installer',
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
});
