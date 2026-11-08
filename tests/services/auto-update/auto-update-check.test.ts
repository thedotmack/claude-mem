import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS,
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  AUTO_UPDATE_FETCH_TIMEOUT_MS,
  AUTO_UPDATE_FIRST_TICK_DELAY_MS,
  AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS,
  AUTO_UPDATE_QUIET_WINDOW_MS,
  AUTO_UPDATE_TICK_INTERVAL_MS,
  DEFAULT_PROMOTED_RELEASE_URL,
  AutoUpdateCheckError,
  autoUpdateDisabledReason,
  claudeCodeManagedSettingsDirectory,
  claudeCodeSwitchInForce,
  fetchJsonWithTimeout,
  isWorkerQuietBySignals,
  logFailedAutoUpdateTick,
  npmVersionMetadataUrl,
  parseAutoUpdateSwitch,
  readAutoUpdateSettings,
  readClaudeCodeSettingsEnvBlocks,
  resolvePromotedReleaseUrl,
  runAutoUpdateCheck,
  type AutoUpdateCheckDeps,
  type AutoUpdateDecision,
  type AutoUpdateDecisionName,
  type AutoUpdateOncePerBootLogKey,
  type AutoUpdateSettings,
  type ClaudeCodeSettingsEnvBlock,
  type FetchJsonResult,
  type WorkerQuietSignals,
} from '../../../src/services/auto-update/auto-update-check.js';
import { AUTO_UPDATE_SUPERVISOR_DEADLINE_MS } from '../../../src/services/auto-update/auto-update-deadlines.js';
import { defaultAutoUpdateState, type AutoUpdateState } from '../../../src/services/auto-update/auto-update-state.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { PluginRootResolution } from '../../../src/shared/worker-utils.js';
import { sanitizeEnv } from '../../../src/supervisor/env-sanitizer.js';
import { logger } from '../../../src/utils/logger.js';

// runAutoUpdateCheck walks its gates with every effect injected: in-memory
// settings and state, a scripted fetch and a fixed clock. Nothing here touches
// the network, the real ~/.claude or the real data dir; the settings-file
// readers only read files this test writes into its own scratch directories.

// Project-local scratch (gitignored), never the system temp folder, as in
// tests/worker/http/routes/setup-state-routes.test.ts.
const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const INSTALLED = '15.11.0';
const PROMOTED = '15.12.0';
const PROMOTED_URL = 'https://raw.githubusercontent.com/thedotmack/claude-mem/main/releases/promoted-release.json';
const CLAUDE_CONFIG = path.resolve('auto-update-fixture', '.claude');
const CACHE_ROOT = path.join(CLAUDE_CONFIG, 'plugins', 'cache', 'thedotmack', 'claude-mem');
const MARKETPLACE = path.join(CLAUDE_CONFIG, 'plugins', 'marketplaces', 'thedotmack');
/** A supervisor pid the scripted liveness probe reports as running. */
const LIVE_SUPERVISOR_PID = 4242;
/** One it reports as gone. */
const DEAD_SUPERVISOR_PID = 4343;

/** The settings every row starts from: what SettingsDefaultsManager ships. */
const SHIPPED_SETTINGS: AutoUpdateSettings = {
  CLAUDE_MEM_AUTO_UPDATE: 'true',
  CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: '',
  CLAUDE_MEM_WORKER_AUTOSTART: 'true',
  CLAUDE_MEM_WORKER_URL: '',
};

const json = (body: unknown, status = 200): FetchJsonResult => ({ ok: status >= 200 && status < 300, status, body: status < 300 ? body : null });

/** The shape registry.npmjs.org/claude-mem/15.12.0 had on 2026-11-07, cut to the fields the check reads. */
function workflowPublishedManifest(version: string): Record<string, unknown> {
  return {
    name: 'claude-mem',
    version,
    gitHead: 'eb00299a6a749fd00c8429a16407ce00c64e5adf',
    dist: {
      tarball: `https://registry.npmjs.org/claude-mem/-/claude-mem-${version}.tgz`,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/claude-mem@${version}`,
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
  };
}

interface Scenario {
  /** Values may be any JSON a hand-edited settings.json can hold. */
  settings?: Partial<Record<keyof AutoUpdateSettings, unknown>>;
  env?: NodeJS.ProcessEnv;
  /** The env blocks of Claude Code's settings files; none by default. */
  claudeCodeSettingsEnv?: ClaudeCodeSettingsEnvBlock[];
  install?: PluginRootResolution | null;
  state?: Partial<AutoUpdateState> & Record<string, unknown>;
  /** Overrides by URL; defaults: the promoted file names PROMOTED and npm shows it fully published. */
  responses?: Record<string, FetchJsonResult | Error>;
  quiet?: boolean;
}

interface CheckHarness {
  deps: AutoUpdateCheckDeps;
  stored: () => AutoUpdateState & Record<string, unknown>;
  writes: AutoUpdateState[];
  stateReads: () => number;
  claudeCodeSettingsReads: () => number;
  fetches: Array<{ url: string; timeoutMs: number }>;
  launches: Array<{ targetVersion: string; previousVersion: string }>;
  livenessProbes: number[];
  pluginRootLookups: () => number;
}

function buildCheckHarness(scenario: Scenario = {}): CheckHarness {
  let stored = { ...defaultAutoUpdateState(), ...structuredClone(scenario.state ?? {}) } as AutoUpdateState & Record<string, unknown>;
  let stateReads = 0;
  let claudeCodeSettingsReads = 0;
  let pluginRootLookups = 0;
  const writes: AutoUpdateState[] = [];
  const fetches: Array<{ url: string; timeoutMs: number }> = [];
  const launches: Array<{ targetVersion: string; previousVersion: string }> = [];
  const livenessProbes: number[] = [];
  const responses: Record<string, FetchJsonResult | Error> = {
    [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: PROMOTED }),
    [npmVersionMetadataUrl(PROMOTED)]: json(workflowPublishedManifest(PROMOTED)),
    ...scenario.responses,
  };
  const deps: AutoUpdateCheckDeps = {
    now: () => NOW,
    env: scenario.env ?? {},
    readSettings: () => ({ ...SHIPPED_SETTINGS, ...scenario.settings }) as AutoUpdateSettings,
    readClaudeCodeSettingsEnv: () => {
      claudeCodeSettingsReads++;
      return { envBlocks: structuredClone(scenario.claudeCodeSettingsEnv ?? []), skipped: [] };
    },
    readState: () => { stateReads++; return structuredClone(stored); },
    writeState: (state) => { stored = structuredClone(state) as typeof stored; writes.push(structuredClone(state)); },
    resolvePluginRoot: () => {
      pluginRootLookups++;
      return scenario.install !== undefined
        ? scenario.install
        : { root: path.join(CACHE_ROOT, INSTALLED), version: INSTALLED, missingDependencies: [] };
    },
    pluginCacheRootDirectory: () => CACHE_ROOT,
    marketplaceDirectory: () => MARKETPLACE,
    fetchJson: async (url, timeoutMs) => {
      fetches.push({ url, timeoutMs });
      const response = responses[url] ?? new Error(`no scripted response for ${url}`);
      if (response instanceof Error) throw response;
      return response;
    },
    isWorkerQuiet: () => scenario.quiet ?? true,
    isProcessAlive: (pid) => { livenessProbes.push(pid); return pid === LIVE_SUPERVISOR_PID; },
    isWorkerShuttingDown: () => false,
    launchSupervisor: async (attempt) => { launches.push(attempt); },
    oncePerBootLogsWritten: new Set<AutoUpdateOncePerBootLogKey>(),
  };
  return {
    deps,
    stored: () => stored,
    writes,
    stateReads: () => stateReads,
    claudeCodeSettingsReads: () => claudeCodeSettingsReads,
    fetches,
    launches,
    livenessProbes,
    pluginRootLookups: () => pluginRootLookups,
  };
}

function silenceLogger() {
  return {
    info: spyOn(logger, 'info').mockImplementation(() => {}),
    warn: spyOn(logger, 'warn').mockImplementation(() => {}),
    debug: spyOn(logger, 'debug').mockImplementation(() => {}),
    error: spyOn(logger, 'error').mockImplementation(() => {}),
  };
}

type LogSpies = ReturnType<typeof silenceLogger>;

const loggedDecisions = (spies: LogSpies): string[] =>
  [spies.info, spies.warn, spies.debug, spies.error].flatMap((spy) => spy.mock.calls.map((call) => String(call[1])))
    .filter((message) => message.startsWith('Auto-update decision: '))
    .map((message) => message.slice('Auto-update decision: '.length));

const inFlightAttemptState = (startedAt: number, supervisorPid: number | null): Partial<AutoUpdateState> => ({
  inFlightAttempt: { targetVersion: PROMOTED, previousVersion: INSTALLED, startedAt, supervisorPid },
});

const userSettingsEnv = (env: Record<string, unknown>): ClaudeCodeSettingsEnvBlock =>
  ({ path: path.join(CLAUDE_CONFIG, 'settings.json'), env });
const managedSettingsEnv = (env: Record<string, unknown>): ClaudeCodeSettingsEnvBlock =>
  ({ path: '/Library/Application Support/ClaudeCode/managed-settings.json', env });

/** Off by claude-mem's own settings or the worker's env: Claude Code's settings files are not even read. */
function expectNothingTouchedAfterSettings(checkHarness: CheckHarness): void {
  expect(checkHarness.claudeCodeSettingsReads()).toBe(0);
  expect(checkHarness.pluginRootLookups()).toBe(0);
  expect(checkHarness.stateReads()).toBe(0);
  expect(checkHarness.writes).toHaveLength(0);
  expect(checkHarness.fetches).toHaveLength(0);
}

/** Off by a switch in one of Claude Code's settings files: read once, and nothing after it. */
function expectNothingTouchedAfterClaudeCodeSettings(checkHarness: CheckHarness): void {
  expect(checkHarness.claudeCodeSettingsReads()).toBe(1);
  expect(checkHarness.pluginRootLookups()).toBe(0);
  expect(checkHarness.stateReads()).toBe(0);
  expect(checkHarness.writes).toHaveLength(0);
  expect(checkHarness.fetches).toHaveLength(0);
}

function expectVanishedSupervisorRecordedAsFailed(checkHarness: CheckHarness, messagePart: string): void {
  const state = checkHarness.stored();
  expect(state.inFlightAttempt).toBeNull();
  expect(state.lastAttemptOutcome).toMatchObject({
    result: 'failed',
    targetVersion: PROMOTED,
    previousVersion: INSTALLED,
    finishedAt: NOW,
    failureStage: 'supervisor-vanished',
    message: expect.stringContaining(messagePart),
  });
  // Never retried automatically: the next check in the same tick refuses it.
  expect(state.versionsThatFailedToApply).toEqual([PROMOTED]);
}

function expectCheckError(checkHarness: CheckHarness, messagePart: string): void {
  expect(checkHarness.stored().lastNetworkCheckAt).toBe(NOW);
  expect(checkHarness.stored().lastCheckError).toEqual({ at: NOW, message: expect.stringContaining(messagePart) });
}

const pendingDeferralState = (lastSeenPromotedVersion: string): Partial<AutoUpdateState> => ({
  busyDeferralStartedAt: NOW - 3 * HOUR_MS,
  busyDeferralObservedBusyMs: 2 * HOUR_MS,
  busyDeferralLastBusyObservationAt: NOW - HOUR_MS,
  lastNetworkCheckAt: NOW - 3 * HOUR_MS,
  lastSeenPromotedVersion,
});

afterEach(() => mock.restore());

describe('runAutoUpdateCheck — one row per gate', () => {
  const rows: Array<{
    name: string;
    scenario: Scenario;
    decision: AutoUpdateDecisionName;
    verify?: (checkHarness: CheckHarness, result: AutoUpdateDecision) => void;
  }> = [
    // Gate 1: off switches.
    { name: 'off: CLAUDE_MEM_AUTO_UPDATE=false', scenario: { settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } }, decision: 'disabled', verify: expectNothingTouchedAfterSettings },
    {
      name: 'off: CLAUDE_MEM_AUTO_UPDATE=0 (only "true" is on)',
      scenario: { settings: { CLAUDE_MEM_AUTO_UPDATE: '0' } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'disabled', reason: 'CLAUDE_MEM_AUTO_UPDATE="0" (only "true" turns it on)' });
        expectNothingTouchedAfterSettings(checkHarness);
      },
    },
    {
      name: 'off: DISABLE_AUTOUPDATER=1, read after Claude Code\'s settings files, where FORCE_AUTOUPDATE_PLUGINS could override it',
      scenario: { env: { DISABLE_AUTOUPDATER: '1' } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'disabled', reason: 'DISABLE_AUTOUPDATER is set (Claude Code\'s switch for no background updates)' });
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness);
      },
    },
    { name: 'off: DISABLE_UPDATES=1', scenario: { env: { DISABLE_UPDATES: '1' } }, decision: 'disabled', verify: expectNothingTouchedAfterSettings },
    { name: 'off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', scenario: { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }, decision: 'disabled', verify: expectNothingTouchedAfterSettings },
    {
      name: 'off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0 (any non-empty value is on)',
      scenario: { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'disabled', reason: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set (Claude Code\'s switch for no background updates)' });
        expectNothingTouchedAfterSettings(checkHarness);
      },
    },
    { name: 'off: CLAUDE_MEM_WORKER_AUTOSTART=false', scenario: { settings: { CLAUDE_MEM_WORKER_AUTOSTART: 'false' } }, decision: 'disabled', verify: expectNothingTouchedAfterSettings },
    { name: 'off: CLAUDE_MEM_WORKER_URL is set', scenario: { settings: { CLAUDE_MEM_WORKER_URL: 'http://192.168.1.20:37777' } }, decision: 'disabled', verify: expectNothingTouchedAfterSettings },
    {
      name: 'off: DISABLE_AUTOUPDATER=1 in the env block of Claude Code\'s user settings',
      scenario: { claudeCodeSettingsEnv: [userSettingsEnv({ DISABLE_AUTOUPDATER: '1' })] },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({
          decision: 'disabled',
          reason: `DISABLE_AUTOUPDATER is set in the env block of ${path.join(CLAUDE_CONFIG, 'settings.json')} (Claude Code's switch for no background updates)`,
        });
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness);
      },
    },
    {
      name: 'off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="false" in Claude Code\'s managed settings',
      scenario: { claudeCodeSettingsEnv: [userSettingsEnv({ DISABLE_AUTOUPDATER: '0' }), managedSettingsEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'false' })] },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ reason: expect.stringContaining('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set in the env block of /Library/Application Support/ClaudeCode/managed-settings.json') });
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness);
      },
    },
    {
      name: 'on: Claude Code\'s settings files exist but set no switch (DISABLE_UPDATES=0 is off)',
      scenario: { claudeCodeSettingsEnv: [userSettingsEnv({ DISABLE_UPDATES: '0', ANTHROPIC_MODEL: 'opus' }), managedSettingsEnv({})] },
      decision: 'apply',
    },
    // FORCE_AUTOUPDATE_PLUGINS=1 forces plugin auto-updates over DISABLE_AUTOUPDATER, read from the same places.
    { name: 'on: DISABLE_AUTOUPDATER=1 with FORCE_AUTOUPDATE_PLUGINS=1, both in the env', scenario: { env: { DISABLE_AUTOUPDATER: '1', FORCE_AUTOUPDATE_PLUGINS: '1' } }, decision: 'apply' },
    {
      name: 'on: DISABLE_AUTOUPDATER=1 in the env, FORCE_AUTOUPDATE_PLUGINS=1 in Claude Code\'s user settings',
      scenario: { env: { DISABLE_AUTOUPDATER: '1' }, claudeCodeSettingsEnv: [userSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: '1' })] },
      decision: 'apply',
    },
    {
      name: 'on: DISABLE_AUTOUPDATER=1 in Claude Code\'s managed settings, FORCE_AUTOUPDATE_PLUGINS=1 in the env',
      scenario: { env: { FORCE_AUTOUPDATE_PLUGINS: '1' }, claudeCodeSettingsEnv: [managedSettingsEnv({ DISABLE_AUTOUPDATER: '1' })] },
      decision: 'apply',
    },
    {
      name: 'off: DISABLE_UPDATES=1 still turns it off with FORCE_AUTOUPDATE_PLUGINS=1, and nothing else is read',
      scenario: { env: { DISABLE_UPDATES: '1', FORCE_AUTOUPDATE_PLUGINS: '1' } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'disabled', reason: 'DISABLE_UPDATES is set (Claude Code\'s switch for no background updates)' });
        expectNothingTouchedAfterSettings(checkHarness);
      },
    },
    {
      name: 'off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC still turns it off with FORCE_AUTOUPDATE_PLUGINS=1',
      scenario: { env: { FORCE_AUTOUPDATE_PLUGINS: '1' }, claudeCodeSettingsEnv: [userSettingsEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' })] },
      decision: 'disabled',
      verify: (_checkHarness, result) => {
        expect(result).toMatchObject({ reason: expect.stringContaining('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set in the env block of') });
      },
    },
    {
      name: 'off: FORCE_AUTOUPDATE_PLUGINS=true does not force (only 1 does)',
      scenario: { env: { DISABLE_AUTOUPDATER: '1', FORCE_AUTOUPDATE_PLUGINS: 'true' } },
      decision: 'disabled',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ reason: expect.stringContaining('DISABLE_AUTOUPDATER is set') }),
    },
    {
      name: 'off: FORCE_AUTOUPDATE_PLUGINS=1 in the user\'s settings does not force while managed settings set it to 0',
      scenario: {
        claudeCodeSettingsEnv: [userSettingsEnv({ DISABLE_AUTOUPDATER: '1', FORCE_AUTOUPDATE_PLUGINS: '1' }), managedSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: '0' })],
      },
      decision: 'disabled',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ reason: expect.stringContaining(`DISABLE_AUTOUPDATER is set in the env block of ${path.join(CLAUDE_CONFIG, 'settings.json')}`) }),
    },

    // Gate 2: install shape.
    { name: 'no install', scenario: { install: null }, decision: 'no-install' },
    {
      name: 'dev checkout (root outside the plugin cache and the marketplace)',
      scenario: { install: { root: path.resolve('claude-mem-checkout', 'plugin'), version: '15.13.0', missingDependencies: [] } },
      decision: 'not-a-standard-install',
      verify: (checkHarness) => { expect(checkHarness.stateReads()).toBe(0); expect(checkHarness.fetches).toHaveLength(0); },
    },
    {
      name: 'unknown installed version is never read as "update needed"',
      scenario: { install: { root: path.join(MARKETPLACE, 'plugin'), version: null, missingDependencies: [] } },
      decision: 'unknown-installed-version',
      verify: (checkHarness) => expect(checkHarness.fetches).toHaveLength(0),
    },
    {
      name: 'an installed version that is not X.Y.Z ("dev") is unknown too',
      scenario: { install: { root: path.join(MARKETPLACE, 'plugin'), version: 'dev', missingDependencies: [] } },
      decision: 'unknown-installed-version',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ installedVersion: 'dev' });
        expect(checkHarness.stateReads()).toBe(0);
        expect(checkHarness.fetches).toHaveLength(0);
      },
    },

    // Gate 3: one attempt at a time.
    {
      name: 'attempt in flight with a live supervisor',
      scenario: { state: inFlightAttemptState(NOW - 10 * MINUTE_MS, LIVE_SUPERVISOR_PID) },
      decision: 'attempt-in-flight',
      verify: (checkHarness) => { expect(checkHarness.writes).toHaveLength(0); expect(checkHarness.fetches).toHaveLength(0); },
    },
    {
      name: 'attempt in flight whose supervisor has not recorded its pid yet',
      scenario: { state: inFlightAttemptState(NOW - MINUTE_MS, null) },
      decision: 'attempt-in-flight',
    },
    {
      name: 'within the deadline a dead pid does not end the attempt: its installer may still run, and the pid is not even probed',
      scenario: { state: inFlightAttemptState(NOW - 10 * MINUTE_MS, DEAD_SUPERVISOR_PID) },
      decision: 'attempt-in-flight',
      verify: (checkHarness) => expect(checkHarness.livenessProbes).toEqual([]),
    },
    {
      name: 'attempt exactly at the supervisor deadline is still in flight',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS, null) },
      decision: 'attempt-in-flight',
      verify: (checkHarness) => expect(checkHarness.writes).toHaveLength(0),
    },
    {
      name: 'past the deadline but its supervisor is alive (a laptop slept through the install): still in flight',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - 9 * HOUR_MS, LIVE_SUPERVISOR_PID) },
      decision: 'attempt-in-flight',
      verify: (checkHarness) => {
        expect(checkHarness.livenessProbes).toEqual([LIVE_SUPERVISOR_PID]);
        expect(checkHarness.writes).toHaveLength(0);
        expect(checkHarness.stored().versionsThatFailedToApply).toEqual([]);
      },
    },
    {
      name: 'a live supervisor exactly one check cycle old is still in flight',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS, LIVE_SUPERVISOR_PID) },
      decision: 'attempt-in-flight',
    },
    {
      name: 'vanished: one millisecond past the supervisor deadline with no pid recorded',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - 1, null) },
      decision: 'previously-failed',
      verify: (checkHarness) => expectVanishedSupervisorRecordedAsFailed(checkHarness, 'recorded neither a supervisor pid nor an outcome'),
    },
    {
      name: 'vanished: past the deadline, and its supervisor is no longer running',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID) },
      decision: 'previously-failed',
      verify: (checkHarness) => {
        expect(checkHarness.livenessProbes).toEqual([DEAD_SUPERVISOR_PID]);
        expectVanishedSupervisorRecordedAsFailed(checkHarness, 'its supervisor is no longer running');
      },
    },
    {
      name: 'vanished: a pid still alive one millisecond past a full check cycle is treated as reused',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS - 1, LIVE_SUPERVISOR_PID) },
      decision: 'previously-failed',
      verify: (checkHarness) => expectVanishedSupervisorRecordedAsFailed(checkHarness, 'treated as another process that reused it'),
    },
    {
      name: 'vanished: started "later" than now by more than the deadline (the clock moved back), supervisor gone',
      scenario: { state: inFlightAttemptState(NOW + AUTO_UPDATE_SUPERVISOR_DEADLINE_MS + MINUTE_MS, DEAD_SUPERVISOR_PID) },
      decision: 'previously-failed',
      verify: (checkHarness) => expectVanishedSupervisorRecordedAsFailed(checkHarness, 'no longer running'),
    },
    {
      name: 'vanished, but the install already reports the target: recorded as applied, the version not blocked',
      scenario: {
        install: { root: path.join(CACHE_ROOT, PROMOTED), version: PROMOTED, missingDependencies: [] },
        state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID),
      },
      decision: 'up-to-date',
      verify: (checkHarness) => {
        const state = checkHarness.stored();
        expect(state.inFlightAttempt).toBeNull();
        expect(state.lastAttemptOutcome).toEqual({
          result: 'applied',
          targetVersion: PROMOTED,
          previousVersion: INSTALLED,
          finishedAt: NOW,
          message: expect.stringContaining(`The install reports ${PROMOTED}`),
        });
        expect(state.versionsThatFailedToApply).toEqual([]);
      },
    },

    // Gate 4: due.
    {
      name: 'not due: the last check was 23 h ago',
      scenario: { state: { lastNetworkCheckAt: NOW - 23 * HOUR_MS } },
      decision: 'not-due',
      verify: (checkHarness) => { expect(checkHarness.fetches).toHaveLength(0); expect(checkHarness.writes).toHaveLength(0); },
    },
    {
      name: 'a pending deferral for a version the install already has ends as up-to-date, without the network',
      scenario: {
        quiet: false,
        install: { root: path.join(CACHE_ROOT, PROMOTED), version: PROMOTED, missingDependencies: [] },
        state: pendingDeferralState(PROMOTED),
      },
      decision: 'up-to-date',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'up-to-date', installedVersion: PROMOTED, promotedVersion: PROMOTED });
        expect(checkHarness.fetches).toEqual([]);
        expect(checkHarness.stored()).toMatchObject({ busyDeferralStartedAt: null, busyDeferralObservedBusyMs: 0, busyDeferralLastBusyObservationAt: null });
      },
    },
    {
      name: 'a pending deferral ends too when the install is already past its version',
      scenario: {
        quiet: false,
        install: { root: path.join(MARKETPLACE, 'plugin'), version: '15.13.0', missingDependencies: [] },
        state: pendingDeferralState(PROMOTED),
      },
      decision: 'up-to-date',
      verify: (checkHarness) => {
        expect(checkHarness.fetches).toEqual([]);
        expect(checkHarness.stored().busyDeferralStartedAt).toBeNull();
      },
    },

    // Gate 5: the promoted file.
    {
      name: 'fetch error',
      scenario: { responses: { [PROMOTED_URL]: new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') } },
      decision: 'check-failed',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ stage: 'fetch-promoted-release' });
        expectCheckError(checkHarness, 'ENOTFOUND');
      },
    },
    {
      name: 'fetch error: the promoted file answers HTTP 404',
      scenario: { responses: { [PROMOTED_URL]: json(null, 404) } },
      decision: 'check-failed',
      verify: (checkHarness) => expectCheckError(checkHarness, 'HTTP 404'),
    },
    {
      name: 'fetch error: promotedVersion is not an exact version',
      scenario: { responses: { [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: 'latest' }) } },
      decision: 'check-failed',
      verify: (checkHarness) => expect(checkHarness.stored().lastSeenPromotedVersion).toBeNull(),
    },
    {
      name: 'unknown schema: a later format (schemaVersion 2) applies nothing and records why for the doctor row',
      scenario: { responses: { [PROMOTED_URL]: json({ schemaVersion: 2, promotedVersion: PROMOTED, rollout: { percent: 10 } }) } },
      decision: 'unknown-schema',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'unknown-schema', schemaVersion: 2 });
        expect(checkHarness.fetches.map((recordedFetch) => recordedFetch.url)).toEqual([PROMOTED_URL]);
        expect(checkHarness.stored().lastSeenPromotedVersion).toBeNull();
        expectCheckError(checkHarness, 'its schemaVersion is 2, not the schemaVersion 1 this version reads');
      },
    },
    {
      name: 'unknown schema: no schemaVersion (a wrong URL, or a proxy\'s own JSON page)',
      scenario: { responses: { [PROMOTED_URL]: json({ error: 'blocked by policy', promotedVersion: PROMOTED }) } },
      decision: 'unknown-schema',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'unknown-schema', schemaVersion: null });
        expectCheckError(checkHarness, 'it has no schemaVersion');
        expect(checkHarness.stored().lastSeenPromotedVersion).toBeNull();
      },
    },
    {
      name: 'unknown schema: schemaVersion "1" is text, not the number 1',
      scenario: { responses: { [PROMOTED_URL]: json({ schemaVersion: '1', promotedVersion: PROMOTED }) } },
      decision: 'unknown-schema',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'unknown-schema', schemaVersion: '1' });
        expectCheckError(checkHarness, 'its schemaVersion is "1"');
      },
    },
    {
      name: 'unknown schema: schemaVersion 0',
      scenario: { responses: { [PROMOTED_URL]: json({ schemaVersion: 0, promotedVersion: PROMOTED }) } },
      decision: 'unknown-schema',
      verify: (checkHarness) => expectCheckError(checkHarness, 'its schemaVersion is 0'),
    },
    {
      name: 'unknown schema: JSON that is not an object',
      scenario: { responses: { [PROMOTED_URL]: json([PROMOTED]) } },
      decision: 'unknown-schema',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'unknown-schema', schemaVersion: null });
        expectCheckError(checkHarness, 'the answer is not a JSON object (an array)');
      },
    },

    // Gate 6: forward only.
    {
      name: 'promoted equal to installed',
      scenario: { responses: { [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: INSTALLED }) } },
      decision: 'up-to-date',
      verify: (checkHarness) => expect(checkHarness.stored().lastSeenPromotedVersion).toBe(INSTALLED),
    },
    {
      name: 'promoted lower than installed (never downgrade)',
      scenario: { responses: { [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: '15.10.1' }) } },
      decision: 'up-to-date',
    },
    {
      name: 'promoted version failed to apply before',
      scenario: { state: { versionsThatFailedToApply: [PROMOTED] } },
      decision: 'previously-failed',
      verify: (checkHarness) => expect(checkHarness.fetches.map((recordedFetch) => recordedFetch.url)).toEqual([PROMOTED_URL]),
    },

    // Gate 7: fully published.
    {
      name: 'npm is missing gitHead',
      scenario: { responses: { [npmVersionMetadataUrl(PROMOTED)]: json({ ...workflowPublishedManifest(PROMOTED), gitHead: undefined }) } },
      decision: 'not-published-by-workflow',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ missing: ['gitHead'] }),
    },
    {
      name: 'npm is missing provenance',
      scenario: { responses: { [npmVersionMetadataUrl(PROMOTED)]: json({ ...workflowPublishedManifest(PROMOTED), dist: { tarball: 'x' } }) } },
      decision: 'not-published-by-workflow',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ missing: ['SLSA provenance'] }),
    },
    {
      name: 'npm metadata with neither, as for the failed 15.8.2 publish',
      scenario: {
        install: { root: path.join(CACHE_ROOT, '15.8.1'), version: '15.8.1', missingDependencies: [] },
        responses: {
          [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: '15.8.2' }),
          [npmVersionMetadataUrl('15.8.2')]: json({ name: 'claude-mem', version: '15.8.2', dist: { tarball: 'x', shasum: 'y' } }),
        },
      },
      decision: 'not-published-by-workflow',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ missing: ['gitHead', 'SLSA provenance'] }),
    },
    {
      name: 'npm metadata for another version than the one asked for',
      scenario: { responses: { [npmVersionMetadataUrl(PROMOTED)]: json(workflowPublishedManifest('15.11.9')) } },
      decision: 'not-published-by-workflow',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ missing: ['matching version'] }),
    },
    {
      name: 'npm has no such version (99.0.0 answers HTTP 404)',
      scenario: {
        responses: {
          [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: '99.0.0' }),
          [npmVersionMetadataUrl('99.0.0')]: json('version not found: 99.0.0', 404),
        },
      },
      decision: 'not-published-by-workflow',
    },
    {
      name: 'registry fault: npm answers JSON that is not an object',
      scenario: { responses: { [npmVersionMetadataUrl(PROMOTED)]: json(PROMOTED) } },
      decision: 'check-failed',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ stage: 'fetch-npm-metadata' });
        expectCheckError(checkHarness, 'not a JSON object');
      },
    },
    {
      name: 'registry fault: npm answers HTTP 503',
      scenario: { responses: { [npmVersionMetadataUrl(PROMOTED)]: json(null, 503) } },
      decision: 'check-failed',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ stage: 'fetch-npm-metadata' });
        expectCheckError(checkHarness, 'HTTP 503');
      },
    },

    // Gate 8: quiet.
    {
      name: 'busy: the deferral starts with no busy time counted yet',
      scenario: { quiet: false },
      decision: 'deferred-busy',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'deferred-busy', promotedVersion: PROMOTED, busySince: NOW, observedBusyMs: 0 });
        expect(checkHarness.stored()).toMatchObject({
          busyDeferralStartedAt: NOW,
          busyDeferralObservedBusyMs: 0,
          busyDeferralLastBusyObservationAt: NOW,
        });
      },
    },
    {
      name: 'busy for 24 h of observed busy time applies anyway',
      scenario: {
        quiet: false,
        state: {
          busyDeferralStartedAt: NOW - 24 * HOUR_MS,
          busyDeferralObservedBusyMs: 23 * HOUR_MS,
          busyDeferralLastBusyObservationAt: NOW - HOUR_MS,
          lastNetworkCheckAt: NOW - 24 * HOUR_MS,
          lastSeenPromotedVersion: PROMOTED,
        },
      },
      decision: 'apply',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ applyReason: 'busy-for-a-full-check-cycle' });
        expect(checkHarness.launches).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
        expect(checkHarness.stored()).toMatchObject({
          busyDeferralStartedAt: null,
          busyDeferralObservedBusyMs: 0,
          busyDeferralLastBusyObservationAt: null,
        });
      },
    },

    // Gate 9: apply.
    {
      name: 'apply',
      scenario: {},
      decision: 'apply',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'apply', targetVersion: PROMOTED, previousVersion: INSTALLED, applyReason: 'quiet' });
        expect(checkHarness.launches).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
        expect(checkHarness.fetches.map((recordedFetch) => recordedFetch.url)).toEqual([PROMOTED_URL, npmVersionMetadataUrl(PROMOTED)]);
        expect(checkHarness.stored()).toMatchObject({ lastNetworkCheckAt: NOW, lastSeenPromotedVersion: PROMOTED, busyDeferralStartedAt: null, lastCheckError: null });
      },
    },
  ];

  for (const row of rows) {
    it(row.name, async () => {
      const spies = silenceLogger();
      const checkHarness = buildCheckHarness(row.scenario);
      const result = await runAutoUpdateCheck(checkHarness.deps);
      expect(result.decision).toBe(row.decision);
      // Each gate logs the decision it returns.
      expect(loggedDecisions(spies)).toContain(row.decision);
      if (row.decision !== 'apply') expect(checkHarness.launches).toEqual([]);
      for (const recordedFetch of checkHarness.fetches) expect(recordedFetch.timeoutMs).toBe(AUTO_UPDATE_FETCH_TIMEOUT_MS);
      row.verify?.(checkHarness, result);
    });
  }
});

describe('runAutoUpdateCheck — across ticks', () => {
  it('counts a failed fetch as the day\'s check, so a broken network never retries hourly', async () => {
    silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness({ responses: { [PROMOTED_URL]: new Error('connect ETIMEDOUT') } });
    checkHarness.deps.now = () => now;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('check-failed');
    expect(checkHarness.stored().lastNetworkCheckAt).toBe(NOW);

    for (let hour = 1; hour < 24; hour++) {
      now = NOW + hour * HOUR_MS;
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    }
    expect(checkHarness.fetches).toHaveLength(1);

    now = NOW + AUTO_UPDATE_CHECK_INTERVAL_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('check-failed');
    expect(checkHarness.fetches).toHaveLength(2);
    expect(checkHarness.stored().lastNetworkCheckAt).toBe(now);
  });

  it('re-checks a busy deferral every tick without the network, then confirms the promoted version before applying', async () => {
    silenceLogger();
    let now = NOW;
    let quiet = false;
    const checkHarness = buildCheckHarness();
    checkHarness.deps.now = () => now;
    checkHarness.deps.isWorkerQuiet = () => quiet;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    expect(checkHarness.fetches).toHaveLength(2);

    for (let hour = 1; hour <= 5; hour++) {
      now = NOW + hour * HOUR_MS;
      expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({
        decision: 'deferred-busy',
        promotedVersion: PROMOTED,
        busySince: NOW,
        observedBusyMs: hour * HOUR_MS,
      });
    }
    expect(checkHarness.fetches).toHaveLength(2);
    expect(checkHarness.stored().busyDeferralStartedAt).toBe(NOW);

    quiet = true;
    now = NOW + 6 * HOUR_MS;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'apply', applyReason: 'quiet' });
    expect(checkHarness.fetches).toHaveLength(4);
    expect(checkHarness.launches).toHaveLength(1);
    expect(checkHarness.stored().busyDeferralStartedAt).toBeNull();
  });

  it('ends a deferral once someone else installed its version, and the next tick is not due', async () => {
    silenceLogger();
    let now = NOW;
    let installed = INSTALLED;
    const checkHarness = buildCheckHarness({ quiet: false });
    checkHarness.deps.now = () => now;
    checkHarness.deps.resolvePluginRoot = () => ({ root: path.join(CACHE_ROOT, installed), version: installed, missingDependencies: [] });

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');

    // The user ran `npx claude-mem update` while the worker was busy.
    installed = PROMOTED;
    now = NOW + 2 * HOUR_MS;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({ decision: 'up-to-date', installedVersion: PROMOTED, promotedVersion: PROMOTED });
    now = NOW + 3 * HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.fetches).toHaveLength(2);
    expect(checkHarness.launches).toEqual([]);
  });

  it('counts observed busy time: a laptop asleep over a weekend adds one tick interval, not two days', async () => {
    silenceLogger();
    const fridayEvening = Date.UTC(2026, 10, 6, 18, 0, 0);
    const mondayMorning = Date.UTC(2026, 10, 9, 9, 0, 0);
    let now = fridayEvening;
    const checkHarness = buildCheckHarness({ quiet: false });
    checkHarness.deps.now = () => now;

    // Busy Friday evening: the deferral starts at 18:00, then five busy hours.
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    for (let hour = 1; hour <= 5; hour++) {
      now = fridayEvening + hour * HOUR_MS;
      await runAutoUpdateCheck(checkHarness.deps);
    }
    expect(checkHarness.stored().busyDeferralObservedBusyMs).toBe(5 * HOUR_MS);

    // Asleep until Monday 09:00: 58 h of wall clock, one tick interval of busy time.
    now = mondayMorning;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({
      decision: 'deferred-busy',
      observedBusyMs: 5 * HOUR_MS + AUTO_UPDATE_TICK_INTERVAL_MS,
    });
    expect(checkHarness.launches).toEqual([]);

    // 18 more busy hours make 24 h of observed busy time.
    for (let hour = 1; hour < 18; hour++) {
      now = mondayMorning + hour * HOUR_MS;
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    }
    now = mondayMorning + 18 * HOUR_MS;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'apply', applyReason: 'busy-for-a-full-check-cycle' });
    expect(checkHarness.launches).toHaveLength(1);
    // The network: the first check, then the confirming fetch before the launch.
    expect(checkHarness.fetches).toHaveLength(4);
  });

  it('keeps counting across a worker that restarts every few minutes', async () => {
    silenceLogger();
    // Each run ticks once, AUTO_UPDATE_FIRST_TICK_DELAY_MS after it starts, so
    // a worker that restarts every 6 minutes ticks every 6 minutes.
    const restartIntervalMs = AUTO_UPDATE_FIRST_TICK_DELAY_MS + MINUTE_MS;
    const ticksToFullCycle = AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS / restartIntervalMs;
    let now = NOW;
    const checkHarness = buildCheckHarness({ quiet: false });
    checkHarness.deps.now = () => now;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    for (let run = 1; run < ticksToFullCycle; run++) {
      // A new process: a fresh once-per-boot set; the deferral is read back from the state file.
      checkHarness.deps.oncePerBootLogsWritten = new Set();
      now = NOW + run * restartIntervalMs;
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
      expect(checkHarness.stored().busyDeferralObservedBusyMs).toBe(run * restartIntervalMs);
    }
    expect(checkHarness.stored().busyDeferralStartedAt).toBe(NOW);
    expect(checkHarness.launches).toEqual([]);

    checkHarness.deps.oncePerBootLogsWritten = new Set();
    now = NOW + ticksToFullCycle * restartIntervalMs;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'apply', applyReason: 'busy-for-a-full-check-cycle' });
    expect(now - NOW).toBe(24 * HOUR_MS);
    expect(checkHarness.fetches).toHaveLength(4);
  });

  it('a clock moved back during a deferral adds at most one tick interval, and the deferral keeps counting', async () => {
    silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness({ quiet: false });
    checkHarness.deps.now = () => now;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    for (let hour = 1; hour <= 10; hour++) {
      now = NOW + hour * HOUR_MS;
      await runAutoUpdateCheck(checkHarness.deps);
    }
    expect(checkHarness.stored().busyDeferralObservedBusyMs).toBe(10 * HOUR_MS);

    // The next tick lands 12 h earlier on the clock than the hour after the last one.
    const movedBackNow = NOW + 11 * HOUR_MS - 12 * HOUR_MS;
    now = movedBackNow;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({
      decision: 'deferred-busy',
      observedBusyMs: 10 * HOUR_MS + AUTO_UPDATE_TICK_INTERVAL_MS,
    });
    expect(checkHarness.stored().busyDeferralLastBusyObservationAt).toBe(movedBackNow);

    // Counting goes on from the new clock: 13 more busy hours make 24 h.
    for (let hour = 1; hour < 13; hour++) {
      now = movedBackNow + hour * HOUR_MS;
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    }
    now = movedBackNow + 13 * HOUR_MS;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'apply', applyReason: 'busy-for-a-full-check-cycle' });
  });

  it('drops a deferred update that the owner pulled back before it applied', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness({
      state: {
        busyDeferralStartedAt: NOW - 2 * HOUR_MS,
        busyDeferralObservedBusyMs: HOUR_MS,
        busyDeferralLastBusyObservationAt: NOW - HOUR_MS,
        lastNetworkCheckAt: NOW - 2 * HOUR_MS,
        lastSeenPromotedVersion: PROMOTED,
      },
      responses: { [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: INSTALLED }) },
    });

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('up-to-date');
    expect(checkHarness.launches).toEqual([]);
    expect(checkHarness.stored()).toMatchObject({ busyDeferralStartedAt: null, busyDeferralObservedBusyMs: 0, busyDeferralLastBusyObservationAt: null });
  });

  it('does not launch when the worker began shutting down while the fetches were awaited, reads no busy signal, and writes nothing', async () => {
    const spies = silenceLogger();
    let workerShuttingDown = false;
    let quietReads = 0;
    const checkHarness = buildCheckHarness();
    const scriptedFetch = checkHarness.deps.fetchJson;
    checkHarness.deps.fetchJson = async (url, timeoutMs) => {
      const answer = await scriptedFetch(url, timeoutMs);
      // Shutdown begins while npm is answering, after the tick started.
      if (url === npmVersionMetadataUrl(PROMOTED)) workerShuttingDown = true;
      return answer;
    };
    checkHarness.deps.isWorkerShuttingDown = () => workerShuttingDown;
    // Shutdown takes My Work's routes away, so a busy read now could only fail.
    checkHarness.deps.isWorkerQuiet = () => { quietReads++; return true; };

    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({
      decision: 'worker-shutting-down',
      targetVersion: PROMOTED,
      previousVersion: INSTALLED,
    });
    expect(checkHarness.launches).toEqual([]);
    expect(quietReads).toBe(0);
    // Nothing is written, so the next boot checks again.
    expect(checkHarness.writes).toEqual([]);
    expect(loggedDecisions(spies)).toEqual(['worker-shutting-down']);
  });

  it('logs "disabled", the install-shape decisions and "unknown-schema" once per boot, not every tick', async () => {
    const spies = silenceLogger();
    const countLogged = (name: string): number => loggedDecisions(spies).filter((logged) => logged === name).length;

    const disabled = buildCheckHarness({ settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } });
    await runAutoUpdateCheck(disabled.deps);
    await runAutoUpdateCheck(disabled.deps);
    expect(countLogged('disabled')).toBe(1);

    disabled.deps.oncePerBootLogsWritten = new Set();
    await runAutoUpdateCheck(disabled.deps);
    expect(countLogged('disabled')).toBe(2);

    const installShapes: Array<[AutoUpdateDecisionName, PluginRootResolution | null]> = [
      ['no-install', null],
      ['not-a-standard-install', { root: path.resolve('claude-mem-checkout', 'plugin'), version: '15.13.0', missingDependencies: [] }],
      ['unknown-installed-version', { root: path.join(CACHE_ROOT, 'dev'), version: 'dev', missingDependencies: [] }],
    ];
    for (const [decisionName, install] of installShapes) {
      const checkHarness = buildCheckHarness({ install });
      for (let hour = 0; hour < 3; hour++) expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe(decisionName);
      expect(countLogged(decisionName)).toBe(1);
    }

    // The unknown schema is logged once per boot but recorded on every check.
    let now = NOW;
    const futureFormat = buildCheckHarness({ responses: { [PROMOTED_URL]: json({ schemaVersion: 2 }) } });
    futureFormat.deps.now = () => now;
    await runAutoUpdateCheck(futureFormat.deps);
    now += AUTO_UPDATE_CHECK_INTERVAL_MS;
    await runAutoUpdateCheck(futureFormat.deps);
    expect(futureFormat.fetches).toHaveLength(2);
    expect(countLogged('unknown-schema')).toBe(1);
    expect(futureFormat.stored().lastCheckError).toEqual({ at: now, message: expect.stringContaining('its schemaVersion is 2') });
  });

  it('warns about an unrecognised CLAUDE_MEM_AUTO_UPDATE once per boot and stays off', async () => {
    const spies = silenceLogger();
    const checkHarness = buildCheckHarness({ settings: { CLAUDE_MEM_AUTO_UPDATE: 'off' } });
    const unrecognisedWarnings = () => spies.warn.mock.calls.filter((call) => String(call[1]).includes('CLAUDE_MEM_AUTO_UPDATE is neither'));

    for (let hour = 0; hour < 3; hour++) expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('disabled');
    expect(unrecognisedWarnings()).toHaveLength(1);
    expect(unrecognisedWarnings()[0][2]).toEqual({ value: 'off' });
    expect(checkHarness.fetches).toEqual([]);
  });

  it('treats a busy signal that throws as busy and logs why; when that persists, the busy fallback still applies after a full check cycle', async () => {
    const spies = silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness();
    checkHarness.deps.now = () => now;
    checkHarness.deps.isWorkerQuiet = () => { throw new Error('Database not initialized'); };
    const busyWarnings = () => spies.warn.mock.calls.filter((call) => String(call[1]).includes('treating it as busy'));

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    expect(checkHarness.launches).toEqual([]);
    expect(busyWarnings()).toHaveLength(1);
    expect(busyWarnings()[0][2]).toEqual({ cause: 'Database not initialized' });

    for (let hour = 1; hour < 24; hour++) {
      now = NOW + hour * HOUR_MS;
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    }
    now = NOW + 24 * HOUR_MS;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'apply', applyReason: 'busy-for-a-full-check-cycle' });
    expect(checkHarness.launches).toHaveLength(1);
  });

  it('records a launch that throws as failed at launch-supervisor, clears the attempt, logs it at ERROR, and tries the version again at the next due check', async () => {
    const spies = silenceLogger();
    let now = NOW;
    let launchAttempts = 0;
    const checkHarness = buildCheckHarness();
    checkHarness.deps.now = () => now;
    checkHarness.deps.launchSupervisor = async (attempt) => {
      launchAttempts++;
      // A launcher that records its attempt before the spawn fails leaves it behind.
      checkHarness.deps.writeState({
        ...checkHarness.stored(),
        inFlightAttempt: { ...attempt, startedAt: NOW, supervisorPid: null },
      });
      throw new Error('spawn EAGAIN');
    };

    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({
      decision: 'launch-failed',
      targetVersion: PROMOTED,
      previousVersion: INSTALLED,
      message: 'The supervisor could not be launched: spawn EAGAIN',
    });
    const state = checkHarness.stored();
    expect(state.inFlightAttempt).toBeNull();
    expect(state.lastAttemptOutcome).toEqual({
      result: 'failed',
      targetVersion: PROMOTED,
      previousVersion: INSTALLED,
      finishedAt: NOW,
      failureStage: 'launch-supervisor',
      message: 'The supervisor could not be launched: spawn EAGAIN',
    });
    // It never ran, so the version is not blocked.
    expect(state.versionsThatFailedToApply).toEqual([]);
    expect(spies.error.mock.calls.map((call) => call[1])).toEqual(['Auto-update decision: launch-failed']);
    expect(spies.error.mock.calls[0][2]).toMatchObject({ targetVersion: PROMOTED, previousVersion: INSTALLED, message: expect.stringContaining('spawn EAGAIN') });

    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    checkHarness.deps.launchSupervisor = async (attempt) => { launchAttempts++; checkHarness.launches.push(attempt); };
    now = NOW + AUTO_UPDATE_CHECK_INTERVAL_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(launchAttempts).toBe(2);
  });

  it('keeps the state fields this version does not know when it saves', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness({ state: { claudeCodeBackgroundUpdateTurnedOffAt: NOW - HOUR_MS } });

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(checkHarness.stored().claudeCodeBackgroundUpdateTurnedOffAt).toBe(NOW - HOUR_MS);
  });

  it('names the stage when a tick cannot finish', async () => {
    silenceLogger();
    const breakages: Array<[string, (checkHarness: CheckHarness) => void]> = [
      ['read-settings', (checkHarness) => { checkHarness.deps.readSettings = () => { throw new Error('settings.json: JSON Parse error'); }; }],
      ['read-claude-code-settings', (checkHarness) => { checkHarness.deps.readClaudeCodeSettingsEnv = () => { throw new Error('managed-settings.json is not valid JSON'); }; }],
      ['resolve-plugin-root', (checkHarness) => { checkHarness.deps.resolvePluginRoot = () => { throw new Error('EACCES'); }; }],
      ['read-state', (checkHarness) => { checkHarness.deps.readState = () => { throw new Error('EISDIR'); }; }],
      ['write-state', (checkHarness) => { checkHarness.deps.writeState = () => { throw new Error('ENOSPC'); }; }],
    ];
    for (const [stage, breakTheStage] of breakages) {
      const checkHarness = buildCheckHarness();
      breakTheStage(checkHarness);
      await expect(runAutoUpdateCheck(checkHarness.deps)).rejects.toMatchObject({ name: 'AutoUpdateCheckError', stage });
      expect(checkHarness.launches).toEqual([]);
    }
  });

  it('does nothing else when the settings cannot be read', async () => {
    const spies = silenceLogger();
    const checkHarness = buildCheckHarness();
    checkHarness.deps.readSettings = () => { throw new Error('settings.json exists but cannot be read as settings'); };

    await expect(runAutoUpdateCheck(checkHarness.deps)).rejects.toMatchObject({ stage: 'read-settings' });
    expectNothingTouchedAfterSettings(checkHarness);
    expect(checkHarness.launches).toEqual([]);
    expect(loggedDecisions(spies)).toEqual([]);
  });

  it('does nothing else when a managed settings file Claude Code refuses to start with stops the read', async () => {
    const spies = silenceLogger();
    const checkHarness = buildCheckHarness();
    checkHarness.deps.readClaudeCodeSettingsEnv = () => { throw new Error('/etc/claude-code/managed-settings.json is not valid JSON'); };

    await expect(runAutoUpdateCheck(checkHarness.deps)).rejects.toMatchObject({ stage: 'read-claude-code-settings' });
    expect(checkHarness.pluginRootLookups()).toBe(0);
    expect(checkHarness.stateReads()).toBe(0);
    expect(checkHarness.fetches).toEqual([]);
    expect(loggedDecisions(spies)).toEqual([]);
  });

  it('reads Claude Code\'s settings files on every tick, so a switch added later turns it off on the next one', async () => {
    silenceLogger();
    let now = NOW;
    const settingsFiles: ClaudeCodeSettingsEnvBlock[] = [userSettingsEnv({})];
    const checkHarness = buildCheckHarness({ quiet: false });
    checkHarness.deps.now = () => now;
    checkHarness.deps.readClaudeCodeSettingsEnv = () => ({ envBlocks: structuredClone(settingsFiles), skipped: [] });

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    settingsFiles[0].env.DISABLE_UPDATES = 1;
    now = NOW + HOUR_MS;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'disabled', reason: expect.stringContaining('DISABLE_UPDATES is set in the env block of') });
  });
});

describe('logFailedAutoUpdateTick', () => {
  const failedTickMessage = 'Auto-update check failed; the next tick tries again';
  const failedAt = (stage: ConstructorParameters<typeof AutoUpdateCheckError>[0]) => new AutoUpdateCheckError(stage, new Error(`broken at ${stage}`));

  it('logs a tick a broken settings file stops at ERROR once per boot, and each later one at DEBUG', () => {
    for (const stage of ['read-settings', 'read-claude-code-settings'] as const) {
      const spies = silenceLogger();
      const oncePerBootLogsWritten = new Set<AutoUpdateOncePerBootLogKey>();
      for (let hour = 0; hour < 3; hour++) logFailedAutoUpdateTick(failedAt(stage), oncePerBootLogsWritten);

      expect(spies.error.mock.calls.map((call) => [call[1], call[2]])).toEqual([[failedTickMessage, { stage }]]);
      // The ERROR carries the Error, which the error sink sends as an exception event; the repeats do not reach it.
      expect(String(spies.error.mock.calls[0][3])).toContain(`broken at ${stage}`);
      expect(spies.debug.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        [failedTickMessage, { stage, loggedAtErrorEarlierThisBoot: true }],
        [failedTickMessage, { stage, loggedAtErrorEarlierThisBoot: true }],
      ]);

      // A new boot starts a new set: its first failure is an ERROR again.
      logFailedAutoUpdateTick(failedAt(stage), new Set());
      expect(spies.error).toHaveBeenCalledTimes(2);
      mock.restore();
    }
  });

  it('logs every other failing tick at ERROR, each time', () => {
    const spies = silenceLogger();
    const oncePerBootLogsWritten = new Set<AutoUpdateOncePerBootLogKey>();
    for (let hour = 0; hour < 2; hour++) {
      logFailedAutoUpdateTick(failedAt('write-state'), oncePerBootLogsWritten);
      logFailedAutoUpdateTick(new Error('not an AutoUpdateCheckError'), oncePerBootLogsWritten);
    }
    expect(spies.error.mock.calls.map((call) => call[2])).toEqual([{ stage: 'write-state' }, { stage: 'unexpected' }, { stage: 'write-state' }, { stage: 'unexpected' }]);
    expect(spies.debug).not.toHaveBeenCalled();
  });
});

describe('isWorkerQuietBySignals', () => {
  const idleSignals: WorkerQuietSignals = {
    hasSessionActivitySince: () => false,
    getNewestCapturedActivityAt: () => null,
    getQueueDepth: () => 0,
    getInFlightRequestCount: () => 0,
    getViewerClientCount: () => 0,
    getRunningBackgroundJobs: () => [],
  };

  it('asks for session activity in the last 18 minutes, then queued work and open requests', () => {
    const cutoffs: number[] = [];
    expect(isWorkerQuietBySignals({ ...idleSignals, hasSessionActivitySince: (cutoffMs) => { cutoffs.push(cutoffMs); return false; } }, NOW)).toBe(true);
    expect(cutoffs).toEqual([NOW - AUTO_UPDATE_QUIET_WINDOW_MS]);
    expect(AUTO_UPDATE_QUIET_WINDOW_MS).toBe(18 * MINUTE_MS);

    expect(isWorkerQuietBySignals({ ...idleSignals, hasSessionActivitySince: () => true }, NOW)).toBe(false);
    expect(isWorkerQuietBySignals({ ...idleSignals, getQueueDepth: () => 1 }, NOW)).toBe(false);
    expect(isWorkerQuietBySignals({ ...idleSignals, getInFlightRequestCount: () => 1 }, NOW)).toBe(false);
  });

  it('needs the newest user prompt or captured tool use to be at least the quiet window old', () => {
    const newestAt = (epochMs: number | null) => ({ ...idleSignals, getNewestCapturedActivityAt: () => epochMs });
    // The worker restarted, its session map is empty, and a prompt came 6 minutes ago.
    expect(isWorkerQuietBySignals(newestAt(NOW - 6 * MINUTE_MS), NOW)).toBe(false);
    expect(isWorkerQuietBySignals(newestAt(NOW - AUTO_UPDATE_QUIET_WINDOW_MS + 1), NOW)).toBe(false);
    expect(isWorkerQuietBySignals(newestAt(NOW - AUTO_UPDATE_QUIET_WINDOW_MS), NOW)).toBe(true);
    expect(isWorkerQuietBySignals(newestAt(NOW - 3 * HOUR_MS), NOW)).toBe(true);
    // None at all: a new install.
    expect(isWorkerQuietBySignals(newestAt(null), NOW)).toBe(true);
    // Dated ahead of the clock (it was moved back): not yet that old.
    expect(isWorkerQuietBySignals(newestAt(NOW + MINUTE_MS), NOW)).toBe(false);
  });

  it('counts any of the worker\'s own background jobs running as busy', () => {
    expect(isWorkerQuietBySignals({ ...idleSignals, getRunningBackgroundJobs: () => ['my-work-refresh'] }, NOW)).toBe(false);
  });

  it('lets a signal that cannot be read throw, for the check to count as busy', () => {
    expect(() => isWorkerQuietBySignals({ ...idleSignals, getNewestCapturedActivityAt: () => { throw new Error('Database not initialized'); } }, NOW))
      .toThrow('Database not initialized');
    expect(() => isWorkerQuietBySignals({ ...idleSignals, getRunningBackgroundJobs: () => { throw new Error('My Work is not mounted'); } }, NOW))
      .toThrow('My Work is not mounted');
  });

  it('leaves the viewer and My Work event streams out: an open tab is not work', () => {
    // Two tabs open, each holding its event stream: two open requests.
    expect(isWorkerQuietBySignals({ ...idleSignals, getInFlightRequestCount: () => 2, getViewerClientCount: () => 2 }, NOW)).toBe(true);
    // Any other open request still counts.
    expect(isWorkerQuietBySignals({ ...idleSignals, getInFlightRequestCount: () => 3, getViewerClientCount: () => 2 }, NOW)).toBe(false);
  });

  it('never counts below zero when a stream has left one count before the other', () => {
    expect(isWorkerQuietBySignals({ ...idleSignals, getInFlightRequestCount: () => 0, getViewerClientCount: () => 2 }, NOW)).toBe(true);
    expect(isWorkerQuietBySignals({ ...idleSignals, getInFlightRequestCount: () => 0, getViewerClientCount: () => 2, getQueueDepth: () => 1 }, NOW)).toBe(false);
  });
});

describe('autoUpdateDisabledReason', () => {
  it('reads DISABLE_AUTOUPDATER and DISABLE_UPDATES the way claude-mem reads Claude Code\'s other env flags', () => {
    for (const name of ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES']) {
      for (const value of ['1', 'true', 'yes', ' TRUE ']) {
        expect(claudeCodeSwitchInForce({ [name]: value }, [])).toContain(name);
      }
      for (const value of ['', '0', 'false', ' False ']) {
        expect(claudeCodeSwitchInForce({ [name]: value }, [])).toBeNull();
      }
    }
  });

  it('leaves DISABLE_AUTOUPDATER to be read with Claude Code\'s settings files, where FORCE_AUTOUPDATE_PLUGINS can override it', () => {
    expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, { DISABLE_AUTOUPDATER: '1' })).toBeNull();
    // The switches the force leaves in force are final here, with nothing else read.
    expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, { DISABLE_UPDATES: '1', FORCE_AUTOUPDATE_PLUGINS: '1' })).toContain('DISABLE_UPDATES is set');
    expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set');
  });

  it('reads CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC as on for any non-empty value, 0 and false included', () => {
    for (const value of ['1', '0', 'false', 'FALSE', 'no', ' ']) {
      expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: value }))
        .toBe('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set (Claude Code\'s switch for no background updates)');
    }
    // Only unset or empty leaves it off.
    expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' })).toBeNull();
    expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, {})).toBeNull();
  });

  it('each Claude Code switch survives the worker spawn\'s sanitizeEnv and turns auto-update off', () => {
    for (const name of ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
      const workerEnv = sanitizeEnv({ [name]: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/usr/bin' });
      expect(workerEnv[name]).toBe('1');
      expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, workerEnv) ?? claudeCodeSwitchInForce(workerEnv, []))
        .toBe(`${name} is set (Claude Code's switch for no background updates)`);
    }
  });

  it('FORCE_AUTOUPDATE_PLUGINS survives the worker spawn\'s sanitizeEnv too, so the worker sees the force', () => {
    const workerEnv = sanitizeEnv({ DISABLE_AUTOUPDATER: '1', FORCE_AUTOUPDATE_PLUGINS: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/usr/bin' });
    expect(workerEnv.FORCE_AUTOUPDATE_PLUGINS).toBe('1');
    expect(autoUpdateDisabledReason(SHIPPED_SETTINGS, workerEnv)).toBeNull();
    expect(claudeCodeSwitchInForce(workerEnv, [])).toBeNull();
  });

  it('is on only for "true" (trimmed, any case); "false" and every other value are off', () => {
    const withAutoUpdate = (value: unknown): AutoUpdateSettings => ({ ...SHIPPED_SETTINGS, CLAUDE_MEM_AUTO_UPDATE: value as string });
    for (const value of ['true', ' TRUE ', 'True']) {
      expect(parseAutoUpdateSwitch(value)).toBe('on');
      expect(autoUpdateDisabledReason(withAutoUpdate(value), {})).toBeNull();
    }
    for (const value of ['false', ' FALSE ']) {
      expect(parseAutoUpdateSwitch(value)).toBe('off');
      expect(autoUpdateDisabledReason(withAutoUpdate(value), {})).toBe('CLAUDE_MEM_AUTO_UPDATE=false');
    }
    // Values meant as off, values meant as on, and JSON a hand edit can leave behind.
    for (const value of ['0', 'off', 'no', '', 'yes', '1', 0, 1, null]) {
      expect(parseAutoUpdateSwitch(value)).toBe('unrecognised');
      expect(autoUpdateDisabledReason(withAutoUpdate(value), {})).toContain('(only "true" turns it on)');
    }
  });
});

describe('claudeCodeSwitchInForce', () => {
  it('reads a settings-file value as the text an environment variable would hold', () => {
    const reasonFor = (env: Record<string, unknown>) => claudeCodeSwitchInForce({}, [userSettingsEnv(env)]);
    // JSON numbers and booleans, as a hand edit writes them.
    expect(reasonFor({ DISABLE_AUTOUPDATER: 1 })).toContain('DISABLE_AUTOUPDATER is set');
    expect(reasonFor({ DISABLE_UPDATES: true })).toContain('DISABLE_UPDATES is set');
    expect(reasonFor({ DISABLE_AUTOUPDATER: 0 })).toBeNull();
    expect(reasonFor({ DISABLE_AUTOUPDATER: false })).toBeNull();
    expect(reasonFor({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 0 })).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set');
    // null sets nothing; a value that is not text is never read as off.
    expect(reasonFor({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null })).toBeNull();
    expect(reasonFor({ DISABLE_AUTOUPDATER: { value: '1' } })).toContain('DISABLE_AUTOUPDATER is set');
    expect(claudeCodeSwitchInForce({}, [])).toBeNull();
  });

  it('names the first place that sets a switch: the worker\'s env, then each file in order', () => {
    expect(claudeCodeSwitchInForce({}, [userSettingsEnv({ DISABLE_UPDATES: '' }), managedSettingsEnv({ DISABLE_UPDATES: '1' })]))
      .toBe('DISABLE_UPDATES is set in the env block of /Library/Application Support/ClaudeCode/managed-settings.json (Claude Code\'s switch for no background updates)');
    expect(claudeCodeSwitchInForce({ DISABLE_AUTOUPDATER: '1' }, [managedSettingsEnv({ DISABLE_UPDATES: '1' })]))
      .toBe('DISABLE_AUTOUPDATER is set (Claude Code\'s switch for no background updates)');
  });

  it('takes DISABLE_AUTOUPDATER, and only it, out of force while FORCE_AUTOUPDATE_PLUGINS is 1 wherever it is set', () => {
    const disabledByTheAutoUpdater = [userSettingsEnv({ DISABLE_AUTOUPDATER: '1' }), managedSettingsEnv({ DISABLE_AUTOUPDATER: 'true' })];
    // 1 in the env, or in a settings file (a JSON 1 included), trimmed.
    for (const env of [{ FORCE_AUTOUPDATE_PLUGINS: '1' }, { FORCE_AUTOUPDATE_PLUGINS: ' 1 ' }]) {
      expect(claudeCodeSwitchInForce({ ...env, DISABLE_AUTOUPDATER: '1' }, disabledByTheAutoUpdater)).toBeNull();
    }
    expect(claudeCodeSwitchInForce({ DISABLE_AUTOUPDATER: '1' }, [...disabledByTheAutoUpdater, managedSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: 1 })])).toBeNull();
    // DISABLE_UPDATES and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC stay in force.
    expect(claudeCodeSwitchInForce({ FORCE_AUTOUPDATE_PLUGINS: '1' }, [userSettingsEnv({ DISABLE_UPDATES: '1' })])).toContain('DISABLE_UPDATES is set');
    expect(claudeCodeSwitchInForce({ FORCE_AUTOUPDATE_PLUGINS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' }, []))
      .toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set');
    // Only 1 forces; any other value anywhere, an empty one included, leaves DISABLE_AUTOUPDATER in force.
    for (const value of ['true', 'yes', '0', '', 'false', '2']) {
      expect(claudeCodeSwitchInForce({ FORCE_AUTOUPDATE_PLUGINS: value, DISABLE_AUTOUPDATER: '1' }, [])).toContain('DISABLE_AUTOUPDATER is set');
      expect(claudeCodeSwitchInForce({ FORCE_AUTOUPDATE_PLUGINS: '1' }, [userSettingsEnv({ DISABLE_AUTOUPDATER: '1' }), managedSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: value })]))
        .toContain('DISABLE_AUTOUPDATER is set');
    }
    // A null value sets nothing, so it does not stand in the way.
    expect(claudeCodeSwitchInForce({ FORCE_AUTOUPDATE_PLUGINS: '1', DISABLE_AUTOUPDATER: '1' }, [userSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: null })])).toBeNull();
  });
});

describe('Claude Code settings files', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-claude-settings-'));
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  /** A Claude config dir and a managed settings dir of its own, with the files given. */
  const fixture = (name: string, files: Record<string, string>) => {
    const root = path.join(tempDir, name);
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(root, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, contents);
    }
    return {
      userSettingsPath: path.join(root, 'claude-config', 'settings.json'),
      managedSettingsDirectory: path.join(root, 'managed'),
      at: (relativePath: string) => path.join(root, relativePath),
    };
  };

  it('uses the platform paths from Claude Code\'s managed settings docs', () => {
    expect(claudeCodeManagedSettingsDirectory('darwin')).toBe('/Library/Application Support/ClaudeCode');
    expect(claudeCodeManagedSettingsDirectory('linux')).toBe('/etc/claude-code');
    expect(claudeCodeManagedSettingsDirectory('win32')).toBe('C:\\Program Files\\ClaudeCode');
  });

  it('reads the user settings env, then managed-settings.json, then every *.json drop-in in alphabetical order', () => {
    const files = fixture('all-sources', {
      'claude-config/settings.json': JSON.stringify({ theme: 'dark', env: { DISABLE_AUTOUPDATER: '1' } }),
      'managed/managed-settings.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }),
      'managed/managed-settings.d/20-updates.json': JSON.stringify({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' } }),
      'managed/managed-settings.d/10-telemetry.json': JSON.stringify({ env: { DISABLE_TELEMETRY: '1' } }),
      // Ignored, as Claude Code ignores them: a hidden file and one that does not end in .json.
      'managed/managed-settings.d/.20-hidden.json': '{ not json',
      'managed/managed-settings.d/notes.txt': '{ not json',
    });
    expect(readClaudeCodeSettingsEnvBlocks(files)).toEqual({
      envBlocks: [
        { path: files.userSettingsPath, env: { DISABLE_AUTOUPDATER: '1' } },
        { path: files.at('managed/managed-settings.json'), env: { DISABLE_UPDATES: '1' } },
        { path: files.at('managed/managed-settings.d/10-telemetry.json'), env: { DISABLE_TELEMETRY: '1' } },
        { path: files.at('managed/managed-settings.d/20-updates.json'), env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' } },
      ],
      skipped: [],
    });
  });

  it('leaves out files and a drop-in directory that do not exist', () => {
    expect(readClaudeCodeSettingsEnvBlocks(fixture('nothing', {}))).toEqual({ envBlocks: [], skipped: [] });
  });

  it('reads an empty file, a file with no env and a null env as setting nothing', () => {
    const files = fixture('empty', {
      'claude-config/settings.json': '',
      'managed/managed-settings.json': JSON.stringify({ permissions: { deny: [] } }),
      'managed/managed-settings.d/10-null.json': JSON.stringify({ env: null }),
    });
    expect(readClaudeCodeSettingsEnvBlocks(files).envBlocks.map((block) => block.env)).toEqual([{}, {}, {}]);
  });

  it('reads a file with a UTF-8 byte order mark', () => {
    const files = fixture('bom', { 'claude-config/settings.json': `\uFEFF${JSON.stringify({ env: { DISABLE_UPDATES: '1' } })}` });
    expect(readClaudeCodeSettingsEnvBlocks(files).envBlocks).toEqual([{ path: files.userSettingsPath, env: { DISABLE_UPDATES: '1' } }]);
  });

  /** Each way a settings file can exist and still not be usable, with the words its problem is reported in. */
  const unusableContents: Array<[string, string, string]> = [
    ['not-json', '{"env": {"DISABLE_AUTOUPDATER": "1"},}', 'is not valid JSON'],
    ['array', '[]', 'does not hold a JSON object'],
    ['env-text', JSON.stringify({ env: 'DISABLE_AUTOUPDATER=1' }), 'its env is string, not an object'],
    ['env-array', JSON.stringify({ env: ['DISABLE_AUTOUPDATER'] }), 'its env is an array, not an object'],
  ];

  /**
   * A path the operating system will not let this user read, made readable
   * again before the scratch dir is removed. Tests using it skip on Windows and
   * as root, where a mode of 000 does not deny the read, as
   * tests/memory/memory-ingest.test.ts does for its unreadable file.
   */
  const withReadDenied = <T>(filePath: string, run: () => T): T => {
    chmodSync(filePath, 0o000);
    try {
      return run();
    } finally {
      chmodSync(filePath, 0o755);
    }
  };
  const readDenialCannotBeMade = process.platform === 'win32' || process.getuid?.() === 0;
  const managedSwitchFile = { 'managed/managed-settings.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }) };

  it('skips the user\'s own settings file whatever is wrong with it, naming it, and still reads the managed settings', () => {
    for (const [name, contents, problem] of unusableContents) {
      const files = fixture(`user-${name}`, { 'claude-config/settings.json': contents, ...managedSwitchFile });
      expect(readClaudeCodeSettingsEnvBlocks(files)).toEqual({
        envBlocks: [{ path: files.at('managed/managed-settings.json'), env: { DISABLE_UPDATES: '1' } }],
        skipped: [{ path: files.userSettingsPath, problem: expect.stringContaining(`${files.userSettingsPath}`) }],
      });
      expect(readClaudeCodeSettingsEnvBlocks(files).skipped[0].problem).toContain(problem);
    }
    // One it cannot read at all: a directory where the file should be.
    const settingsIsADirectory = fixture('user-directory', { 'claude-config/settings.json/inside': '{}', ...managedSwitchFile });
    expect(readClaudeCodeSettingsEnvBlocks(settingsIsADirectory).skipped)
      .toEqual([{ path: settingsIsADirectory.userSettingsPath, problem: expect.stringContaining('exists but cannot be read') }]);
  });

  it.skipIf(readDenialCannotBeMade)('skips the user\'s own settings file when the operating system denies the read', () => {
    const readDenied = fixture('user-read-denied', { 'claude-config/settings.json': JSON.stringify({ env: { DISABLE_AUTOUPDATER: '1' } }), ...managedSwitchFile });
    withReadDenied(readDenied.userSettingsPath, () => {
      expect(readClaudeCodeSettingsEnvBlocks(readDenied)).toEqual({
        envBlocks: [{ path: readDenied.at('managed/managed-settings.json'), env: { DISABLE_UPDATES: '1' } }],
        skipped: [{ path: readDenied.userSettingsPath, problem: expect.stringContaining('EACCES') }],
      });
    });
  });

  it('throws, naming the file, for a managed settings file Claude Code refuses to start with: one that is not a JSON object', () => {
    for (const [name, contents, problem] of unusableContents.filter(([unusableName]) => unusableName === 'not-json' || unusableName === 'array')) {
      for (const where of ['managed/managed-settings.json', 'managed/managed-settings.d/50-team.json']) {
        const files = fixture(`managed-${name}-${where.replaceAll('/', '-')}`, { [where]: contents });
        expect(() => readClaudeCodeSettingsEnvBlocks(files)).toThrow(`${files.at(where)}`);
        expect(() => readClaudeCodeSettingsEnvBlocks(files)).toThrow(problem);
      }
    }
  });

  it('throws for a managed settings path that fails to read for a reason other than permissions, which Claude Code exits on', () => {
    const managedIsADirectory = fixture('managed-directory', { 'managed/managed-settings.json/inside': '{}' });
    expect(() => readClaudeCodeSettingsEnvBlocks(managedIsADirectory)).toThrow(`${managedIsADirectory.at('managed/managed-settings.json')} exists but cannot be read`);
    const dropInsIsAFile = fixture('drop-ins-file', { 'managed/managed-settings.d': '{}' });
    expect(() => readClaudeCodeSettingsEnvBlocks(dropInsIsAFile)).toThrow(`${dropInsIsAFile.at('managed/managed-settings.d')} exists but cannot be listed`);
  });

  it('skips a managed env that is not an object, a value Claude Code drops, and reads the next drop-in', () => {
    for (const [name, contents, problem] of unusableContents.filter(([unusableName]) => unusableName.startsWith('env-'))) {
      const files = fixture(`managed-${name}`, { 'managed/managed-settings.d/50-team.json': contents, 'managed/managed-settings.d/60-updates.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }) });
      expect(readClaudeCodeSettingsEnvBlocks(files)).toEqual({
        envBlocks: [{ path: files.at('managed/managed-settings.d/60-updates.json'), env: { DISABLE_UPDATES: '1' } }],
        skipped: [{ path: files.at('managed/managed-settings.d/50-team.json'), problem: expect.stringContaining(problem) }],
      });
    }
  });

  it.skipIf(readDenialCannotBeMade)('skips a managed settings file or drop-in directory the operating system denies, which Claude Code starts without', () => {
    const deniedFile = fixture('managed-read-denied', { 'managed/managed-settings.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }) });
    withReadDenied(deniedFile.at('managed/managed-settings.json'), () => {
      expect(readClaudeCodeSettingsEnvBlocks(deniedFile)).toEqual({
        envBlocks: [],
        skipped: [{ path: deniedFile.at('managed/managed-settings.json'), problem: expect.stringContaining('EACCES') }],
      });
    });
    const deniedDropIns = fixture('managed-drop-ins-denied', { 'managed/managed-settings.d/10-updates.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }) });
    withReadDenied(deniedDropIns.at('managed/managed-settings.d'), () => {
      expect(readClaudeCodeSettingsEnvBlocks(deniedDropIns)).toEqual({
        envBlocks: [],
        skipped: [{ path: deniedDropIns.at('managed/managed-settings.d'), problem: expect.stringContaining('exists but cannot be listed') }],
      });
    });
  });

  it('skips a broken user settings file on every tick, warns once per boot naming it, and lets no switch in it turn auto-update off', async () => {
    const spies = silenceLogger();
    // A trailing comma: Claude Code reports a settings error and runs without the file, its DISABLE_AUTOUPDATER included.
    const files = fixture('tick-broken-user', { 'claude-config/settings.json': '{"env": {"DISABLE_AUTOUPDATER": "1"},}' });
    const skippedWarnings = () => spies.warn.mock.calls.filter((call) => String(call[1]).startsWith('Skipped the Claude Code settings at'));
    let now = NOW;
    const checkHarness = buildCheckHarness();
    checkHarness.deps.now = () => now;
    checkHarness.deps.readClaudeCodeSettingsEnv = () => readClaudeCodeSettingsEnvBlocks(files);

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(skippedWarnings()).toHaveLength(1);
    expect(skippedWarnings()[0][1]).toContain(files.userSettingsPath);
    expect(skippedWarnings()[0][2]).toEqual({ path: files.userSettingsPath, problem: expect.stringContaining('is not valid JSON') });
    expect(spies.error).not.toHaveBeenCalled();

    // A new boot warns again.
    checkHarness.deps.oncePerBootLogsWritten = new Set();
    await runAutoUpdateCheck(checkHarness.deps);
    expect(skippedWarnings()).toHaveLength(2);

    // A switch in the managed settings is still read past the broken user file.
    const managedSwitch = fixture('tick-broken-user-managed-switch', {
      'claude-config/settings.json': '{"env": {"DISABLE_AUTOUPDATER": "1"},}',
      'managed/managed-settings.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }),
    });
    const managedHarness = buildCheckHarness();
    managedHarness.deps.readClaudeCodeSettingsEnv = () => readClaudeCodeSettingsEnvBlocks(managedSwitch);
    expect(await runAutoUpdateCheck(managedHarness.deps)).toMatchObject({
      decision: 'disabled',
      reason: expect.stringContaining(`DISABLE_UPDATES is set in the env block of ${managedSwitch.at('managed/managed-settings.json')}`),
    });
  });

  it('turns a tick off for a switch set only in a settings file, whatever the worker\'s env holds', async () => {
    silenceLogger();
    const userFile = fixture('tick-user', { 'claude-config/settings.json': JSON.stringify({ env: { DISABLE_AUTOUPDATER: '1' } }) });
    const managedDropIn = fixture('tick-managed', { 'managed/managed-settings.d/10-updates.json': JSON.stringify({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'false' } }) });
    for (const files of [userFile, managedDropIn]) {
      const checkHarness = buildCheckHarness({ env: { PATH: '/usr/bin' } });
      checkHarness.deps.readClaudeCodeSettingsEnv = () => readClaudeCodeSettingsEnvBlocks(files);
      expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'disabled', reason: expect.stringContaining('in the env block of') });
      expect(checkHarness.fetches).toEqual([]);
    }
    const noSwitch = buildCheckHarness();
    noSwitch.deps.readClaudeCodeSettingsEnv = () => readClaudeCodeSettingsEnvBlocks(fixture('tick-none', { 'claude-config/settings.json': JSON.stringify({ env: { DISABLE_AUTOUPDATER: '0' } }) }));
    expect((await runAutoUpdateCheck(noSwitch.deps)).decision).toBe('apply');
  });
});

describe('resolvePromotedReleaseUrl', () => {
  it('reads empty or blank as the built-in release switch on main', () => {
    expect(DEFAULT_PROMOTED_RELEASE_URL).toBe(PROMOTED_URL);
    expect(resolvePromotedReleaseUrl('')).toBe(DEFAULT_PROMOTED_RELEASE_URL);
    expect(resolvePromotedReleaseUrl('  \t ')).toBe(DEFAULT_PROMOTED_RELEASE_URL);
  });

  it('uses an override, trimmed', () => {
    expect(resolvePromotedReleaseUrl('  http://127.0.0.1:8123/promoted-release.json ')).toBe('http://127.0.0.1:8123/promoted-release.json');
  });

  it('is what the check fetches', async () => {
    silenceLogger();
    for (const configuredUrl of ['', '   ']) {
      const checkHarness = buildCheckHarness({ settings: { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: configuredUrl } });
      await runAutoUpdateCheck(checkHarness.deps);
      expect(checkHarness.fetches[0].url).toBe(DEFAULT_PROMOTED_RELEASE_URL);
    }
    const overrideUrl = 'file:///sandbox/promoted-release.json';
    const overridden = buildCheckHarness({
      settings: { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: overrideUrl },
      responses: { [overrideUrl]: json({ schemaVersion: 1, promotedVersion: INSTALLED }) },
    });
    expect((await runAutoUpdateCheck(overridden.deps)).decision).toBe('up-to-date');
    expect(overridden.fetches.map((recordedFetch) => recordedFetch.url)).toEqual([overrideUrl]);
  });
});

describe('auto-update settings', () => {
  const keys = ['CLAUDE_MEM_AUTO_UPDATE', 'CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL', 'CLAUDE_MEM_WORKER_AUTOSTART', 'CLAUDE_MEM_WORKER_URL'] as const;
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-settings-'));
    for (const key of keys) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  const settingsFile = (name: string, contents: string): string => {
    const settingsPath = path.join(tempDir, name, 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, contents);
    return settingsPath;
  };

  it('ships on, with the release-switch URL left to the code', () => {
    expect(SettingsDefaultsManager.getAllDefaults()).toMatchObject({
      CLAUDE_MEM_AUTO_UPDATE: 'true',
      CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: '',
    });
  });

  it('never pins the release-switch URL into a new settings.json', () => {
    for (const key of keys) delete process.env[key];
    // The settings manager seeds a new settings.json with every default.
    const settingsPath = path.join(tempDir, 'fresh', 'settings.json');
    SettingsDefaultsManager.loadFromFile(settingsPath);
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL).toBe('');
    expect(JSON.stringify(written)).not.toContain(DEFAULT_PROMOTED_RELEASE_URL);
    const settings = readAutoUpdateSettings(settingsPath, {});
    expect(resolvePromotedReleaseUrl(settings.CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL)).toBe(DEFAULT_PROMOTED_RELEASE_URL);
  });

  it('reads a missing settings.json as the defaults, and writes nothing', () => {
    const settingsPath = path.join(tempDir, 'missing', 'settings.json');
    expect(readAutoUpdateSettings(settingsPath, {})).toEqual(SHIPPED_SETTINGS);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('turns off from the environment, the way the Docker images set it', () => {
    for (const key of keys) delete process.env[key];
    process.env.CLAUDE_MEM_AUTO_UPDATE = 'false';
    const settings = readAutoUpdateSettings(path.join(tempDir, 'env', 'settings.json'));
    expect(autoUpdateDisabledReason(settings, {})).toBe('CLAUDE_MEM_AUTO_UPDATE=false');
  });

  it('lets an environment variable win over the file in both directions, as the settings manager does', () => {
    const savedOn = settingsFile('env-over-file-on', JSON.stringify({ CLAUDE_MEM_AUTO_UPDATE: 'true' }));
    expect(readAutoUpdateSettings(savedOn, { CLAUDE_MEM_AUTO_UPDATE: 'false' }).CLAUDE_MEM_AUTO_UPDATE).toBe('false');
    const savedOff = settingsFile('env-over-file-off', JSON.stringify({ CLAUDE_MEM_AUTO_UPDATE: 'false' }));
    expect(readAutoUpdateSettings(savedOff, { CLAUDE_MEM_AUTO_UPDATE: 'true' }).CLAUDE_MEM_AUTO_UPDATE).toBe('true');
  });

  it('turns off from settings.json, also when written as a JSON boolean', () => {
    const settingsPath = settingsFile('boolean', JSON.stringify({ CLAUDE_MEM_AUTO_UPDATE: false }));
    expect(autoUpdateDisabledReason(readAutoUpdateSettings(settingsPath, {}), {})).toBe('CLAUDE_MEM_AUTO_UPDATE=false');
  });

  it('reads the env block of a wrapped settings.json, where the settings manager reads it', () => {
    const settingsPath = settingsFile('wrapped', JSON.stringify({
      // A stale root copy beside a wrapped document is never read.
      CLAUDE_MEM_AUTO_UPDATE: 'true',
      theme: 'dark',
      env: { CLAUDE_MEM_AUTO_UPDATE: 'false', CLAUDE_MEM_WORKER_URL: '' },
    }));
    expect(SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true }).CLAUDE_MEM_AUTO_UPDATE).toBe('false');
    expect(readAutoUpdateSettings(settingsPath, {}).CLAUDE_MEM_AUTO_UPDATE).toBe('false');
  });

  it('reads a JSON number without throwing, as off', () => {
    for (const numberValue of [0, 1]) {
      const settingsPath = settingsFile(`number-${numberValue}`, JSON.stringify({ CLAUDE_MEM_AUTO_UPDATE: numberValue }));
      expect(autoUpdateDisabledReason(readAutoUpdateSettings(settingsPath, {}), {})).toBe(`CLAUDE_MEM_AUTO_UPDATE="${numberValue}" (only "true" turns it on)`);
    }
  });

  it('reads its keys from the document itself, so an unrelated bad value never turns the updater on', async () => {
    silenceLogger();
    spyOn(console, 'warn').mockImplementation(() => {});
    const settingsPath = settingsFile('unrelated-bad-value', '{"CLAUDE_MEM_AUTO_UPDATE":"false","CLAUDE_MEM_DATA_DIR":5}');
    // Read the way a worker started without CLAUDE_MEM_DATA_DIR in its env
    // reads it: tests/preload.ts puts that variable in this process's env, and
    // its value would replace the file's 5. Both reads are synchronous and
    // touch only settingsPath, so the variable is put back before anything else runs.
    const savedDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    delete process.env.CLAUDE_MEM_DATA_DIR;
    let settingsManagerValue: string;
    let settings: AutoUpdateSettings;
    try {
      settingsManagerValue = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_AUTO_UPDATE;
      settings = readAutoUpdateSettings(settingsPath, {});
    } finally {
      process.env.CLAUDE_MEM_DATA_DIR = savedDataDir;
    }
    // The settings manager cannot finish CLAUDE_MEM_DATA_DIR (its .trim() throws on a
    // number), and its catch-all returns every default: auto-update on.
    expect(settingsManagerValue).toBe('true');

    expect(settings.CLAUDE_MEM_AUTO_UPDATE).toBe('false');
    const checkHarness = buildCheckHarness();
    checkHarness.deps.readSettings = () => settings;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({ decision: 'disabled', reason: 'CLAUDE_MEM_AUTO_UPDATE=false' });
    expect(checkHarness.fetches).toEqual([]);
    expect(checkHarness.launches).toEqual([]);
  });

  it('throws, naming the file, when settings.json exists but cannot be read as settings', () => {
    // Each of these reads as all defaults through loadFromFile, which would turn the updater back on.
    for (const [name, contents] of [['not-json', '{"CLAUDE_MEM_AUTO_UPDATE": "false"'], ['trailing-comma', '{"CLAUDE_MEM_AUTO_UPDATE": "false",}'], ['array', '[]'], ['null', 'null']]) {
      const settingsPath = settingsFile(`unreadable-${name}`, contents);
      expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_AUTO_UPDATE).toBe('true');
      expect(() => readAutoUpdateSettings(settingsPath, {})).toThrow(`${settingsPath} exists but cannot be read as settings`);
    }
    // A path that cannot be read at all: a directory where the file should be.
    const settingsIsADirectory = path.join(tempDir, 'unreadable-directory', 'settings.json');
    mkdirSync(settingsIsADirectory, { recursive: true });
    expect(() => readAutoUpdateSettings(settingsIsADirectory, {})).toThrow(`${settingsIsADirectory} exists but cannot be read as settings`);
  });

  it('reads an empty settings.json as an empty document, the way the Claude Code reader reads an empty file', () => {
    // Empty, whitespace only, and a byte order mark alone: no saved value to lose, so the defaults, with the env over them.
    for (const [name, contents] of [['empty', ''], ['whitespace', ' \n\t\n'], ['bom', '﻿']]) {
      const settingsPath = settingsFile(`empty-${name}`, contents);
      expect(readAutoUpdateSettings(settingsPath, {})).toEqual(SHIPPED_SETTINGS);
      expect(readAutoUpdateSettings(settingsPath, { CLAUDE_MEM_AUTO_UPDATE: 'false' }).CLAUDE_MEM_AUTO_UPDATE).toBe('false');
      // Nothing is written.
      expect(readFileSync(settingsPath, 'utf-8')).toBe(contents);
    }
  });

  it('stops the tick at read-settings for an unreadable settings.json, even with the env switch off', async () => {
    silenceLogger();
    const settingsPath = settingsFile('unreadable-tick', '{ not json');
    const checkHarness = buildCheckHarness();
    checkHarness.deps.readSettings = () => readAutoUpdateSettings(settingsPath, { CLAUDE_MEM_AUTO_UPDATE: 'false' });

    await expect(runAutoUpdateCheck(checkHarness.deps)).rejects.toMatchObject({ name: 'AutoUpdateCheckError', stage: 'read-settings' });
    expectNothingTouchedAfterSettings(checkHarness);
  });
});

describe('fetchJsonWithTimeout', () => {
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-fetch-'));
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const route = new URL(request.url).pathname;
        if (route === '/promoted-release.json') return Response.json({ schemaVersion: 1, promotedVersion: PROMOTED });
        if (route === `/claude-mem/${PROMOTED}`) return Response.json(workflowPublishedManifest(PROMOTED));
        if (route === '/claude-mem/99.0.0') return new Response(JSON.stringify('version not found: 99.0.0'), { status: 404 });
        if (route === '/not-json') return new Response('<html>rate limited</html>', { status: 200 });
        if (route === '/slow') { await Bun.sleep(2_000); return Response.json({}); }
        return new Response('', { status: 500 });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses a 2xx JSON body', async () => {
    expect(await fetchJsonWithTimeout(`${origin}/promoted-release.json`, 5_000))
      .toEqual({ ok: true, status: 200, body: { schemaVersion: 1, promotedVersion: PROMOTED } });
  });

  it('reports a non-2xx answer without parsing it', async () => {
    expect(await fetchJsonWithTimeout(`${origin}/claude-mem/99.0.0`, 5_000)).toEqual({ ok: false, status: 404, body: null });
  });

  it('rejects a 2xx body that is not JSON', async () => {
    await expect(fetchJsonWithTimeout(`${origin}/not-json`, 5_000)).rejects.toThrow();
  });

  it('rejects once the deadline passes', async () => {
    await expect(fetchJsonWithTimeout(`${origin}/slow`, 50)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('reads a file:// URL, so the setting can point at a local file', async () => {
    const promotedFile = path.join(tempDir, 'promoted-release.json');
    writeFileSync(promotedFile, JSON.stringify({ schemaVersion: 1, promotedVersion: PROMOTED }));
    expect((await fetchJsonWithTimeout(pathToFileURL(promotedFile).href, 5_000)).body).toEqual({ schemaVersion: 1, promotedVersion: PROMOTED });
    await expect(fetchJsonWithTimeout(pathToFileURL(path.join(tempDir, 'missing.json')).href, 5_000)).rejects.toThrow('ENOENT');
  });

  it('drives the check end to end over HTTP: a local promoted file, npm answers from the same server', async () => {
    silenceLogger();
    const throughLocalServer = (url: string, timeoutMs: number) =>
      fetchJsonWithTimeout(url.replace('https://registry.npmjs.org', origin), timeoutMs);

    const promoted = buildCheckHarness({ settings: { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: `${origin}/promoted-release.json` } });
    promoted.deps.fetchJson = throughLocalServer;
    expect(await runAutoUpdateCheck(promoted.deps)).toMatchObject({ decision: 'apply', targetVersion: PROMOTED, previousVersion: INSTALLED });

    const neverPublished = buildCheckHarness({ settings: { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: `${origin}/promoted-release.json` } });
    neverPublished.deps.fetchJson = async (url, timeoutMs) => url.endsWith('/promoted-release.json')
      ? json({ schemaVersion: 1, promotedVersion: '99.0.0' })
      : throughLocalServer(url, timeoutMs);
    expect((await runAutoUpdateCheck(neverPublished.deps)).decision).toBe('not-published-by-workflow');
  });
});
