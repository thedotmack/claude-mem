import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
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
  AutoUpdateLaunchError,
  CLAUDE_MEM_MARKETPLACE_SOURCE,
  autoUpdateDisabledReason,
  claudeCodeManagedSettingsDirectory,
  claudeCodePluginStateDisabledReason,
  claudeCodeSwitchInForce,
  claudeMemMarketplaceDeclarationInForce,
  describeAutoUpdateDecision,
  fetchJsonWithTimeout,
  isWorkerQuietBySignals,
  logFailedAutoUpdateTick,
  npmVersionMetadataUrl,
  parseAutoUpdateSwitch,
  readAutoUpdateSettings,
  readAutoUpdateSwitches,
  readClaudeCodePluginState,
  readClaudeCodeSettingsEnvBlocks,
  resolvePromotedReleaseUrl,
  runAutoUpdateCheck,
  writeClaudeCodeKnownMarketplacesUnlessReadOnly,
  type AutoUpdateCheckDeps,
  type AutoUpdateDecision,
  type AutoUpdateDecisionName,
  type AutoUpdateOncePerBootLogKey,
  type AutoUpdateSettings,
  type ClaudeCodePluginState,
  type ClaudeCodeSettingsEnvBlock,
  type ClaudeMemMarketplaceDeclaration,
  type FetchJsonResult,
  type WorkerQuietSignals,
} from '../../../src/services/auto-update/auto-update-check.js';
import type { InterruptedAttemptInstall } from '../../../src/services/auto-update/auto-update-apply.js';
import { AUTO_UPDATE_SUPERVISOR_DEADLINE_MS } from '../../../src/services/auto-update/auto-update-deadlines.js';
import { defaultAutoUpdateState, type AutoUpdateState, type AutoUpdateSupervisorPhase } from '../../../src/services/auto-update/auto-update-state.js';
import { writeJsonFileAtomic } from '../../../src/shared/atomic-json.js';
import { USER_SETTINGS_PATH } from '../../../src/shared/paths.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { PluginRootResolution } from '../../../src/shared/worker-utils.js';
import { sanitizeEnv } from '../../../src/supervisor/env-sanitizer.js';
import * as autoUpdateCheckModule from '../../../src/services/auto-update/auto-update-check.js';
import { logger } from '../../../src/utils/logger.js';

// runAutoUpdateCheck walks its gates with every effect injected: in-memory
// settings and state, a scripted fetch and a fixed clock. Nothing here touches
// the network, the real ~/.claude or the real data dir; the settings-file
// readers only read files this test writes into its own scratch directories.

// Project-local scratch (gitignored), never the system temp folder, as in
// tests/worker/http/routes/setup-state-routes.test.ts.
const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });

/**
 * Run before a test writes claude-mem's settings.json: it must not be the real
 * one. Every reader these tests drive (auto-update-switch-readers.ts for the
 * worker's tick and doctor's row, install.ts registerMarketplace) opens
 * USER_SETTINGS_PATH, which src/shared/paths.ts froze from CLAUDE_MEM_DATA_DIR
 * when this bun process first loaded it, so the tests write it there too. The
 * variable's value now is not compared with it: one `bun test` call runs all
 * its files in one process, and the file that first loaded paths.ts may have
 * set the variable to a data dir of its own and put it back since, as
 * tests/infrastructure/process-manager.test.ts does. On Linux and macOS bun
 * reads os.homedir() once at startup, so a test that sets HOME does not move
 * the real data dir checked here.
 */
function expectClaudeMemSettingsPathOutsideTheRealDataDir(): void {
  expect(USER_SETTINGS_PATH).not.toStartWith(path.join(homedir(), '.claude-mem') + path.sep);
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const INSTALLED = '15.11.0';
const PROMOTED = '15.12.0';
const PROMOTED_URL = 'https://raw.githubusercontent.com/thedotmack/claude-mem/main/releases/promoted-release.json';
const CLAUDE_CONFIG = path.resolve('auto-update-fixture', '.claude');
const CACHE_ROOT = path.join(CLAUDE_CONFIG, 'plugins', 'cache', 'thedotmack', 'claude-mem');
const MARKETPLACE = path.join(CLAUDE_CONFIG, 'plugins', 'marketplaces', 'thedotmack');
const KNOWN_MARKETPLACES_PATH = path.join(CLAUDE_CONFIG, 'plugins', 'known_marketplaces.json');
/** When an earlier check read both the promoted file and npm's metadata: the proof the turn-off waits for. */
const PROVEN_AT = NOW - 25 * HOUR_MS;
/** Where the scripted npx lookup finds npx by default. */
const NPX_ON_WORKER_PATH = '/usr/local/bin/npx';
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
  CLAUDE_MEM_RUNTIME: 'worker',
};

/** claude-mem's entry in Claude Code's known_marketplaces.json, in the order install.ts registerMarketplace writes it. */
const claudeMemMarketplaceEntry = (autoUpdate: boolean): Record<string, unknown> => ({
  source: { source: 'github', repo: 'thedotmack/claude-mem' },
  installLocation: MARKETPLACE,
  lastUpdated: '2026-11-01T09:30:00.000Z',
  autoUpdate,
});

/**
 * What Claude Code's files say on a standard install: registered at the
 * installed version, not turned off, and the marketplace entry the installer
 * writes, with Claude Code's background update off, as the worker leaves it
 * once it has turned it off.
 */
const REGISTERED_PLUGIN_STATE: ClaudeCodePluginState = {
  userSettings: { kind: 'not-disabled' },
  registration: { kind: 'registered', versions: [INSTALLED] },
  knownMarketplaces: { kind: 'read', path: KNOWN_MARKETPLACES_PATH, document: { thedotmack: claudeMemMarketplaceEntry(false) } },
};

const json = (body: unknown, status = 200): FetchJsonResult => ({ ok: status >= 200 && status < 300, status, body: status < 300 ? body : null });

/** Anthropic's official marketplace, whose background update is on by default and is not claude-mem's to change. */
const OFFICIAL_MARKETPLACE_ENTRY = {
  source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
  installLocation: path.join(CLAUDE_CONFIG, 'plugins', 'marketplaces', 'claude-plugins-official'),
  lastUpdated: '2026-11-07T08:00:00.000Z',
  autoUpdate: true,
};

/**
 * Claude Code's known_marketplaces.json on an install a pre-Phase 4 installer
 * registered: claude-mem's entry with autoUpdate true, written in an order the
 * installer does not use, with a field this version does not know, between
 * Anthropic's official marketplace and one the user added.
 */
const knownMarketplacesWithBackgroundUpdateOn = (): Record<string, unknown> => ({
  'claude-plugins-official': structuredClone(OFFICIAL_MARKETPLACE_ENTRY),
  thedotmack: {
    source: { source: 'github', repo: 'thedotmack/claude-mem' },
    autoUpdate: true,
    installLocation: MARKETPLACE,
    lastUpdated: '2026-10-28T14:02:51.000Z',
    aFieldThisVersionDoesNotKnow: { kept: ['as', 'read'] },
  },
  'team-tools': {
    source: { source: 'git', url: 'https://git.example.com/team/tools.git' },
    installLocation: path.join(CLAUDE_CONFIG, 'plugins', 'marketplaces', 'team-tools'),
    lastUpdated: '2026-10-30T17:45:12.000Z',
  },
});

/** What a correct turn-off writes: the document read, with only thedotmack.autoUpdate set to false. */
function withClaudeMemBackgroundUpdateOff(knownMarketplaces: Record<string, unknown>): Record<string, unknown> {
  const turnedOff = structuredClone(knownMarketplaces);
  (turnedOff.thedotmack as Record<string, unknown>).autoUpdate = false;
  return turnedOff;
}

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
  /** What Claude Code's user settings and installed_plugins.json say about claude-mem; REGISTERED_PLUGIN_STATE by default. */
  pluginState?: ClaudeCodePluginState;
  install?: PluginRootResolution | null;
  state?: Partial<AutoUpdateState> & Record<string, unknown>;
  /** Overrides by URL; defaults: the promoted file names PROMOTED and npm shows it fully published. */
  responses?: Record<string, FetchJsonResult | Error>;
  quiet?: boolean;
  /** Where a vanished attempt left the install (deps.readInterruptedAttemptInstall); on the previous version by default. An Error is thrown. */
  interruptedAttemptInstall?: InterruptedAttemptInstall | Error;
  /**
   * Claude Code's known_marketplaces.json as the plugin state reads it: a
   * document, or null for no file. Wins over pluginState's. By default
   * pluginState's, which is REGISTERED_PLUGIN_STATE's: claude-mem's entry as
   * the installer writes it, with autoUpdate false, as the worker leaves it.
   */
  knownMarketplaces?: Record<string, unknown> | null;
  /** extraKnownMarketplaces.thedotmack in Claude Code's settings files, in the order read; none by default. */
  claudeMemMarketplaceDeclarations?: ClaudeMemMarketplaceDeclaration[];
  /** What the npx lookup finds on the worker's PATH; NPX_ON_WORKER_PATH by default, null for none. */
  npx?: string | null;
}

/** The readings of an install left on the previous version, as auto-update-apply.ts describeInstallVersions words them. */
const ON_PREVIOUS_VERSION_WHERE = `The install resolves to ${INSTALLED}; installed_plugins.json registers ${INSTALLED}; the marketplace copy is ${INSTALLED}.`;

interface CheckHarness {
  deps: AutoUpdateCheckDeps;
  /** The state as the scenario started it, before any tick. */
  initialState: AutoUpdateState & Record<string, unknown>;
  stored: () => AutoUpdateState & Record<string, unknown>;
  writes: AutoUpdateState[];
  stateReads: () => number;
  claudeCodeSettingsReads: () => number;
  pluginStateReads: () => number;
  fetches: Array<{ url: string; timeoutMs: number }>;
  launches: Array<{ targetVersion: string; previousVersion: string }>;
  livenessProbes: number[];
  events: Array<{ event: string; properties: Record<string, unknown> }>;
  pluginRootLookups: () => number;
  interruptedAttemptReads: Array<{ targetVersion: string; previousVersion: string }>;
  knownMarketplacesWrites: Array<Record<string, unknown>>;
  /** Replace what known_marketplaces.json holds (null: no file), as Claude Code writing it would. */
  setKnownMarketplaces: (knownMarketplaces: Record<string, unknown> | null) => void;
  npxLookups: () => number;
}

function buildCheckHarness(scenario: Scenario = {}): CheckHarness {
  let stored = { ...defaultAutoUpdateState(), ...structuredClone(scenario.state ?? {}) } as AutoUpdateState & Record<string, unknown>;
  const asRead = (document: Record<string, unknown> | null): ClaudeCodePluginState['knownMarketplaces'] =>
    ({ kind: 'read', path: KNOWN_MARKETPLACES_PATH, document: structuredClone(document) });
  let knownMarketplacesFile: ClaudeCodePluginState['knownMarketplaces'] = scenario.knownMarketplaces !== undefined
    ? asRead(scenario.knownMarketplaces)
    : structuredClone((scenario.pluginState ?? REGISTERED_PLUGIN_STATE).knownMarketplaces);
  const knownMarketplacesWrites: Array<Record<string, unknown>> = [];
  let npxLookups = 0;
  let stateReads = 0;
  let claudeCodeSettingsReads = 0;
  let pluginStateReads = 0;
  let pluginRootLookups = 0;
  const writes: AutoUpdateState[] = [];
  const fetches: Array<{ url: string; timeoutMs: number }> = [];
  const launches: Array<{ targetVersion: string; previousVersion: string }> = [];
  const livenessProbes: number[] = [];
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const interruptedAttemptReads: Array<{ targetVersion: string; previousVersion: string }> = [];
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
      return {
        envBlocks: structuredClone(scenario.claudeCodeSettingsEnv ?? []),
        skipped: [],
        claudeMemMarketplaceDeclarations: structuredClone(scenario.claudeMemMarketplaceDeclarations ?? []),
      };
    },
    // known_marketplaces.json as it is now: what the scenario started with, then what the turn-off or Claude Code wrote.
    readClaudeCodePluginState: () => {
      pluginStateReads++;
      return { ...structuredClone(scenario.pluginState ?? REGISTERED_PLUGIN_STATE), knownMarketplaces: structuredClone(knownMarketplacesFile) };
    },
    writeClaudeCodeKnownMarketplaces: (knownMarketplaces) => {
      knownMarketplacesWrites.push(structuredClone(knownMarketplaces));
      knownMarketplacesFile = asRead(knownMarketplaces);
    },
    findNpxOnWorkerPath: () => {
      npxLookups++;
      return scenario.npx === undefined ? NPX_ON_WORKER_PATH : scenario.npx;
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
    readInterruptedAttemptInstall: async (attempt) => {
      interruptedAttemptReads.push(attempt);
      const left = scenario.interruptedAttemptInstall ?? { kind: 'on-previous-version', where: ON_PREVIOUS_VERSION_WHERE };
      if (left instanceof Error) throw left;
      return structuredClone(left);
    },
    isWorkerShuttingDown: () => false,
    launchSupervisor: async (attempt) => { launches.push(attempt); },
    captureEvent: (event, properties) => { events.push({ event, properties }); },
    oncePerBootLogsWritten: new Set<AutoUpdateOncePerBootLogKey>(),
  };
  return {
    deps,
    initialState: structuredClone(stored),
    stored: () => stored,
    writes,
    stateReads: () => stateReads,
    claudeCodeSettingsReads: () => claudeCodeSettingsReads,
    pluginStateReads: () => pluginStateReads,
    fetches,
    launches,
    livenessProbes,
    events,
    pluginRootLookups: () => pluginRootLookups,
    interruptedAttemptReads,
    knownMarketplacesWrites,
    setKnownMarketplaces: (knownMarketplaces) => { knownMarketplacesFile = asRead(knownMarketplaces); },
    npxLookups: () => npxLookups,
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

/** An attempt past its deadline whose supervisor is gone, with the phase that supervisor recorded last (auto-update-apply.ts). */
const vanishedAttemptState = (supervisorPhase: AutoUpdateSupervisorPhase): Partial<AutoUpdateState> => ({
  inFlightAttempt: { targetVersion: PROMOTED, previousVersion: INSTALLED, startedAt: NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, supervisorPid: DEAD_SUPERVISOR_PID, supervisorPhase },
});

const userSettingsEnv = (env: Record<string, unknown>): ClaudeCodeSettingsEnvBlock =>
  ({ path: path.join(CLAUDE_CONFIG, 'settings.json'), env });
const managedSettingsEnv = (env: Record<string, unknown>): ClaudeCodeSettingsEnvBlock =>
  ({ path: '/Library/Application Support/ClaudeCode/managed-settings.json', env });

/** Claude Code's known_marketplaces.json not written, and npx not looked for. Callers check that the plugin state, which reads the file, was not read either. */
function expectKnownMarketplacesNotWritten(checkHarness: CheckHarness): void {
  expect(checkHarness.knownMarketplacesWrites).toHaveLength(0);
  expect(checkHarness.npxLookups()).toBe(0);
}

/** The state as an off tick writes it: as read, with only the decision recorded for doctor. */
function withOffDecisionRecorded(checkHarness: CheckHarness, result: AutoUpdateDecision): AutoUpdateState & Record<string, unknown> {
  return { ...checkHarness.initialState, lastDecision: { decision: result.decision, reason: describeAutoUpdateDecision(result), decidedAt: NOW } };
}

/**
 * An off tick (`result` given) reads the state file only to record its
 * decision for doctor, and writes nothing else into it; a tick that threw
 * before deciding (no `result`) reads and writes no state at all.
 */
function expectOnlyTheOffDecisionRecorded(checkHarness: CheckHarness, result?: AutoUpdateDecision): void {
  if (result === undefined) {
    expect(checkHarness.stateReads()).toBe(0);
    expect(checkHarness.writes).toHaveLength(0);
    return;
  }
  expect(checkHarness.stateReads()).toBe(1);
  expect(checkHarness.writes).toEqual([withOffDecisionRecorded(checkHarness, result)]);
}

/** Off by claude-mem's own settings or the worker's env: Claude Code's settings files are not even read. */
function expectNothingTouchedAfterSettings(checkHarness: CheckHarness, result?: AutoUpdateDecision): void {
  expect(checkHarness.claudeCodeSettingsReads()).toBe(0);
  expect(checkHarness.pluginStateReads()).toBe(0);
  expect(checkHarness.pluginRootLookups()).toBe(0);
  expectOnlyTheOffDecisionRecorded(checkHarness, result);
  expect(checkHarness.fetches).toHaveLength(0);
}

/** Off by a switch in one of Claude Code's settings files: read once, and nothing after it. */
function expectNothingTouchedAfterClaudeCodeSettings(checkHarness: CheckHarness, result?: AutoUpdateDecision): void {
  expect(checkHarness.claudeCodeSettingsReads()).toBe(1);
  expect(checkHarness.pluginStateReads()).toBe(0);
  expect(checkHarness.pluginRootLookups()).toBe(0);
  expectOnlyTheOffDecisionRecorded(checkHarness, result);
  expect(checkHarness.fetches).toHaveLength(0);
}

/** Off by claude-mem's own state in Claude Code: both of Claude Code's reads ran once, and nothing after them. */
function expectNothingTouchedAfterPluginState(checkHarness: CheckHarness, result?: AutoUpdateDecision): void {
  expect(checkHarness.claudeCodeSettingsReads()).toBe(1);
  expect(checkHarness.pluginStateReads()).toBe(1);
  expect(checkHarness.pluginRootLookups()).toBe(0);
  expectOnlyTheOffDecisionRecorded(checkHarness, result);
  expect(checkHarness.fetches).toHaveLength(0);
  expect(checkHarness.launches).toHaveLength(0);
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
  // The supervisor's own event never comes, so the worker sends it.
  expect(checkHarness.events).toEqual([{
    event: 'auto_update_failed',
    properties: { from_version: INSTALLED, to_version: PROMOTED, failure_stage: 'supervisor-vanished', restore_result: 'unknown' },
  }]);
}

function expectNeverStartedSupervisorRecordedAsFailed(checkHarness: CheckHarness): void {
  const state = checkHarness.stored();
  expect(state.inFlightAttempt).toBeNull();
  expect(state.lastAttemptOutcome).toMatchObject({
    result: 'failed',
    targetVersion: PROMOTED,
    previousVersion: INSTALLED,
    finishedAt: NOW,
    failureStage: 'supervisor-never-started',
    message: expect.stringContaining('recorded neither a supervisor pid nor an outcome'),
  });
  // Nothing ran, so the version is not blocked.
  expect(state.versionsThatFailedToApply).toEqual([]);
  expect(checkHarness.events).toEqual([{
    event: 'auto_update_failed',
    properties: { from_version: INSTALLED, to_version: PROMOTED, failure_stage: 'supervisor-never-started', restore_result: 'not-attempted' },
  }]);
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
        expectNothingTouchedAfterSettings(checkHarness, result);
      },
    },
    {
      name: 'off: DISABLE_AUTOUPDATER=1, read after Claude Code\'s settings files, where FORCE_AUTOUPDATE_PLUGINS could override it',
      scenario: { env: { DISABLE_AUTOUPDATER: '1' } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'disabled', reason: 'DISABLE_AUTOUPDATER is set (Claude Code\'s switch for no background updates)' });
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness, result);
      },
    },
    { name: 'off: DISABLE_UPDATES=1, read after Claude Code\'s settings files too', scenario: { env: { DISABLE_UPDATES: '1' } }, decision: 'disabled', verify: expectNothingTouchedAfterClaudeCodeSettings },
    { name: 'off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, read after Claude Code\'s settings files too', scenario: { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }, decision: 'disabled', verify: expectNothingTouchedAfterClaudeCodeSettings },
    {
      name: 'off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0 (any non-empty value is on)',
      scenario: { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({ decision: 'disabled', reason: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set (Claude Code\'s switch for no background updates)' });
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness, result);
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
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness, result);
      },
    },
    {
      name: 'off: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="false" in Claude Code\'s managed settings',
      scenario: { claudeCodeSettingsEnv: [userSettingsEnv({ DISABLE_AUTOUPDATER: '0' }), managedSettingsEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'false' })] },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ reason: expect.stringContaining('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set in the env block of /Library/Application Support/ClaudeCode/managed-settings.json') });
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness, result);
      },
    },
    {
      name: 'on: Claude Code\'s settings files exist but set no switch (DISABLE_UPDATES=0 is off)',
      scenario: { claudeCodeSettingsEnv: [userSettingsEnv({ DISABLE_UPDATES: '0', ANTHROPIC_MODEL: 'opus' }), managedSettingsEnv({})] },
      decision: 'apply',
    },
    // FORCE_AUTOUPDATE_PLUGINS=1 forces plugin auto-updates over all three switches, read from the same places
    // (the plugins/loading docs: "the whole pass is off ... unless you also set FORCE_AUTOUPDATE_PLUGINS=1").
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
    { name: 'on: DISABLE_UPDATES=1 with FORCE_AUTOUPDATE_PLUGINS=1, both in the env', scenario: { env: { DISABLE_UPDATES: '1', FORCE_AUTOUPDATE_PLUGINS: '1' } }, decision: 'apply' },
    {
      name: 'on: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 and DISABLE_UPDATES=1 in Claude Code\'s user settings, FORCE_AUTOUPDATE_PLUGINS=1 in the env',
      scenario: { env: { FORCE_AUTOUPDATE_PLUGINS: '1' }, claudeCodeSettingsEnv: [userSettingsEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_UPDATES: '1' })] },
      decision: 'apply',
    },
    {
      name: 'on: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 in the env, FORCE_AUTOUPDATE_PLUGINS=1 in Claude Code\'s managed settings',
      scenario: { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, claudeCodeSettingsEnv: [managedSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: '1' })] },
      decision: 'apply',
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

    // Gate 1: the user's own choices in claude-mem's settings and in Claude Code, which an unattended update would undo.
    {
      name: 'off: CLAUDE_MEM_RUNTIME=server (an update writes CLAUDE_MEM_RUNTIME=worker)',
      scenario: { settings: { CLAUDE_MEM_RUNTIME: 'server' } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({
          decision: 'disabled',
          reason: 'CLAUDE_MEM_RUNTIME="server", not "worker" (an unattended update writes CLAUDE_MEM_RUNTIME=worker, which would switch this install\'s runtime)',
        });
        expectNothingTouchedAfterSettings(checkHarness, result);
      },
    },
    { name: 'off: CLAUDE_MEM_RUNTIME=server-beta (the legacy server value)', scenario: { settings: { CLAUDE_MEM_RUNTIME: 'server-beta' } }, decision: 'disabled', verify: expectNothingTouchedAfterSettings },
    { name: 'on: CLAUDE_MEM_RUNTIME=" Worker " (read like the hooks read it)', scenario: { settings: { CLAUDE_MEM_RUNTIME: ' Worker ' } }, decision: 'apply' },
    {
      name: 'off: claude-mem turned off in Claude Code (enabledPlugins false), read after Claude Code\'s env switches and before anything else',
      scenario: { pluginState: { ...REGISTERED_PLUGIN_STATE, userSettings: { kind: 'explicitly-disabled', path: path.join(CLAUDE_CONFIG, 'settings.json') } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({
          decision: 'disabled',
          reason: `claude-mem is turned off in Claude Code (enabledPlugins["claude-mem@thedotmack"] is false in ${path.join(CLAUDE_CONFIG, 'settings.json')}); an update would turn it back on`,
        });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: Claude Code\'s user settings do not parse, so the installer would stop on them',
      scenario: { pluginState: { ...REGISTERED_PLUGIN_STATE, userSettings: { kind: 'unreadable', path: path.join(CLAUDE_CONFIG, 'settings.json'), problem: `${path.join(CLAUDE_CONFIG, 'settings.json')} is not valid JSON: JSON Parse error` } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ reason: expect.stringContaining('so whether claude-mem is turned off in Claude Code cannot be read, and an update would stop on that file') });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: claude-mem is not registered at user scope in installed_plugins.json (uninstalled from Claude Code, or installed only for a project)',
      scenario: { pluginState: { ...REGISTERED_PLUGIN_STATE, registration: { kind: 'not-registered', path: path.join(CLAUDE_CONFIG, 'plugins', 'installed_plugins.json') } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({
          decision: 'disabled',
          reason: `claude-mem is not registered at user scope in ${path.join(CLAUDE_CONFIG, 'plugins', 'installed_plugins.json')} (it was uninstalled from Claude Code, or installed there only for a project); an update would register it again`,
        });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: installed_plugins.json does not parse, so the installer would stop on it',
      scenario: { pluginState: { ...REGISTERED_PLUGIN_STATE, registration: { kind: 'unreadable', path: path.join(CLAUDE_CONFIG, 'plugins', 'installed_plugins.json'), problem: 'Corrupt JSON file, refusing to overwrite: installed_plugins.json' } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ reason: 'Corrupt JSON file, refusing to overwrite: installed_plugins.json, so whether claude-mem is still installed cannot be read, and an update would stop on that file' });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: known_marketplaces.json does not parse as a JSON object, so the installer would stop on it after rewriting the marketplace copy and the cache',
      scenario: { pluginState: { ...REGISTERED_PLUGIN_STATE, knownMarketplaces: { kind: 'unreadable', path: KNOWN_MARKETPLACES_PATH, problem: `${KNOWN_MARKETPLACES_PATH} does not hold a JSON object` } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({
          decision: 'disabled',
          reason: `${KNOWN_MARKETPLACES_PATH} does not hold a JSON object, so an update could not register the marketplace there: it would stop on that file, or write it back without claude-mem's entry, after it had already rewritten the marketplace copy and the plugin cache`,
        });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: claude-mem\'s marketplace entry was added from a full git URL, which an update would replace with the installer\'s',
      scenario: { knownMarketplaces: { thedotmack: { ...claudeMemMarketplaceEntry(false), source: { source: 'git', url: 'https://github.com/thedotmack/claude-mem.git' } } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({
          decision: 'disabled',
          reason: `the thedotmack entry in ${KNOWN_MARKETPLACES_PATH} has source {"source":"git","url":"https://github.com/thedotmack/claude-mem.git"}, not the one the installer writes (source {"source":"github","repo":"thedotmack/claude-mem"} at ${MARKETPLACE}), so it was added another way, and an unattended update would replace it`,
        });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: claude-mem\'s marketplace entry is pinned to a ref (owner/repo#ref)',
      scenario: { knownMarketplaces: { thedotmack: { ...claudeMemMarketplaceEntry(true), source: { source: 'github', repo: 'thedotmack/claude-mem', ref: 'v15.11.0' } } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ reason: expect.stringContaining('has source {"source":"github","repo":"thedotmack/claude-mem","ref":"v15.11.0"}, not the one the installer writes') });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: claude-mem\'s marketplace entry was added from a local path, whose installLocation is that path',
      scenario: {
        knownMarketplaces: {
          thedotmack: { source: { source: 'directory', path: path.resolve('claude-mem-checkout') }, installLocation: path.resolve('claude-mem-checkout'), lastUpdated: '2026-11-01T09:30:00.000Z' },
        },
      },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ reason: expect.stringContaining(`has source ${JSON.stringify({ source: 'directory', path: path.resolve('claude-mem-checkout') })}`) });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: claude-mem\'s marketplace entry has the installer\'s source but another installLocation',
      scenario: { knownMarketplaces: { thedotmack: { ...claudeMemMarketplaceEntry(true), installLocation: path.resolve('elsewhere', 'thedotmack') } } },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toMatchObject({ reason: expect.stringContaining(`has installLocation ${JSON.stringify(path.resolve('elsewhere', 'thedotmack'))}, not the one the installer writes`) });
        expectNothingTouchedAfterPluginState(checkHarness, result);
      },
    },
    {
      name: 'off: claude-mem\'s marketplace entry is not an object',
      scenario: { knownMarketplaces: { thedotmack: 'thedotmack/claude-mem' } },
      decision: 'disabled',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ reason: `the thedotmack entry in ${KNOWN_MARKETPLACES_PATH} is a string, not the one the installer writes (source {"source":"github","repo":"thedotmack/claude-mem"} at ${MARKETPLACE}), so it was added another way, and an unattended update would replace it` }),
    },
    {
      name: 'on: claude-mem\'s marketplace entry is the installer\'s, its installLocation written with a trailing separator',
      scenario: { knownMarketplaces: { thedotmack: { ...claudeMemMarketplaceEntry(false), installLocation: `${MARKETPLACE}${path.sep}` } } },
      decision: 'apply',
    },

    // Gate 1: Claude Code's own background update of claude-mem's marketplace, as its settings files declare it.
    {
      name: 'off: extraKnownMarketplaces.thedotmack.autoUpdate is true in Claude Code\'s user settings, which outranks known_marketplaces.json',
      scenario: { claudeMemMarketplaceDeclarations: [{ path: path.join(CLAUDE_CONFIG, 'settings.json'), autoUpdate: true }] },
      decision: 'disabled',
      verify: (checkHarness, result) => {
        expect(result).toEqual({
          decision: 'disabled',
          reason: `extraKnownMarketplaces.thedotmack.autoUpdate is true in ${path.join(CLAUDE_CONFIG, 'settings.json')}: Claude Code's own background update of claude-mem's marketplace is on there, and Claude Code reads that before known_marketplaces.json, so running claude-mem's updater too would race it`,
        });
        expectNothingTouchedAfterClaudeCodeSettings(checkHarness, result);
      },
    },
    {
      name: 'off: the managed settings declare it with autoUpdate true over the user\'s false',
      scenario: {
        claudeMemMarketplaceDeclarations: [
          { path: path.join(CLAUDE_CONFIG, 'settings.json'), autoUpdate: false },
          { path: '/Library/Application Support/ClaudeCode/managed-settings.json', autoUpdate: true },
        ],
      },
      decision: 'disabled',
      verify: (_checkHarness, result) => expect(result).toMatchObject({ reason: expect.stringContaining('autoUpdate is true in /Library/Application Support/ClaudeCode/managed-settings.json') }),
    },
    {
      name: 'on: the declaration in force sets no autoUpdate, replacing the user\'s true whole, so known_marketplaces.json decides',
      scenario: {
        claudeMemMarketplaceDeclarations: [
          { path: path.join(CLAUDE_CONFIG, 'settings.json'), autoUpdate: true },
          { path: '/Library/Application Support/ClaudeCode/managed-settings.json', autoUpdate: undefined },
        ],
      },
      decision: 'apply',
    },
    { name: 'on: extraKnownMarketplaces.thedotmack.autoUpdate is false: Claude Code\'s own update is off', scenario: { claudeMemMarketplaceDeclarations: [{ path: path.join(CLAUDE_CONFIG, 'settings.json'), autoUpdate: false }] }, decision: 'apply' },

    // Gate 2: install shape.
    { name: 'no install', scenario: { install: null }, decision: 'no-install' },
    {
      name: 'dev checkout (root outside the plugin cache and the marketplace)',
      scenario: { install: { root: path.resolve('claude-mem-checkout', 'plugin'), version: '15.13.0', missingDependencies: [] } },
      decision: 'not-a-standard-install',
      verify: (checkHarness, result) => { expectOnlyTheOffDecisionRecorded(checkHarness, result); expect(checkHarness.fetches).toHaveLength(0); },
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
        expectOnlyTheOffDecisionRecorded(checkHarness, result);
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
        expect(checkHarness.events).toEqual([]);
      },
    },
    {
      name: 'a live supervisor exactly one check cycle old is still in flight',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS, LIVE_SUPERVISOR_PID) },
      decision: 'attempt-in-flight',
    },
    {
      name: 'never started: one millisecond past the supervisor deadline with no pid recorded, the version not blocked',
      // The worker checked the network when it launched the attempt, so the next try waits for the next due check.
      scenario: { state: { ...inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - 1, null), lastNetworkCheckAt: NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - 1 } },
      decision: 'not-due',
      verify: (checkHarness) => {
        expect(checkHarness.livenessProbes).toEqual([]);
        expectNeverStartedSupervisorRecordedAsFailed(checkHarness);
      },
    },
    {
      name: 'never started: once due, the same version is tried again in the same tick',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, null) },
      decision: 'apply',
      verify: (checkHarness) => {
        expectNeverStartedSupervisorRecordedAsFailed(checkHarness);
        expect(checkHarness.launches).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
      },
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
          failureStage: 'supervisor-vanished',
          message: expect.stringContaining(`The install reports ${PROMOTED}`),
        });
        expect(state.versionsThatFailedToApply).toEqual([]);
        expect(checkHarness.events).toEqual([{
          event: 'auto_update_applied',
          properties: { from_version: INSTALLED, to_version: PROMOTED, failure_stage: 'supervisor-vanished' },
        }]);
        // Applied needs no reading of where the attempt left the install.
        expect(checkHarness.interruptedAttemptReads).toEqual([]);
      },
    },
    {
      name: 'vanished with no phase recorded (a supervisor from before it was), and the install still all at the previous version: failed and blocked, as before, saying where the install is',
      scenario: { state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID) },
      decision: 'previously-failed',
      verify: (checkHarness) => {
        expect(checkHarness.interruptedAttemptReads).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
        expectVanishedSupervisorRecordedAsFailed(checkHarness, `its supervisor is no longer running. The install reports ${INSTALLED}. ${ON_PREVIOUS_VERSION_WHERE}`);
      },
    },
    {
      name: 'vanished while still installing the target, with nothing of it in place (a reboot during the npm download): failed and not blocked, so this due tick tries it again',
      scenario: { state: vanishedAttemptState('installing-target') },
      decision: 'apply',
      verify: (checkHarness) => {
        const state = checkHarness.stored();
        expect(state.inFlightAttempt).toBeNull();
        expect(state.lastAttemptOutcome).toMatchObject({
          result: 'failed',
          failureStage: 'supervisor-vanished',
          message: expect.stringContaining(`${ON_PREVIOUS_VERSION_WHERE} Its supervisor was still installing ${PROMOTED}, and nothing of it is in place, so it is tried again at the next due check.`),
        });
        expect(state.versionsThatFailedToApply).toEqual([]);
        expect(checkHarness.launches).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
        expect(checkHarness.events).toEqual([{
          event: 'auto_update_failed',
          properties: { from_version: INSTALLED, to_version: PROMOTED, failure_stage: 'supervisor-vanished', restore_result: 'unknown' },
        }]);
      },
    },
    {
      name: 'vanished while restoring the previous version, with the install back on it (restored, then killed): failed and blocked, though the readings alone match an untouched install',
      scenario: { state: vanishedAttemptState('restoring-previous-version') },
      decision: 'previously-failed',
      verify: (checkHarness) => expectVanishedSupervisorRecordedAsFailed(checkHarness, `${ON_PREVIOUS_VERSION_WHERE} Its supervisor had begun restoring ${INSTALLED}, so ${PROMOTED} had already failed here and is not tried again.`),
    },
    {
      name: 'vanished while still installing the target, with part of it in place: restore_failed and blocked',
      scenario: {
        state: vanishedAttemptState('installing-target'),
        interruptedAttemptInstall: {
          kind: 'half-switched',
          where: `The install resolves to ${INSTALLED}; installed_plugins.json registers ${PROMOTED}; the marketplace copy is ${PROMOTED}.`,
        },
      },
      decision: 'previously-failed',
      verify: (checkHarness) => {
        expect(checkHarness.stored().lastAttemptOutcome).toMatchObject({ result: 'restore_failed', failureStage: 'supervisor-vanished', fixCommand: `npx claude-mem@${PROMOTED} update` });
        expect(checkHarness.stored().versionsThatFailedToApply).toEqual([PROMOTED]);
      },
    },
    {
      name: 'vanished after a reboot cut off the installer with the target registered: restore_failed, naming the target\'s own installer, to run now',
      scenario: {
        state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID),
        interruptedAttemptInstall: {
          kind: 'half-switched',
          where: `The install resolves to ${INSTALLED}; installed_plugins.json registers ${PROMOTED}; the marketplace copy is ${PROMOTED}.`,
        },
      },
      decision: 'previously-failed',
      verify: (checkHarness) => {
        const state = checkHarness.stored();
        expect(state.inFlightAttempt).toBeNull();
        expect(state.lastAttemptOutcome).toEqual({
          result: 'restore_failed',
          targetVersion: PROMOTED,
          previousVersion: INSTALLED,
          finishedAt: NOW,
          failureStage: 'supervisor-vanished',
          message: expect.stringContaining(`installed_plugins.json registers ${PROMOTED}; the marketplace copy is ${PROMOTED}. Part of ${PROMOTED} is in place, and nothing restored ${INSTALLED} or proved ${PROMOTED}. Run: npx claude-mem@${PROMOTED} update`),
          // The target was promoted and shown fully published before the
          // attempt started, while latest may be a release the owner holds:
          // the same command, on its own, with when to run it, for the notice
          // and the doctor row.
          fixCommand: `npx claude-mem@${PROMOTED} update`,
          fixCommandWhen: 'now',
        });
        expect(state.versionsThatFailedToApply).toEqual([PROMOTED]);
        expect(checkHarness.events).toEqual([{
          event: 'auto_update_failed',
          properties: { from_version: INSTALLED, to_version: PROMOTED, failure_stage: 'supervisor-vanished', restore_result: 'unknown' },
        }]);
      },
    },
    {
      name: 'vanished and half-switched, but a ready worker on the install has since resolved it: restore_failed, still resolved',
      scenario: {
        state: { inFlightAttempt: { ...inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID).inFlightAttempt!, resolvedAt: NOW - MINUTE_MS, resolvedWithWorkerVersion: INSTALLED } },
        interruptedAttemptInstall: {
          kind: 'half-switched',
          where: `The install resolves to ${INSTALLED}; installed_plugins.json registers ${PROMOTED}; the marketplace copy is ${PROMOTED}.`,
        },
      },
      decision: 'previously-failed',
      verify: (checkHarness) => {
        // The install works: the warning must not come back when the worker records how the attempt ended.
        expect(checkHarness.stored().lastAttemptOutcome).toMatchObject({
          result: 'restore_failed',
          failureStage: 'supervisor-vanished',
          fixCommand: `npx claude-mem@${PROMOTED} update`,
          resolvedAt: NOW - MINUTE_MS,
          resolvedWithWorkerVersion: INSTALLED,
        });
        expect(checkHarness.stored().inFlightAttempt).toBeNull();
        // Telemetry still reports the attempt as it ended.
        expect(checkHarness.events.map((event) => event.event)).toEqual(['auto_update_failed']);
      },
    },
    {
      name: 'vanished on the previous version after an installer run resolved it: failed, still resolved',
      scenario: {
        state: { inFlightAttempt: { ...inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID).inFlightAttempt!, resolvedAt: NOW - MINUTE_MS } },
      },
      decision: 'previously-failed',
      verify: (checkHarness) => {
        const outcome = checkHarness.stored().lastAttemptOutcome!;
        expect(outcome).toMatchObject({ result: 'failed', failureStage: 'supervisor-vanished', resolvedAt: NOW - MINUTE_MS });
        expect(outcome.fixCommand).toBeUndefined();
      },
    },
    {
      name: 'vanished, with another update already past the target: failed, with nothing to fix',
      scenario: {
        install: { root: path.join(CACHE_ROOT, '15.13.0'), version: '15.13.0', missingDependencies: [] },
        state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID),
        interruptedAttemptInstall: { kind: 'moved-past-target', where: 'The install resolves to 15.13.0; installed_plugins.json registers 15.13.0; the marketplace copy is 15.13.0.', newerVersion: '15.13.0' },
      },
      decision: 'up-to-date',
      verify: (checkHarness) => {
        expect(checkHarness.stored().lastAttemptOutcome).toMatchObject({
          result: 'failed',
          failureStage: 'supervisor-vanished',
          message: expect.stringContaining(`15.13.0 is newer than ${PROMOTED}: another update moved the install on.`),
        });
      },
    },

    // Gate 4: due.
    {
      name: 'not due: the last check was 23 h ago',
      scenario: { state: { lastNetworkCheckAt: NOW - 23 * HOUR_MS } },
      decision: 'not-due',
      verify: (checkHarness, result) => {
        expect(checkHarness.fetches).toHaveLength(0);
        // Only the decision is saved, for doctor: the time of the last check stays as it was.
        expect(checkHarness.writes).toEqual([{
          ...checkHarness.initialState,
          lastDecision: { decision: 'not-due', reason: describeAutoUpdateDecision(result), decidedAt: NOW },
        }]);
      },
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

// doctor runs in a terminal whose environment can differ from the worker's,
// so the worker records each decision in the state file for doctor to show,
// on every tick with no attempt in flight.
describe('runAutoUpdateCheck — the decision recorded for doctor', () => {
  it('an on decision, with its reason in plain words and the tick\'s time', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness();
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(checkHarness.stored().lastDecision).toEqual({ decision: 'apply', reason: `installing ${PROMOTED} (from ${INSTALLED})`, decidedAt: NOW });
  });

  it('an off decision, read and written for this alone', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness({ settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } });
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('disabled');
    expect(checkHarness.stored().lastDecision).toEqual({ decision: 'disabled', reason: 'CLAUDE_MEM_AUTO_UPDATE=false', decidedAt: NOW });
  });

  it('nothing while an attempt is in flight, on or off: its supervisor writes the file then', async () => {
    silenceLogger();
    for (const scenario of [
      { state: inFlightAttemptState(NOW - 10 * MINUTE_MS, LIVE_SUPERVISOR_PID) },
      { state: inFlightAttemptState(NOW - 10 * MINUTE_MS, LIVE_SUPERVISOR_PID), settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } },
    ]) {
      const checkHarness = buildCheckHarness(scenario);
      await runAutoUpdateCheck(checkHarness.deps);
      expect(checkHarness.writes).toEqual([]);
    }
  });

  it('nothing for a worker shutting down, which saves nothing so the next boot checks again', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness();
    checkHarness.deps.isWorkerShuttingDown = () => true;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('worker-shutting-down');
    expect(checkHarness.writes).toEqual([]);
  });

  it('an off decision the state file cannot take: the decision stands, logged at WARN once per boot and DEBUG after', async () => {
    const spies = silenceLogger();
    const checkHarness = buildCheckHarness({ settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } });
    checkHarness.deps.readState = () => { throw new Error('EISDIR: illegal operation on a directory'); };

    for (let hour = 0; hour < 3; hour++) expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('disabled');

    const recordFailure = (spy: ReturnType<typeof spyOn>) => spy.mock.calls.filter((call) => String(call[1]).startsWith('Could not record the off decision'));
    expect(recordFailure(spies.warn).map((call) => call[2])).toEqual([{ decision: 'disabled', problem: 'EISDIR: illegal operation on a directory' }]);
    expect(recordFailure(spies.debug)).toHaveLength(2);
    expect(spies.error).not.toHaveBeenCalled();
  });
});

// doctor's Auto-update row calls readAutoUpdateSwitches on its own; the tick
// runs gates 1 and 2 through it, so for the same readers both give the same
// decision, and the doctor's call reads nothing past the gate that stopped it,
// writes nothing and logs nothing.
describe('readAutoUpdateSwitches (gates 1 and 2, shared with doctor)', () => {
  const offScenarios: Array<[string, Scenario]> = [
    ['claude-mem\'s own switch', { settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } }],
    ['an unrecognised CLAUDE_MEM_AUTO_UPDATE', { settings: { CLAUDE_MEM_AUTO_UPDATE: 'off' } }],
    ['Claude Code\'s switch in the environment', { env: { DISABLE_AUTOUPDATER: '1' } }],
    ['Claude Code\'s switch in a managed settings file', { claudeCodeSettingsEnv: [managedSettingsEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })] }],
    ['Claude Code\'s own update of the marketplace turned on in a settings file', { claudeMemMarketplaceDeclarations: [{ path: path.join(CLAUDE_CONFIG, 'settings.json'), autoUpdate: true }] }],
    ['claude-mem turned off in Claude Code', { pluginState: { ...REGISTERED_PLUGIN_STATE, userSettings: { kind: 'explicitly-disabled', path: path.join(CLAUDE_CONFIG, 'settings.json') } } }],
    ['no install', { install: null }],
    ['a dev checkout', { install: { root: path.resolve('claude-mem-checkout', 'plugin'), version: '15.13.0', missingDependencies: [] } }],
    ['an installed version it cannot compare', { install: { root: path.join(MARKETPLACE, 'plugin'), version: 'dev', missingDependencies: [] } }],
  ];

  for (const [name, scenario] of offScenarios) {
    it(`off by ${name}: the decision the tick returns`, async () => {
      const spies = silenceLogger();
      const tickDecision = await runAutoUpdateCheck(buildCheckHarness(scenario).deps);
      for (const spy of Object.values(spies)) spy.mockClear();
      const doctorHarness = buildCheckHarness(scenario);

      expect(readAutoUpdateSwitches(doctorHarness.deps)).toEqual({ kind: 'off', decision: tickDecision });
      expect(doctorHarness.stateReads()).toBe(0);
      expect(doctorHarness.writes).toHaveLength(0);
      expect(doctorHarness.fetches).toHaveLength(0);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });
  }

  it('on: what the later gates need, and nothing read past gate 2', () => {
    silenceLogger();
    const checkHarness = buildCheckHarness();
    expect(readAutoUpdateSwitches(checkHarness.deps)).toEqual({
      kind: 'on',
      settings: SHIPPED_SETTINGS,
      claudeMemMarketplaceDeclaration: null,
      pluginState: REGISTERED_PLUGIN_STATE,
      installedVersion: INSTALLED,
    });
    expect(checkHarness.stateReads()).toBe(0);
    expect(checkHarness.fetches).toHaveLength(0);
  });

  it('a settings file it cannot read throws the stage the tick would fail at', () => {
    const checkHarness = buildCheckHarness();
    checkHarness.deps.readSettings = () => { throw new Error('/data/settings.json exists but cannot be read as settings: Unexpected token'); };
    let thrown: unknown;
    try {
      readAutoUpdateSwitches(checkHarness.deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AutoUpdateCheckError);
    expect((thrown as AutoUpdateCheckError).stage).toBe('read-settings');
  });

  it('tells the observer what it read, in the order it read it', () => {
    const seen: string[] = [];
    readAutoUpdateSwitches(buildCheckHarness().deps, {
      settingsRead: () => seen.push('settings'),
      claudeCodeSettingsRead: () => seen.push('claude-code-settings'),
    });
    expect(seen).toEqual(['settings', 'claude-code-settings']);
  });
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

  it('records a launch whose spawn failed before a process existed as failed at launch-supervisor, clears the attempt, logs it at ERROR, and tries the version again at the next due check', async () => {
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
      throw new AutoUpdateLaunchError('could not start bun: spawn EAGAIN', false);
    };

    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({
      decision: 'launch-failed',
      targetVersion: PROMOTED,
      previousVersion: INSTALLED,
      message: 'The supervisor could not be launched: could not start bun: spawn EAGAIN',
    });
    const state = checkHarness.stored();
    expect(state.inFlightAttempt).toBeNull();
    expect(state.lastAttemptOutcome).toEqual({
      result: 'failed',
      targetVersion: PROMOTED,
      previousVersion: INSTALLED,
      finishedAt: NOW,
      failureStage: 'launch-supervisor',
      message: 'The supervisor could not be launched: could not start bun: spawn EAGAIN',
    });
    // It never ran, so the version is not blocked.
    expect(state.versionsThatFailedToApply).toEqual([]);
    // No supervisor will report it, so the worker does.
    expect(checkHarness.events).toEqual([{
      event: 'auto_update_failed',
      properties: { from_version: INSTALLED, to_version: PROMOTED, failure_stage: 'launch-supervisor', restore_result: 'not-attempted' },
    }]);
    expect(spies.error.mock.calls.map((call) => call[1])).toEqual(['Auto-update decision: launch-failed']);
    expect(spies.error.mock.calls[0][2]).toMatchObject({ targetVersion: PROMOTED, previousVersion: INSTALLED, message: expect.stringContaining('spawn EAGAIN') });

    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    checkHarness.deps.launchSupervisor = async (attempt) => { launchAttempts++; checkHarness.launches.push(attempt); };
    now = NOW + AUTO_UPDATE_CHECK_INTERVAL_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(launchAttempts).toBe(2);
  });

  it('keeps the attempt the launcher recorded in flight when the launch started a process (the hop outlived its budget), logs why at ERROR, records nothing and sends no event, and gate 3 later records it as never started, not blocked', async () => {
    const spies = silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness();
    checkHarness.deps.now = () => now;
    const hopKilled = `the auto-update hop (pid 6161) did not exit within 5 s, so it was killed; see /logs/auto-update-${NOW}.log`;
    const recordedByTheLauncher = { targetVersion: PROMOTED, previousVersion: INSTALLED, startedAt: NOW, supervisorPid: null, supervisorDeadlineMs: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS };
    checkHarness.deps.launchSupervisor = async () => {
      // What launchAutoUpdateSupervisor writes before it starts the hop.
      checkHarness.deps.writeState({ ...checkHarness.deps.readState(), inFlightAttempt: recordedByTheLauncher });
      throw new AutoUpdateLaunchError(hopKilled, true);
    };

    const result = await runAutoUpdateCheck(checkHarness.deps);
    expect(result).toEqual({ decision: 'launch-unconfirmed', targetVersion: PROMOTED, previousVersion: INSTALLED, message: hopKilled });
    const state = checkHarness.stored();
    // Its supervisor may be running: the attempt stays as the launcher recorded it.
    expect(state.inFlightAttempt).toEqual(recordedByTheLauncher);
    // The attempt has not ended: no outcome, no event, nothing blocked.
    expect(state.lastAttemptOutcome).toBeNull();
    expect(checkHarness.events).toEqual([]);
    expect(state.versionsThatFailedToApply).toEqual([]);
    // Nothing is recorded for doctor: the file keeps the apply decision saved before the launch. Why is in the log, at ERROR.
    expect(state.lastDecision).toMatchObject({ decision: 'apply', decidedAt: NOW });
    expect(spies.error.mock.calls.map((call) => call[1])).toEqual(['Auto-update decision: launch-unconfirmed']);
    expect(spies.error.mock.calls[0][2]).toEqual({ targetVersion: PROMOTED, previousVersion: INSTALLED, message: hopKilled });

    // Within the supervisor deadline it is in flight, and nothing is written.
    now = NOW + HOUR_MS;
    const writesBefore = checkHarness.writes.length;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('attempt-in-flight');
    expect(checkHarness.writes).toHaveLength(writesBefore);
    // Past it, with no supervisor pid recorded: never started, and the version is not blocked.
    now = NOW + AUTO_UPDATE_SUPERVISOR_DEADLINE_MS + MINUTE_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.stored().inFlightAttempt).toBeNull();
    expect(checkHarness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'supervisor-never-started' });
    expect(checkHarness.stored().versionsThatFailedToApply).toEqual([]);
    expect(checkHarness.events).toEqual([{
      event: 'auto_update_failed',
      properties: { from_version: INSTALLED, to_version: PROMOTED, failure_stage: 'supervisor-never-started', restore_result: 'not-attempted' },
    }]);
  });

  it('writes nothing to the state file after that launch error, so a claim its supervisor writes then stays as the supervisor wrote it', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness();
    const recordedByTheLauncher = { targetVersion: PROMOTED, previousVersion: INSTALLED, startedAt: NOW, supervisorPid: null, supervisorDeadlineMs: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS };
    // What auto-update-apply.ts claimInFlightAttempt writes: its pid, and the phase it starts in.
    const claimedByTheSupervisor = { ...recordedByTheLauncher, supervisorPid: LIVE_SUPERVISOR_PID, supervisorPhase: 'installing-target' as const };
    let writesWhenTheLaunchFailed = 0;
    checkHarness.deps.launchSupervisor = async () => {
      checkHarness.deps.writeState({ ...checkHarness.deps.readState(), inFlightAttempt: recordedByTheLauncher });
      writesWhenTheLaunchFailed = checkHarness.writes.length;
      // The supervisor the hop started claims the attempt just after the launch error, with its own read and
      // write of the file: queued now, it runs once this launch has rejected, before gate 9 handles the error.
      queueMicrotask(() => checkHarness.deps.writeState({ ...checkHarness.deps.readState(), inFlightAttempt: claimedByTheSupervisor }));
      throw new AutoUpdateLaunchError('the auto-update hop (pid 6161) did not exit within 5 s, and killing it failed (EPERM), so it may still be running; see /logs/auto-update.log', true);
    };

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('launch-unconfirmed');
    // The claim is in the file as the supervisor wrote it, pid and phase, for gate 3 to read.
    expect(checkHarness.stored().inFlightAttempt).toEqual(claimedByTheSupervisor);
    // Since the launch error the file was written once, by the supervisor's claim: gate 9 wrote nothing.
    expect(checkHarness.writes.slice(writesWhenTheLaunchFailed).map((written) => written.inFlightAttempt)).toEqual([claimedByTheSupervisor]);
  });

  it('keeps the state fields this version does not know when it saves', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness({ state: { rolloutCohort: { percent: 10, bucket: 'b' } } });

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(checkHarness.stored().rolloutCohort).toEqual({ percent: 10, bucket: 'b' });
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

  it('a vanished attempt whose install cannot be read stays in flight, with the stage named, for the next tick to record', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness({
      state: inFlightAttemptState(NOW - AUTO_UPDATE_SUPERVISOR_DEADLINE_MS - MINUTE_MS, DEAD_SUPERVISOR_PID),
      interruptedAttemptInstall: new Error('EACCES: installed_plugins.json'),
    });

    await expect(runAutoUpdateCheck(checkHarness.deps)).rejects.toMatchObject({ name: 'AutoUpdateCheckError', stage: 'read-interrupted-attempt-install' });
    expect(checkHarness.writes).toEqual([]);
    expect(checkHarness.stored().inFlightAttempt).toMatchObject({ targetVersion: PROMOTED, supervisorPid: DEAD_SUPERVISOR_PID });
    expect(checkHarness.events).toEqual([]);
    expect(checkHarness.launches).toEqual([]);
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
    checkHarness.deps.readClaudeCodeSettingsEnv = () => ({ envBlocks: structuredClone(settingsFiles), skipped: [], claudeMemMarketplaceDeclarations: [] });

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    settingsFiles[0].env.DISABLE_UPDATES = 1;
    now = NOW + HOUR_MS;
    expect(await runAutoUpdateCheck(checkHarness.deps)).toMatchObject({ decision: 'disabled', reason: expect.stringContaining('DISABLE_UPDATES is set in the env block of') });
  });
});

describe('runAutoUpdateCheck — turning off Claude Code\'s background update of the thedotmack marketplace', () => {
  /** known_marketplaces.json with claude-mem's entry at autoUpdate true, as every new install registers it and every installer from before Phase 4 left it, on a machine where an earlier check proved claude-mem's updater. */
  const backgroundUpdateOn = (scenario: Scenario = {}): Scenario => ({
    knownMarketplaces: knownMarketplacesWithBackgroundUpdateOn(),
    ...scenario,
    state: { promotedFileAndNpmMetadataReadAt: PROVEN_AT, ...scenario.state },
  });
  /** The same, on a machine where no check has proved it yet. */
  const backgroundUpdateOnNotYetProven = (scenario: Scenario = {}): Scenario => ({ knownMarketplaces: knownMarketplacesWithBackgroundUpdateOn(), ...scenario });
  /** The promoted version is the installed one, so the check ends at gate 6. */
  const upToDate: Scenario = { responses: { [PROMOTED_URL]: json({ schemaVersion: 1, promotedVersion: INSTALLED }), [npmVersionMetadataUrl(INSTALLED)]: json(workflowPublishedManifest(INSTALLED)) } };
  const NOT_YET_PROVEN = 'claude-mem\'s updater has not yet read both the promoted file and npm\'s metadata for the promoted version on this machine, so Claude Code\'s background update of the thedotmack marketplace stays on until it has';
  const NPX_NOT_FOUND = 'npx is not on the worker\'s PATH, so claude-mem\'s updater could not run its installer, and Claude Code\'s background update of the thedotmack marketplace stays on';
  const USER_SETTINGS = path.join(CLAUDE_CONFIG, 'settings.json');
  const MANAGED_SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json';
  const turnedOffLogs = (spies: LogSpies) => spies.info.mock.calls.filter((call) => String(call[1]).startsWith('Turned off Claude Code\'s background update'));
  const leftOnLogs = (spy: LogSpies['info']) => spy.mock.calls.filter((call) => String(call[1]).startsWith('Left Claude Code\'s background update on'));
  const stepFailureLogs = (spy: LogSpies['warn']) => spy.mock.calls.filter((call) => String(call[1]).startsWith('Could not turn off Claude Code\'s background update'));
  const npmMetadataLogs = (spies: LogSpies) => spies.warn.mock.calls.filter((call) => String(call[1]).startsWith('npm\'s metadata for the promoted version did not prove claude-mem\'s updater here'));
  const claudeMemEntryWithoutAutoUpdate = (): Record<string, unknown> => {
    const entry = claudeMemMarketplaceEntry(false);
    delete entry.autoUpdate;
    return entry;
  };

  it('once a check has proved claude-mem\'s updater here, sets only thedotmack.autoUpdate from true to false, keeping every other entry and field in the order read, records the time, logs it, and the tick goes on', async () => {
    const spies = silenceLogger();
    const checkHarness = buildCheckHarness(backgroundUpdateOn({ state: { claudeCodeBackgroundUpdateLeftOnReason: NOT_YET_PROVEN } }));

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    const expected = withClaudeMemBackgroundUpdateOff(knownMarketplacesWithBackgroundUpdateOn());
    expect(checkHarness.knownMarketplacesWrites).toEqual([expected]);
    // toEqual ignores key order; the serialized text does not.
    expect(JSON.stringify(checkHarness.knownMarketplacesWrites[0])).toBe(JSON.stringify(expected));
    // Anthropic's official marketplace keeps its own background update.
    expect(checkHarness.knownMarketplacesWrites[0]['claude-plugins-official']).toEqual(OFFICIAL_MARKETPLACE_ENTRY);
    // The file is read once a tick, with the rest of Claude Code's plugin state, and written from that read.
    expect(checkHarness.pluginStateReads()).toBe(1);
    expect(checkHarness.npxLookups()).toBe(1);
    expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: NOW, claudeCodeBackgroundUpdateLeftOnReason: null });
    expect(turnedOffLogs(spies)).toHaveLength(1);
    expect(checkHarness.launches).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
  });

  it('runs before the due gate: a tick that is not due turns it off too and saves the time, without the network', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness(backgroundUpdateOn({ state: { lastNetworkCheckAt: NOW - 23 * HOUR_MS } }));

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.knownMarketplacesWrites).toHaveLength(1);
    expect(checkHarness.fetches).toEqual([]);
    // The turn-off saves its time at once, then the tick saves its decision for doctor.
    expect(checkHarness.writes).toHaveLength(2);
    expect(checkHarness.writes[0]).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: NOW, lastDecision: null });
    expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: NOW, lastNetworkCheckAt: NOW - 23 * HOUR_MS, lastDecision: { decision: 'not-due', decidedAt: NOW } });
  });

  const nothingToTurnOff: Array<[string, Scenario]> = [
    ['autoUpdate is already false, as the worker leaves it once it has turned it off', { knownMarketplaces: { 'claude-plugins-official': structuredClone(OFFICIAL_MARKETPLACE_ENTRY), thedotmack: claudeMemMarketplaceEntry(false) } }],
    ['the entry has no autoUpdate (off: Claude Code\'s default for a third-party marketplace)', { knownMarketplaces: { thedotmack: claudeMemEntryWithoutAutoUpdate() } }],
    ['there is no thedotmack entry, only another marketplace with its background update on', { knownMarketplaces: { 'claude-plugins-official': structuredClone(OFFICIAL_MARKETPLACE_ENTRY) } }],
    ['there is no known_marketplaces.json', { knownMarketplaces: null }],
    // Claude Code reads extraKnownMarketplaces before known_marketplaces.json, so its update is off already.
    ['extraKnownMarketplaces.thedotmack.autoUpdate is false in Claude Code\'s user settings, over true in known_marketplaces.json', {
      knownMarketplaces: knownMarketplacesWithBackgroundUpdateOn(),
      claudeMemMarketplaceDeclarations: [{ path: USER_SETTINGS, autoUpdate: false }],
    }],
    ['the managed settings declare it with autoUpdate false, replacing the user\'s true whole', {
      knownMarketplaces: knownMarketplacesWithBackgroundUpdateOn(),
      claudeMemMarketplaceDeclarations: [{ path: USER_SETTINGS, autoUpdate: true }, { path: MANAGED_SETTINGS, autoUpdate: false }],
    }],
  ];
  for (const [name, scenario] of nothingToTurnOff) {
    it(`writes nothing, looks for no npx, and clears a reason recorded earlier when ${name}`, async () => {
      const spies = silenceLogger();
      const checkHarness = buildCheckHarness({ ...scenario, state: { promotedFileAndNpmMetadataReadAt: PROVEN_AT, claudeCodeBackgroundUpdateLeftOnReason: NOT_YET_PROVEN } });

      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
      expect(checkHarness.knownMarketplacesWrites).toEqual([]);
      expect(checkHarness.npxLookups()).toBe(0);
      expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: null, claudeCodeBackgroundUpdateLeftOnReason: null });
      expect(turnedOffLogs(spies)).toEqual([]);
      expect(leftOnLogs(spies.info)).toEqual([]);
      expect(stepFailureLogs(spies.warn)).toEqual([]);
    });
  }

  it('makes no extra npm read for an install already up to date while nothing waits for proof', async () => {
    silenceLogger();
    // Nothing to turn off; and turned off this tick, from an earlier proof.
    for (const scenario of [upToDate, backgroundUpdateOn(upToDate)]) {
      const checkHarness = buildCheckHarness(scenario);
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('up-to-date');
      expect(checkHarness.fetches.map((recordedFetch) => recordedFetch.url)).toEqual([PROMOTED_URL]);
    }
  });

  // Every gate that turns auto-update off comes first: a user who turned
  // claude-mem's updater off keeps Claude Code's setting as it is. Gate 3 too:
  // while an attempt is in flight, its supervisor writes the state file.
  const stoppedBeforeTheStep: Array<[string, Scenario, AutoUpdateDecisionName]> = [
    ['CLAUDE_MEM_AUTO_UPDATE=false', { settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } }, 'disabled'],
    ['CLAUDE_MEM_AUTO_UPDATE is "off" (only "true" turns it on)', { settings: { CLAUDE_MEM_AUTO_UPDATE: 'off' } }, 'disabled'],
    ['DISABLE_AUTOUPDATER=1 is in the worker\'s env', { env: { DISABLE_AUTOUPDATER: '1' } }, 'disabled'],
    ['DISABLE_UPDATES=1 is in the worker\'s env', { env: { DISABLE_UPDATES: '1' } }, 'disabled'],
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 is in the worker\'s env', { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }, 'disabled'],
    ['DISABLE_AUTOUPDATER=1 is in the env block of Claude Code\'s user settings', { claudeCodeSettingsEnv: [userSettingsEnv({ DISABLE_AUTOUPDATER: '1' })] }, 'disabled'],
    ['DISABLE_UPDATES=1 is in the env block of Claude Code\'s managed settings', { claudeCodeSettingsEnv: [managedSettingsEnv({ DISABLE_UPDATES: '1' })] }, 'disabled'],
    ['extraKnownMarketplaces.thedotmack.autoUpdate is true in Claude Code\'s user settings', { claudeMemMarketplaceDeclarations: [{ path: USER_SETTINGS, autoUpdate: true }] }, 'disabled'],
    ['CLAUDE_MEM_WORKER_AUTOSTART=false', { settings: { CLAUDE_MEM_WORKER_AUTOSTART: 'false' } }, 'disabled'],
    ['CLAUDE_MEM_WORKER_URL is set', { settings: { CLAUDE_MEM_WORKER_URL: 'http://192.168.1.20:37777' } }, 'disabled'],
    ['CLAUDE_MEM_RUNTIME=server', { settings: { CLAUDE_MEM_RUNTIME: 'server' } }, 'disabled'],
    ['claude-mem is turned off in Claude Code', { pluginState: { ...REGISTERED_PLUGIN_STATE, userSettings: { kind: 'explicitly-disabled', path: USER_SETTINGS } } }, 'disabled'],
    ['claude-mem was uninstalled from Claude Code', { pluginState: { ...REGISTERED_PLUGIN_STATE, registration: { kind: 'not-registered', path: path.join(CLAUDE_CONFIG, 'plugins', 'installed_plugins.json') } } }, 'disabled'],
    ['Claude Code\'s user settings do not parse', { pluginState: { ...REGISTERED_PLUGIN_STATE, userSettings: { kind: 'unreadable', path: USER_SETTINGS, problem: `${USER_SETTINGS} is not valid JSON` } } }, 'disabled'],
    ['claude-mem\'s marketplace entry was added from a git URL', { knownMarketplaces: { thedotmack: { ...claudeMemMarketplaceEntry(true), source: { source: 'git', url: 'https://github.com/thedotmack/claude-mem.git' } } } }, 'disabled'],
    ['there is no install', { install: null }, 'no-install'],
    ['the install is a dev checkout', { install: { root: path.resolve('claude-mem-checkout', 'plugin'), version: '15.13.0', missingDependencies: [] } }, 'not-a-standard-install'],
    ['the installed version is unknown', { install: { root: path.join(MARKETPLACE, 'plugin'), version: null, missingDependencies: [] } }, 'unknown-installed-version'],
    ['an attempt is in flight', { state: inFlightAttemptState(NOW - 10 * MINUTE_MS, LIVE_SUPERVISOR_PID) }, 'attempt-in-flight'],
  ];
  for (const [name, scenario, decision] of stoppedBeforeTheStep) {
    it(`leaves Claude Code's background update as it is, writing only an off decision for doctor, while ${name}`, async () => {
      silenceLogger();
      const checkHarness = buildCheckHarness(backgroundUpdateOn(scenario));

      const result = await runAutoUpdateCheck(checkHarness.deps);
      expect(result.decision).toBe(decision);
      expectKnownMarketplacesNotWritten(checkHarness);
      // While an attempt is in flight its supervisor writes the state file, so nothing is recorded.
      expect(checkHarness.writes).toEqual(decision === 'attempt-in-flight' ? [] : [withOffDecisionRecorded(checkHarness, result)]);
    });
  }

  /** Record, in `order`, each turn-off write and each launch the check makes. */
  const recordTurnOffAndLaunchOrder = (checkHarness: CheckHarness): string[] => {
    const order: string[] = [];
    const write = checkHarness.deps.writeClaudeCodeKnownMarketplaces;
    checkHarness.deps.writeClaudeCodeKnownMarketplaces = (knownMarketplaces) => { order.push('turn-off'); write(knownMarketplaces); };
    const launch = checkHarness.deps.launchSupervisor;
    checkHarness.deps.launchSupervisor = async (versions) => { order.push('launch'); await launch(versions); };
    return order;
  };

  it('leaves it on until a check reads both the promoted file and npm\'s metadata: it says why once, records the reason, and the check that reads both turns it off before it launches the update', async () => {
    const spies = silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven());
    checkHarness.deps.now = () => now;
    const order = recordTurnOffAndLaunchOrder(checkHarness);

    // The step before gate 4 has no proof yet; gate 7 records it, and the step runs again before the launch:
    // the attempt then keeps every later tick at gate 3, so a later tick would turn it off only after the update.
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(order).toEqual(['turn-off', 'launch']);
    expect(checkHarness.knownMarketplacesWrites).toEqual([withClaudeMemBackgroundUpdateOff(knownMarketplacesWithBackgroundUpdateOn())]);
    expect(checkHarness.npxLookups()).toBe(1);
    // known_marketplaces.json is read again for it, after the network reads.
    expect(checkHarness.pluginStateReads()).toBe(2);
    expect(checkHarness.stored()).toMatchObject({
      promotedFileAndNpmMetadataReadAt: NOW,
      claudeCodeBackgroundUpdateTurnedOffAt: NOW,
      claudeCodeBackgroundUpdateLeftOnReason: null,
      lastDecision: { decision: 'apply', decidedAt: NOW },
    });
    expect(leftOnLogs(spies.info).map((call) => call[1])).toEqual([`Left Claude Code's background update on: ${NOT_YET_PROVEN}`]);
    expect(turnedOffLogs(spies)).toHaveLength(1);

    // An hour later there is nothing left to turn off.
    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.knownMarketplacesWrites).toHaveLength(1);
    expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: NOW, claudeCodeBackgroundUpdateLeftOnReason: null });
  });

  it('on the tick that proves the updater, writes back the file as it is after the network reads, keeping what Claude Code wrote meanwhile', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven());
    // Claude Code refreshes its official marketplace while gate 7 waits on npm.
    const rewrittenByClaudeCode = knownMarketplacesWithBackgroundUpdateOn();
    (rewrittenByClaudeCode['claude-plugins-official'] as Record<string, unknown>).lastUpdated = '2026-11-07T12:00:05.000Z';
    const fetchJson = checkHarness.deps.fetchJson;
    checkHarness.deps.fetchJson = async (url, timeoutMs) => {
      if (url === npmVersionMetadataUrl(PROMOTED)) checkHarness.setKnownMarketplaces(rewrittenByClaudeCode);
      return fetchJson(url, timeoutMs);
    };

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(checkHarness.knownMarketplacesWrites).toEqual([withClaudeMemBackgroundUpdateOff(rewrittenByClaudeCode)]);
    expect(JSON.stringify(checkHarness.knownMarketplacesWrites[0])).toBe(JSON.stringify(withClaudeMemBackgroundUpdateOff(rewrittenByClaudeCode)));
  });

  // The same rules as the step before gate 4, on the tick that proves the updater.
  const provingTickLeavesItOn: Array<[string, (checkHarness: CheckHarness) => void, string]> = [
    ['npx is not on the worker\'s PATH', (checkHarness) => { checkHarness.deps.findNpxOnWorkerPath = () => null; }, NPX_NOT_FOUND],
    ['the file cannot be written', (checkHarness) => {
      checkHarness.deps.writeClaudeCodeKnownMarketplaces = () => { throw new Error(`${KNOWN_MARKETPLACES_PATH} is not writable, so it is left as it is: EACCES`); };
    }, `Claude Code's background update of the thedotmack marketplace stays on: ${KNOWN_MARKETPLACES_PATH} is not writable, so it is left as it is: EACCES`],
  ];
  for (const [name, arrange, reason] of provingTickLeavesItOn) {
    it(`on the tick that proves the updater, leaves it on and records why when ${name}, and the update still launches`, async () => {
      silenceLogger();
      const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven());
      arrange(checkHarness);

      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
      expect(checkHarness.knownMarketplacesWrites).toEqual([]);
      expect(checkHarness.launches).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
      expect(checkHarness.stored()).toMatchObject({ promotedFileAndNpmMetadataReadAt: NOW, claudeCodeBackgroundUpdateTurnedOffAt: null, claudeCodeBackgroundUpdateLeftOnReason: reason });
    });
  }

  const provingTickWritesNothing: Array<[string, Scenario, (checkHarness: CheckHarness) => void]> = [
    // Claude Code reads extraKnownMarketplaces first, so its update is off already and nothing waited for proof.
    ['a settings file declares the marketplace with autoUpdate false', backgroundUpdateOnNotYetProven({ claudeMemMarketplaceDeclarations: [{ path: USER_SETTINGS, autoUpdate: false }] }), () => {}],
    ['Claude Code turned it off itself while the network was read', backgroundUpdateOnNotYetProven(), (checkHarness) => {
      const fetchJson = checkHarness.deps.fetchJson;
      checkHarness.deps.fetchJson = async (url, timeoutMs) => {
        if (url === npmVersionMetadataUrl(PROMOTED)) checkHarness.setKnownMarketplaces(withClaudeMemBackgroundUpdateOff(knownMarketplacesWithBackgroundUpdateOn()));
        return fetchJson(url, timeoutMs);
      };
    }],
  ];
  for (const [name, scenario, arrange] of provingTickWritesNothing) {
    it(`on the tick that proves the updater, writes nothing and leaves no reason when ${name}`, async () => {
      silenceLogger();
      const checkHarness = buildCheckHarness(scenario);
      arrange(checkHarness);

      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
      expect(checkHarness.knownMarketplacesWrites).toEqual([]);
      expect(checkHarness.npxLookups()).toBe(0);
      expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: null, claudeCodeBackgroundUpdateLeftOnReason: null });
    });
  }

  // Gate 1's rules for Claude Code's plugin state hold for the second read too:
  // an update launched then would undo the change, as it would at gate 1.
  const changedBetweenTheTwoReads: Array<[string, (checkHarness: CheckHarness) => void, string]> = [
    ['claude-mem\'s marketplace entry is replaced by a fork', (checkHarness) => {
      const forked = knownMarketplacesWithBackgroundUpdateOn();
      (forked.thedotmack as Record<string, unknown>).source = { source: 'github', repo: 'a-fork/claude-mem' };
      checkHarness.setKnownMarketplaces(forked);
    }, 'has source {"source":"github","repo":"a-fork/claude-mem"}, not the one the installer writes'],
    ['claude-mem is turned off in Claude Code', (checkHarness) => {
      const readPluginState = checkHarness.deps.readClaudeCodePluginState;
      checkHarness.deps.readClaudeCodePluginState = () => ({ ...readPluginState(), userSettings: { kind: 'explicitly-disabled', path: USER_SETTINGS } });
    }, 'claude-mem is turned off in Claude Code'],
  ];
  for (const [name, change, reasonPart] of changedBetweenTheTwoReads) {
    it(`on the tick that proves the updater, writes nothing and launches no update when ${name} between the two reads, deciding what gate 1 decides for that state`, async () => {
      silenceLogger();
      let now = NOW;
      const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven());
      checkHarness.deps.now = () => now;
      // The change lands while gate 7 waits on npm: after gate 1's read, before the second one.
      const fetchJson = checkHarness.deps.fetchJson;
      checkHarness.deps.fetchJson = async (url, timeoutMs) => {
        if (url === npmVersionMetadataUrl(PROMOTED)) change(checkHarness);
        return fetchJson(url, timeoutMs);
      };

      const result = await runAutoUpdateCheck(checkHarness.deps);
      expect(result).toEqual({ decision: 'disabled', reason: expect.stringContaining(reasonPart) });
      expect(checkHarness.pluginStateReads()).toBe(2);
      expect(checkHarness.knownMarketplacesWrites).toEqual([]);
      expect(checkHarness.npxLookups()).toBe(0);
      expect(checkHarness.launches).toEqual([]);
      // Recorded for doctor with the rest of this tick's check, as every decision past gate 3 is.
      expect(checkHarness.stored()).toMatchObject({
        lastDecision: { decision: 'disabled', decidedAt: NOW },
        lastNetworkCheckAt: NOW,
        promotedFileAndNpmMetadataReadAt: NOW,
        claudeCodeBackgroundUpdateTurnedOffAt: null,
      });

      // The next tick's gate 1 reads the same state and gives the same decision.
      now = NOW + HOUR_MS;
      expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual(result);
      expect(checkHarness.knownMarketplacesWrites).toEqual([]);
      expect(checkHarness.launches).toEqual([]);
    });
  }

  it('on the tick that proves the updater, turns it off even when the update then waits for the worker to be quiet', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven({ quiet: false }));

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('deferred-busy');
    expect(checkHarness.knownMarketplacesWrites).toEqual([withClaudeMemBackgroundUpdateOff(knownMarketplacesWithBackgroundUpdateOn())]);
    expect(checkHarness.launches).toEqual([]);
    expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: NOW, lastDecision: { decision: 'deferred-busy' } });
  });

  it('on the tick that proves the updater, writes nothing while the worker shuts down', async () => {
    silenceLogger();
    const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven());
    checkHarness.deps.isWorkerShuttingDown = () => true;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('worker-shutting-down');
    expect(checkHarness.knownMarketplacesWrites).toEqual([]);
    expect(checkHarness.launches).toEqual([]);
  });

  it('says why it is left on once per boot, and again after a restart, while no check proves the updater', async () => {
    const spies = silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven({ responses: { [PROMOTED_URL]: new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') } }));
    checkHarness.deps.now = () => now;

    for (let hour = 0; hour < 3; hour++) {
      now = NOW + hour * HOUR_MS;
      await runAutoUpdateCheck(checkHarness.deps);
    }
    expect(leftOnLogs(spies.info)).toHaveLength(1);
    expect(checkHarness.knownMarketplacesWrites).toEqual([]);
    expect(checkHarness.stored().claudeCodeBackgroundUpdateLeftOnReason).toBe(NOT_YET_PROVEN);

    checkHarness.deps.oncePerBootLogsWritten = new Set();
    await runAutoUpdateCheck(checkHarness.deps);
    expect(leftOnLogs(spies.info)).toHaveLength(2);
  });

  it('when the install is already up to date, reads npm\'s metadata for the promoted version once to prove the updater, and the next tick turns it off', async () => {
    silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven(upToDate));
    checkHarness.deps.now = () => now;

    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({ decision: 'up-to-date', installedVersion: INSTALLED, promotedVersion: INSTALLED });
    expect(checkHarness.fetches).toEqual([
      { url: PROMOTED_URL, timeoutMs: AUTO_UPDATE_FETCH_TIMEOUT_MS },
      { url: npmVersionMetadataUrl(INSTALLED), timeoutMs: AUTO_UPDATE_FETCH_TIMEOUT_MS },
    ]);
    expect(checkHarness.stored()).toMatchObject({ promotedFileAndNpmMetadataReadAt: NOW, lastCheckError: null });
    expect(checkHarness.knownMarketplacesWrites).toEqual([]);

    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.knownMarketplacesWrites).toHaveLength(1);
    expect(checkHarness.fetches).toHaveLength(2);
  });

  it('on a network that blocks registry.npmjs.org, leaves it on: the read fails, is the check\'s error, and the next due check reads it again', async () => {
    const spies = silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven({
      responses: { ...upToDate.responses, [npmVersionMetadataUrl(INSTALLED)]: new Error('getaddrinfo ENOTFOUND registry.npmjs.org') },
    }));
    checkHarness.deps.now = () => now;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('up-to-date');
    // A copy: bun's toMatchObject writes its asymmetric matchers into the object it checks, and later ticks read this state.
    expect(structuredClone(checkHarness.stored())).toMatchObject({
      promotedFileAndNpmMetadataReadAt: null,
      lastCheckError: { at: NOW, message: expect.stringContaining('ENOTFOUND registry.npmjs.org') },
      claudeCodeBackgroundUpdateLeftOnReason: NOT_YET_PROVEN,
    });
    expect(npmMetadataLogs(spies).map((call) => call[2])).toEqual([{ promotedVersion: INSTALLED, problem: expect.stringContaining('ENOTFOUND registry.npmjs.org') }]);

    // Not due an hour later: no network, nothing written.
    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.fetches).toHaveLength(2);
    // The next due check reads it again.
    now = NOW + AUTO_UPDATE_CHECK_INTERVAL_MS;
    await runAutoUpdateCheck(checkHarness.deps);
    expect(checkHarness.fetches.map((recordedFetch) => recordedFetch.url)).toEqual([PROMOTED_URL, npmVersionMetadataUrl(INSTALLED), PROMOTED_URL, npmVersionMetadataUrl(INSTALLED)]);
    expect(checkHarness.knownMarketplacesWrites).toEqual([]);
  });

  const provesNothing: Array<[string, Scenario, AutoUpdateDecisionName]> = [
    ['the promoted file cannot be read (gate 5)', { responses: { [PROMOTED_URL]: new Error('connect ETIMEDOUT') } }, 'check-failed'],
    ['npm does not show a newer promoted version published by the workflow (gate 7)', { responses: { [npmVersionMetadataUrl(PROMOTED)]: json({ ...workflowPublishedManifest(PROMOTED), gitHead: undefined }) } }, 'not-published-by-workflow'],
    ['npm\'s metadata for a newer promoted version cannot be read (gate 7)', { responses: { [npmVersionMetadataUrl(PROMOTED)]: json(null, 503) } }, 'check-failed'],
    ['the install is up to date and npm does not show the promoted version published by the workflow (gate 6)', {
      responses: { ...upToDate.responses, [npmVersionMetadataUrl(INSTALLED)]: json({ ...workflowPublishedManifest(INSTALLED), dist: { tarball: 'x' } }) },
    }, 'up-to-date'],
  ];
  for (const [name, scenario, decision] of provesNothing) {
    it(`proves nothing, so the next tick leaves it on too, when ${name}`, async () => {
      silenceLogger();
      let now = NOW;
      const checkHarness = buildCheckHarness(backgroundUpdateOnNotYetProven(scenario));
      checkHarness.deps.now = () => now;

      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe(decision);
      expect(checkHarness.stored().promotedFileAndNpmMetadataReadAt).toBeNull();
      now = NOW + HOUR_MS;
      await runAutoUpdateCheck(checkHarness.deps);
      expect(checkHarness.knownMarketplacesWrites).toEqual([]);
      expect(checkHarness.stored().claudeCodeBackgroundUpdateLeftOnReason).toBe(NOT_YET_PROVEN);
    });
  }

  it('leaves it on while npx is not on the worker\'s PATH, says why once per boot at WARN, records the reason, and turns it off once npx is found', async () => {
    const spies = silenceLogger();
    let now = NOW;
    let npx: string | null = null;
    const checkHarness = buildCheckHarness(backgroundUpdateOn());
    checkHarness.deps.now = () => now;
    checkHarness.deps.findNpxOnWorkerPath = () => npx;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.knownMarketplacesWrites).toEqual([]);
    expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: null, claudeCodeBackgroundUpdateLeftOnReason: NPX_NOT_FOUND });
    expect(leftOnLogs(spies.warn).map((call) => call[1])).toEqual([`Left Claude Code's background update on: ${NPX_NOT_FOUND}`]);
    // The network reads are proven already, so no extra npm read is made for it.
    expect(checkHarness.fetches.map((recordedFetch) => recordedFetch.url)).toEqual([PROMOTED_URL, npmVersionMetadataUrl(PROMOTED)]);

    npx = 'C:\\Program Files\\nodejs\\npx.cmd';
    now = NOW + 2 * HOUR_MS;
    await runAutoUpdateCheck(checkHarness.deps);
    expect(checkHarness.knownMarketplacesWrites).toHaveLength(1);
    expect(checkHarness.stored()).toMatchObject({ claudeCodeBackgroundUpdateTurnedOffAt: NOW + 2 * HOUR_MS, claudeCodeBackgroundUpdateLeftOnReason: null });
  });

  it('logs a write that fails with its stage, at WARN once per boot and then at DEBUG, records the reason and no time, and the tick goes on', async () => {
    const spies = silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness(backgroundUpdateOn());
    checkHarness.deps.now = () => now;
    checkHarness.deps.writeClaudeCodeKnownMarketplaces = () => { throw new Error('EACCES: permission denied, open \'known_marketplaces.json.tmp\''); };

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(checkHarness.stored()).toMatchObject({
      claudeCodeBackgroundUpdateTurnedOffAt: null,
      claudeCodeBackgroundUpdateLeftOnReason: 'Claude Code\'s background update of the thedotmack marketplace stays on: EACCES: permission denied, open \'known_marketplaces.json.tmp\'',
    });
    expect(turnedOffLogs(spies)).toEqual([]);
    expect(stepFailureLogs(spies.warn).map((call) => call[2])).toEqual([{ stage: 'write-claude-code-known-marketplaces', problem: expect.stringContaining('EACCES') }]);

    now = NOW + HOUR_MS;
    await runAutoUpdateCheck(checkHarness.deps);
    expect(stepFailureLogs(spies.warn)).toHaveLength(1);
    expect(stepFailureLogs(spies.debug).map((call) => call[2])).toEqual([{ stage: 'write-claude-code-known-marketplaces', problem: expect.stringContaining('EACCES'), loggedAtWarnEarlierThisBoot: true }]);
    expect(spies.error).not.toHaveBeenCalled();
  });

  it('turns it off again on the next tick when Claude Code writes true back', async () => {
    silenceLogger();
    let now = NOW;
    const checkHarness = buildCheckHarness(backgroundUpdateOn(upToDate));
    checkHarness.deps.now = () => now;

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('up-to-date');
    expect(checkHarness.stored().claudeCodeBackgroundUpdateTurnedOffAt).toBe(NOW);

    // The /plugin screen's Enable auto-update, or an installer from before Phase 4, writes true back.
    checkHarness.setKnownMarketplaces(knownMarketplacesWithBackgroundUpdateOn());
    now = NOW + HOUR_MS;
    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('not-due');
    expect(checkHarness.knownMarketplacesWrites).toHaveLength(2);
    expect(checkHarness.stored().claudeCodeBackgroundUpdateTurnedOffAt).toBe(NOW + HOUR_MS);

    // Off now, so the next tick writes nothing.
    now = NOW + 2 * HOUR_MS;
    await runAutoUpdateCheck(checkHarness.deps);
    expect(checkHarness.knownMarketplacesWrites).toHaveLength(2);
  });
});

describe('turning off Claude Code\'s background update in a real known_marketplaces.json', () => {
  let tempDir: string;
  let fixtureCount = 0;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-known-marketplaces-'));
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  /**
   * A Claude config dir of its own, with claude-mem registered at INSTALLED in
   * installed_plugins.json, no user settings, and `contents` as
   * plugins/known_marketplaces.json (undefined: no file).
   */
  const fixture = (contents?: string) => {
    const root = path.join(tempDir, `config-${++fixtureCount}`);
    const knownMarketplacesFile = path.join(root, 'plugins', 'known_marketplaces.json');
    const installedPluginsFile = path.join(root, 'plugins', 'installed_plugins.json');
    mkdirSync(path.dirname(knownMarketplacesFile), { recursive: true });
    writeFileSync(installedPluginsFile, JSON.stringify({
      version: 2,
      plugins: { 'claude-mem@thedotmack': [{ scope: 'user', installPath: path.join(CACHE_ROOT, INSTALLED), version: INSTALLED }] },
    }));
    if (contents !== undefined) writeFileSync(knownMarketplacesFile, contents);
    return {
      root,
      knownMarketplacesFile,
      pluginStateFiles: { userSettingsPath: path.join(root, 'settings.json'), installedPluginsPath: installedPluginsFile, knownMarketplacesPath: knownMarketplacesFile },
    };
  };

  /**
   * A check harness that reads Claude Code's plugin state and writes
   * known_marketplaces.json with the worker's production effects
   * (worker-service.ts buildAutoUpdateCheckDeps), on a fixture's files.
   */
  const harnessOnFiles = (files: ReturnType<typeof fixture>, scenario: Scenario = {}): CheckHarness => {
    const checkHarness = buildCheckHarness(scenario);
    checkHarness.deps.readClaudeCodePluginState = () => readClaudeCodePluginState(files.pluginStateFiles);
    checkHarness.deps.writeClaudeCodeKnownMarketplaces = (knownMarketplaces) => writeClaudeCodeKnownMarketplacesUnlessReadOnly(files.knownMarketplacesFile, knownMarketplaces);
    return checkHarness;
  };

  /** An earlier check proved claude-mem's updater here. */
  const proven: Scenario = { state: { promotedFileAndNpmMetadataReadAt: PROVEN_AT } };

  /** The file as the installer writes it (writeJsonFileAtomic): two-space JSON and a final newline. */
  const asWritten = (knownMarketplaces: unknown) => `${JSON.stringify(knownMarketplaces, null, 2)}\n`;

  const stepFailureWarnings = (spies: LogSpies) => spies.warn.mock.calls.filter((call) => String(call[1]).startsWith('Could not turn off Claude Code\'s background update'));

  /**
   * A path the operating system will not let this user read or write, as the
   * Claude Code settings tests make one. Tests using it skip on Windows and as
   * root, where a mode does not deny access, as
   * tests/memory/memory-ingest.test.ts does for its unreadable file.
   */
  const permissionsCannotDenyAccess = process.platform === 'win32' || process.getuid?.() === 0;

  /**
   * The installer's own registerMarketplace on a fixture's Claude config
   * (CLAUDE_CONFIG_DIR), with any other variables given set in the
   * environment for the call, which is synchronous, and put back after it.
   */
  const registerMarketplaceIn = async (root: string, env: Record<string, string> = {}) => {
    const { registerMarketplace } = await import('../../../src/npx-cli/commands/install.js');
    const variables = { CLAUDE_CONFIG_DIR: root, ...env };
    const saved = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
    Object.assign(process.env, variables);
    try {
      registerMarketplace();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
  const readRegistered = (files: ReturnType<typeof fixture>) => JSON.parse(readFileSync(files.knownMarketplacesFile, 'utf-8'));
  const fixtureMarketplaceDirectory = (files: ReturnType<typeof fixture>) => path.join(files.root, 'plugins', 'marketplaces', 'thedotmack');

  it('changes only thedotmack.autoUpdate: every other entry, field and key order is written back as read', async () => {
    silenceLogger();
    const files = fixture(asWritten(knownMarketplacesWithBackgroundUpdateOn()));

    expect((await runAutoUpdateCheck(harnessOnFiles(files, proven).deps)).decision).toBe('apply');
    expect(readFileSync(files.knownMarketplacesFile, 'utf-8')).toBe(asWritten(withClaudeMemBackgroundUpdateOff(knownMarketplacesWithBackgroundUpdateOn())));
  });

  it('on the tick that first proves the updater, turns it off in the file before the update launches', async () => {
    silenceLogger();
    const files = fixture(asWritten(knownMarketplacesWithBackgroundUpdateOn()));
    const checkHarness = harnessOnFiles(files);
    let fileWhenLaunched: string | null = null;
    checkHarness.deps.launchSupervisor = async () => { fileWhenLaunched = readFileSync(files.knownMarketplacesFile, 'utf-8'); };

    expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
    expect(fileWhenLaunched).toBe(asWritten(withClaudeMemBackgroundUpdateOff(knownMarketplacesWithBackgroundUpdateOn())));
    expect(checkHarness.stored()).toMatchObject({ promotedFileAndNpmMetadataReadAt: NOW, claudeCodeBackgroundUpdateTurnedOffAt: NOW });
  });

  it.skipIf(permissionsCannotDenyAccess)('on the tick that first proves the updater, leaves a read-only file as it is, and the update still launches', async () => {
    silenceLogger();
    const contents = asWritten(knownMarketplacesWithBackgroundUpdateOn());
    const files = fixture(contents);
    chmodSync(files.knownMarketplacesFile, 0o444);
    try {
      const checkHarness = harnessOnFiles(files);
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
      expect(readFileSync(files.knownMarketplacesFile, 'utf-8')).toBe(contents);
      expect(checkHarness.launches).toEqual([{ targetVersion: PROMOTED, previousVersion: INSTALLED }]);
      expect(checkHarness.stored().claudeCodeBackgroundUpdateLeftOnReason).toContain('is not writable, so it is left as it is');
    } finally {
      chmodSync(files.knownMarketplacesFile, 0o644);
    }
  });

  it('reads a missing file as nothing to do and creates none', async () => {
    const spies = silenceLogger();
    const files = fixture();

    expect(readClaudeCodePluginState(files.pluginStateFiles).knownMarketplaces).toEqual({ kind: 'read', path: files.knownMarketplacesFile, document: null });
    expect((await runAutoUpdateCheck(harnessOnFiles(files, proven).deps)).decision).toBe('apply');
    expect(existsSync(files.knownMarketplacesFile)).toBe(false);
    expect(stepFailureWarnings(spies)).toEqual([]);
  });

  it('reads a file with a UTF-8 byte order mark, which Windows tools add (#3013)', () => {
    const files = fixture(`\uFEFF${JSON.stringify({ thedotmack: claudeMemMarketplaceEntry(true) })}`);
    expect(readClaudeCodePluginState(files.pluginStateFiles).knownMarketplaces)
      .toEqual({ kind: 'read', path: files.knownMarketplacesFile, document: { thedotmack: claudeMemMarketplaceEntry(true) } });
  });

  it('keeps the updater off for a file that is not JSON or not a JSON object (empty, an array, null and text included), on which the installer cannot register the marketplace, and leaves it byte for byte', async () => {
    silenceLogger();
    const unusable: Array<[string, string]> = [
      ['{"thedotmack": {"autoUpdate": true},}', 'is not valid JSON'],
      ['', 'is not valid JSON'],
      ['[{"thedotmack": {"autoUpdate": true}}]', 'does not hold a JSON object'],
      ['null', 'does not hold a JSON object'],
      ['"thedotmack"', 'does not hold a JSON object'],
    ];
    for (const [contents, problem] of unusable) {
      const files = fixture(contents);
      const named = `${files.knownMarketplacesFile} ${problem}`;
      expect(readClaudeCodePluginState(files.pluginStateFiles).knownMarketplaces).toEqual({ kind: 'unreadable', path: files.knownMarketplacesFile, problem: expect.stringContaining(named) });

      const checkHarness = harnessOnFiles(files, proven);
      const result = await runAutoUpdateCheck(checkHarness.deps);
      expect(result).toEqual({
        decision: 'disabled',
        reason: expect.stringContaining(`${named}`),
      });
      expect(readFileSync(files.knownMarketplacesFile, 'utf-8')).toBe(contents);
      expectOnlyTheOffDecisionRecorded(checkHarness, result);
      expect(checkHarness.fetches).toEqual([]);

      // What an update would meet: the installer's registerMarketplace stops on
      // the file (readJsonSafe refuses it, or the entry cannot be set on null
      // or text), or, for an array, writes it back without the marketplace.
      const registrationError = await registerMarketplaceIn(files.root).then(() => null, (error: unknown) => error);
      if (registrationError === null) {
        const writtenBack = readRegistered(files);
        expect(Array.isArray(writtenBack) && !Object.hasOwn(writtenBack, 'thedotmack')).toBe(true);
      } else {
        expect(registrationError).toBeInstanceOf(Error);
      }
    }
  });

  it('keeps the updater off for a path that exists but cannot be read at all: a directory where the file should be', async () => {
    silenceLogger();
    const files = fixture();
    mkdirSync(files.knownMarketplacesFile);

    const checkHarness = harnessOnFiles(files, proven);
    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({
      decision: 'disabled',
      reason: expect.stringContaining(`${files.knownMarketplacesFile} exists but cannot be read`),
    });
    expect(statSync(files.knownMarketplacesFile).isDirectory()).toBe(true);
  });

  it.skipIf(permissionsCannotDenyAccess)('keeps the updater off for a file the operating system will not let it read', async () => {
    silenceLogger();
    const files = fixture(asWritten(knownMarketplacesWithBackgroundUpdateOn()));
    chmodSync(files.knownMarketplacesFile, 0o000);
    try {
      expect(await runAutoUpdateCheck(harnessOnFiles(files, proven).deps)).toEqual({
        decision: 'disabled',
        reason: expect.stringMatching(/exists but cannot be read: .*EACCES/),
      });
    } finally {
      chmodSync(files.knownMarketplacesFile, 0o644);
    }
  });

  it.skipIf(permissionsCannotDenyAccess)('leaves a read-only file as it is, logs it with its stage and records the reason, where the atomic write alone would replace it', async () => {
    const spies = silenceLogger();
    // The atomic write renames over a read-only file: the folder's permissions are all it needs.
    const replacedAnyway = fixture(asWritten(knownMarketplacesWithBackgroundUpdateOn()));
    chmodSync(replacedAnyway.knownMarketplacesFile, 0o444);
    writeJsonFileAtomic(replacedAnyway.knownMarketplacesFile, { replaced: true });
    expect(readRegistered(replacedAnyway)).toEqual({ replaced: true });

    const contents = asWritten(knownMarketplacesWithBackgroundUpdateOn());
    const files = fixture(contents);
    chmodSync(files.knownMarketplacesFile, 0o444);
    try {
      expect(() => writeClaudeCodeKnownMarketplacesUnlessReadOnly(files.knownMarketplacesFile, {})).toThrow(`${files.knownMarketplacesFile} is not writable, so it is left as it is`);
      const checkHarness = harnessOnFiles(files, proven);
      expect((await runAutoUpdateCheck(checkHarness.deps)).decision).toBe('apply');
      expect(readFileSync(files.knownMarketplacesFile, 'utf-8')).toBe(contents);
      expect(statSync(files.knownMarketplacesFile).mode & 0o777).toBe(0o444);
      expect(stepFailureWarnings(spies).map((call) => call[2])).toEqual([{
        stage: 'write-claude-code-known-marketplaces',
        problem: expect.stringContaining(`${files.knownMarketplacesFile} is not writable, so it is left as it is`),
      }]);
      expect(structuredClone(checkHarness.stored())).toMatchObject({
        claudeCodeBackgroundUpdateTurnedOffAt: null,
        claudeCodeBackgroundUpdateLeftOnReason: expect.stringContaining('is not writable, so it is left as it is'),
      });
    } finally {
      chmodSync(files.knownMarketplacesFile, 0o644);
      chmodSync(replacedAnyway.knownMarketplacesFile, 0o644);
    }
  });

  it('never rewrites an entry the user added another way, a full git URL, a #ref or a local path, and keeps the updater off', async () => {
    silenceLogger();
    const userAdded = [
      { ...claudeMemMarketplaceEntry(true), source: { source: 'git', url: 'https://github.com/thedotmack/claude-mem.git' } },
      { ...claudeMemMarketplaceEntry(false), source: { source: 'github', repo: 'thedotmack/claude-mem', ref: 'v15.11.0' } },
      { source: { source: 'directory', path: path.resolve('claude-mem-checkout') }, installLocation: path.resolve('claude-mem-checkout'), lastUpdated: '2026-11-01T09:30:00.000Z' },
    ];
    for (const entry of userAdded) {
      const contents = asWritten({ 'claude-plugins-official': OFFICIAL_MARKETPLACE_ENTRY, thedotmack: entry });
      const files = fixture(contents);
      const checkHarness = harnessOnFiles(files, proven);

      expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({
        decision: 'disabled',
        reason: expect.stringContaining('so it was added another way, and an unattended update would replace it'),
      });
      expect(readFileSync(files.knownMarketplacesFile, 'utf-8')).toBe(contents);
      expect(checkHarness.launches).toEqual([]);
    }
  });

  it('the installer\'s registerMarketplace never changes an existing entry\'s autoUpdate and records true for a new entry, whatever claude-mem\'s updater or Claude Code\'s switches say', async () => {
    silenceLogger();
    const claudeMemEntryWithoutAutoUpdate = claudeMemMarketplaceEntry(false);
    delete claudeMemEntryWithoutAutoUpdate.autoUpdate;
    // [the thedotmack entry before, its autoUpdate after: undefined for not set]
    const existingEntries: Array<[Record<string, unknown>, unknown]> = [
      [claudeMemMarketplaceEntry(true), true],
      [claudeMemMarketplaceEntry(false), false],
      [claudeMemEntryWithoutAutoUpdate, undefined],
      // A value Claude Code does not read as a boolean is kept as it is too.
      [{ ...claudeMemMarketplaceEntry(false), autoUpdate: 'yes' }, 'yes'],
    ];
    // The installer reads none of these: claude-mem's own switch on (as shipped)
    // or off, Claude Code's switch, and an idle exit shorter than the worker's first check.
    const environments: Array<Record<string, string>> = [
      {},
      { CLAUDE_MEM_AUTO_UPDATE: 'true' },
      { CLAUDE_MEM_AUTO_UPDATE: 'false' },
      { DISABLE_AUTOUPDATER: '1' },
      { CLAUDE_MEM_IDLE_EXIT_SEC: '60' },
    ];
    for (const env of environments) {
      for (const [entry, autoUpdateAfter] of existingEntries) {
        const files = fixture(asWritten({ 'claude-plugins-official': OFFICIAL_MARKETPLACE_ENTRY, thedotmack: entry }));
        await registerMarketplaceIn(files.root, env);
        const registered = readRegistered(files);
        expect({ env, entry, autoUpdate: registered.thedotmack.autoUpdate, set: Object.hasOwn(registered.thedotmack, 'autoUpdate') })
          .toEqual({ env, entry, autoUpdate: autoUpdateAfter, set: autoUpdateAfter !== undefined });
        // The rest of the entry is the installer's, and every other marketplace is kept as read.
        expect(registered.thedotmack).toMatchObject({ source: { ...CLAUDE_MEM_MARKETPLACE_SOURCE }, installLocation: fixtureMarketplaceDirectory(files) });
        expect(registered['claude-plugins-official']).toEqual(OFFICIAL_MARKETPLACE_ENTRY);
      }
      // A new entry: no file at all, or one that registers only other marketplaces.
      for (const files of [fixture(), fixture(asWritten({ 'claude-plugins-official': OFFICIAL_MARKETPLACE_ENTRY }))]) {
        await registerMarketplaceIn(files.root, env);
        expect({ env, autoUpdate: readRegistered(files).thedotmack.autoUpdate }).toEqual({ env, autoUpdate: true });
      }
    }
  });

  it('a new install keeps Claude Code\'s update on while claude-mem\'s updater has not shown it works here, the worker alone turns it off once a check has, and a later update keeps it off', async () => {
    silenceLogger();
    const files = fixture();
    await registerMarketplaceIn(files.root);
    const asRegistered = readFileSync(files.knownMarketplacesFile, 'utf-8');
    expect(JSON.parse(asRegistered).thedotmack.autoUpdate).toBe(true);

    // A machine that blocks raw.githubusercontent.com: no check reads the
    // promoted file, so nothing proves claude-mem's updater, and Claude Code's
    // update stays the install's updater.
    const blocked = harnessOnFiles(files, { responses: { [PROMOTED_URL]: new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') } });
    blocked.deps.marketplaceDirectory = () => fixtureMarketplaceDirectory(files);
    expect((await runAutoUpdateCheck(blocked.deps)).decision).toBe('check-failed');
    expect(readFileSync(files.knownMarketplacesFile, 'utf-8')).toBe(asRegistered);
    expect(blocked.stored()).toMatchObject({ promotedFileAndNpmMetadataReadAt: null, claudeCodeBackgroundUpdateTurnedOffAt: null });

    // The next due check reads both the promoted file and npm's metadata, and
    // the worker turns Claude Code's update off before it launches the update.
    const reachable = harnessOnFiles(files, { state: blocked.stored() });
    reachable.deps.marketplaceDirectory = () => fixtureMarketplaceDirectory(files);
    reachable.deps.now = () => NOW + AUTO_UPDATE_CHECK_INTERVAL_MS;
    expect((await runAutoUpdateCheck(reachable.deps)).decision).toBe('apply');
    expect(readRegistered(files).thedotmack.autoUpdate).toBe(false);
    expect(reachable.stored().claudeCodeBackgroundUpdateTurnedOffAt).toBe(NOW + AUTO_UPDATE_CHECK_INTERVAL_MS);

    // The update's own installer run registers the marketplace again, and keeps the worker's false.
    await registerMarketplaceIn(files.root);
    expect(readRegistered(files).thedotmack.autoUpdate).toBe(false);
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
  it('stays off unless CLAUDE_MEM_RUNTIME is worker, read trimmed and in any case', () => {
    for (const runtime of ['server', 'server-beta', '', 'workers']) {
      expect(autoUpdateDisabledReason({ ...SHIPPED_SETTINGS, CLAUDE_MEM_RUNTIME: runtime })).toContain(`CLAUDE_MEM_RUNTIME=${JSON.stringify(runtime)}, not "worker"`);
    }
    for (const runtime of ['worker', ' WORKER ', 'Worker']) {
      expect(autoUpdateDisabledReason({ ...SHIPPED_SETTINGS, CLAUDE_MEM_RUNTIME: runtime })).toBeNull();
    }
    // The shipped default is worker, so an install that never set it updates.
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_RUNTIME).toBe('worker');
  });

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

  it('reads none of Claude Code\'s switches: each waits for Claude Code\'s settings files, where FORCE_AUTOUPDATE_PLUGINS can override it', () => {
    // It reads claude-mem's own settings only; each switch below is read by claudeCodeSwitchInForce, after the files.
    expect(autoUpdateDisabledReason(SHIPPED_SETTINGS)).toBeNull();
    for (const name of ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
      expect(claudeCodeSwitchInForce({ [name]: '1' }, [])).toBe(`${name} is set (Claude Code's switch for no background updates)`);
      expect(claudeCodeSwitchInForce({ [name]: '1' }, [userSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: '1' })])).toBeNull();
    }
  });

  it('reads CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC as on for any non-empty value, 0 and false included', () => {
    for (const value of ['1', '0', 'false', 'FALSE', 'no', ' ']) {
      expect(claudeCodeSwitchInForce({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: value }, []))
        .toBe('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set (Claude Code\'s switch for no background updates)');
    }
    // Only unset or empty leaves it off.
    expect(claudeCodeSwitchInForce({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' }, [])).toBeNull();
    expect(claudeCodeSwitchInForce({}, [])).toBeNull();
  });

  it('each Claude Code switch survives the worker spawn\'s sanitizeEnv and turns auto-update off', () => {
    for (const name of ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
      const workerEnv = sanitizeEnv({ [name]: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/usr/bin' });
      expect(workerEnv[name]).toBe('1');
      expect(claudeCodeSwitchInForce(workerEnv, [])).toBe(`${name} is set (Claude Code's switch for no background updates)`);
    }
  });

  it('FORCE_AUTOUPDATE_PLUGINS survives the worker spawn\'s sanitizeEnv too, so the worker sees the force over every switch', () => {
    const workerEnv = sanitizeEnv({
      DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', FORCE_AUTOUPDATE_PLUGINS: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', PATH: '/usr/bin',
    });
    expect(workerEnv.FORCE_AUTOUPDATE_PLUGINS).toBe('1');
    expect(claudeCodeSwitchInForce(workerEnv, [])).toBeNull();
  });

  it('is on only for "true" (trimmed, any case); "false" and every other value are off', () => {
    const withAutoUpdate = (value: unknown): AutoUpdateSettings => ({ ...SHIPPED_SETTINGS, CLAUDE_MEM_AUTO_UPDATE: value as string });
    for (const value of ['true', ' TRUE ', 'True']) {
      expect(parseAutoUpdateSwitch(value)).toBe('on');
      expect(autoUpdateDisabledReason(withAutoUpdate(value))).toBeNull();
    }
    for (const value of ['false', ' FALSE ']) {
      expect(parseAutoUpdateSwitch(value)).toBe('off');
      expect(autoUpdateDisabledReason(withAutoUpdate(value))).toBe('CLAUDE_MEM_AUTO_UPDATE=false');
    }
    // Values meant as off, values meant as on, and JSON a hand edit can leave behind.
    for (const value of ['0', 'off', 'no', '', 'yes', '1', 0, 1, null]) {
      expect(parseAutoUpdateSwitch(value)).toBe('unrecognised');
      expect(autoUpdateDisabledReason(withAutoUpdate(value))).toContain('(only "true" turns it on)');
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

  it('takes every switch out of force while FORCE_AUTOUPDATE_PLUGINS is 1 wherever it is set, as the plugins/loading docs say', () => {
    const everySwitchOn = [
      userSettingsEnv({ DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' }),
      managedSettingsEnv({ DISABLE_AUTOUPDATER: 'true', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' }),
    ];
    // 1 in the env, or in a settings file (a JSON 1 included), trimmed.
    for (const env of [{ FORCE_AUTOUPDATE_PLUGINS: '1' }, { FORCE_AUTOUPDATE_PLUGINS: ' 1 ' }]) {
      expect(claudeCodeSwitchInForce({ ...env, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, everySwitchOn)).toBeNull();
    }
    expect(claudeCodeSwitchInForce({ DISABLE_UPDATES: '1' }, [...everySwitchOn, managedSettingsEnv({ FORCE_AUTOUPDATE_PLUGINS: 1 })])).toBeNull();
    // DISABLE_UPDATES and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC go out of force too, each alone.
    expect(claudeCodeSwitchInForce({ FORCE_AUTOUPDATE_PLUGINS: '1' }, [userSettingsEnv({ DISABLE_UPDATES: '1' })])).toBeNull();
    expect(claudeCodeSwitchInForce({ FORCE_AUTOUPDATE_PLUGINS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' }, [])).toBeNull();
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
      claudeMemMarketplaceDeclarations: [],
    });
  });

  it('leaves out files and a drop-in directory that do not exist', () => {
    expect(readClaudeCodeSettingsEnvBlocks(fixture('nothing', {}))).toEqual({ envBlocks: [], skipped: [], claudeMemMarketplaceDeclarations: [] });
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
        claudeMemMarketplaceDeclarations: [],
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
        claudeMemMarketplaceDeclarations: [],
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
        claudeMemMarketplaceDeclarations: [],
      });
    }
  });

  /** A settings file that declares claude-mem's marketplace under extraKnownMarketplaces, next to another marketplace. */
  const declaringClaudeMemMarketplace = (autoUpdate?: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
    ...extra,
    extraKnownMarketplaces: {
      thedotmack: { source: { source: 'github', repo: 'thedotmack/claude-mem' }, ...(autoUpdate === undefined ? {} : { autoUpdate }) },
      'acme-tools': { source: { source: 'github', repo: 'acme-corp/claude-plugins' }, autoUpdate: true },
    },
  });

  it('takes extraKnownMarketplaces.thedotmack from each file that declares it, in the order Claude Code merges them, its autoUpdate only when that is a JSON boolean', () => {
    const files = fixture('declarations', {
      'claude-config/settings.json': declaringClaudeMemMarketplace(true),
      'managed/managed-settings.json': declaringClaudeMemMarketplace(),
      'managed/managed-settings.d/20-later.json': declaringClaudeMemMarketplace(false),
      'managed/managed-settings.d/10-earlier.json': declaringClaudeMemMarketplace('true'),
      // Other marketplaces only, an entry that is not an object, and an extraKnownMarketplaces that is not one: none declares it.
      'managed/managed-settings.d/30-other.json': JSON.stringify({ extraKnownMarketplaces: { 'acme-tools': {} } }),
      'managed/managed-settings.d/40-entry-text.json': JSON.stringify({ extraKnownMarketplaces: { thedotmack: 'thedotmack/claude-mem' } }),
      'managed/managed-settings.d/50-key-array.json': JSON.stringify({ extraKnownMarketplaces: ['thedotmack'] }),
    });
    const read = readClaudeCodeSettingsEnvBlocks(files);
    expect(read.claudeMemMarketplaceDeclarations).toEqual([
      { path: files.userSettingsPath, autoUpdate: true },
      { path: files.at('managed/managed-settings.json'), autoUpdate: undefined },
      { path: files.at('managed/managed-settings.d/10-earlier.json'), autoUpdate: undefined },
      { path: files.at('managed/managed-settings.d/20-later.json'), autoUpdate: false },
    ]);
    // The last one read is in force: managed settings over the user's, and a later drop-in over an earlier one, each whole.
    expect(claudeMemMarketplaceDeclarationInForce(read.claudeMemMarketplaceDeclarations)).toEqual({ path: files.at('managed/managed-settings.d/20-later.json'), autoUpdate: false });
    expect(claudeMemMarketplaceDeclarationInForce(read.claudeMemMarketplaceDeclarations.slice(0, 2))).toEqual({ path: files.at('managed/managed-settings.json'), autoUpdate: undefined });
    expect(claudeMemMarketplaceDeclarationInForce([])).toBeNull();
  });

  it('takes the declaration of a file whose env Claude Code drops, since it reads the rest of that file, and none from a user file it runs without', () => {
    const files = fixture('declarations-past-a-dropped-env', {
      // A trailing comma: Claude Code runs without the whole file.
      'claude-config/settings.json': `${declaringClaudeMemMarketplace(false)},`,
      'managed/managed-settings.json': declaringClaudeMemMarketplace(true, { env: 'DISABLE_UPDATES=1' }),
    });
    expect(readClaudeCodeSettingsEnvBlocks(files)).toEqual({
      envBlocks: [],
      skipped: [
        { path: files.userSettingsPath, problem: expect.stringContaining('is not valid JSON') },
        { path: files.at('managed/managed-settings.json'), problem: expect.stringContaining('its env is string, not an object') },
      ],
      claudeMemMarketplaceDeclarations: [{ path: files.at('managed/managed-settings.json'), autoUpdate: true }],
    });
  });

  it('keeps the updater off for extraKnownMarketplaces.thedotmack.autoUpdate true in a real settings file, naming it, reading nothing after it and writing nothing', async () => {
    silenceLogger();
    const userSettings = declaringClaudeMemMarketplace(true);
    const files = fixture('tick-declared-on', { 'claude-config/settings.json': userSettings });
    const checkHarness = buildCheckHarness({ knownMarketplaces: knownMarketplacesWithBackgroundUpdateOn() });
    checkHarness.deps.readClaudeCodeSettingsEnv = () => readClaudeCodeSettingsEnvBlocks(files);

    expect(await runAutoUpdateCheck(checkHarness.deps)).toEqual({
      decision: 'disabled',
      reason: expect.stringContaining(`extraKnownMarketplaces.thedotmack.autoUpdate is true in ${files.userSettingsPath}`),
    });
    expect(checkHarness.pluginStateReads()).toBe(0);
    expect(checkHarness.knownMarketplacesWrites).toEqual([]);
    expect(readFileSync(files.userSettingsPath, 'utf-8')).toBe(userSettings);
  });

  it.skipIf(readDenialCannotBeMade)('skips a managed settings file or drop-in directory the operating system denies, which Claude Code starts without', () => {
    const deniedFile = fixture('managed-read-denied', { 'managed/managed-settings.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }) });
    withReadDenied(deniedFile.at('managed/managed-settings.json'), () => {
      expect(readClaudeCodeSettingsEnvBlocks(deniedFile)).toEqual({
        envBlocks: [],
        skipped: [{ path: deniedFile.at('managed/managed-settings.json'), problem: expect.stringContaining('EACCES') }],
        claudeMemMarketplaceDeclarations: [],
      });
    });
    const deniedDropIns = fixture('managed-drop-ins-denied', { 'managed/managed-settings.d/10-updates.json': JSON.stringify({ env: { DISABLE_UPDATES: '1' } }) });
    withReadDenied(deniedDropIns.at('managed/managed-settings.d'), () => {
      expect(readClaudeCodeSettingsEnvBlocks(deniedDropIns)).toEqual({
        envBlocks: [],
        skipped: [{ path: deniedDropIns.at('managed/managed-settings.d'), problem: expect.stringContaining('exists but cannot be listed') }],
        claudeMemMarketplaceDeclarations: [],
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

describe('readClaudeCodePluginState (Claude Code\'s own files, read as the installer reads them)', () => {
  let tempDir: string;
  let fixtureCount = 0;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-plugin-state-'));
  });

  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  /** A Claude config dir of its own with the given user settings, installed_plugins.json and known_marketplaces.json (undefined: no file). */
  const fixture = (files: { userSettings?: string; installedPlugins?: string; knownMarketplaces?: string }) => {
    const root = path.join(tempDir, `config-${++fixtureCount}`);
    mkdirSync(path.join(root, 'plugins'), { recursive: true });
    const userSettingsPath = path.join(root, 'settings.json');
    const installedPluginsPath = path.join(root, 'plugins', 'installed_plugins.json');
    const knownMarketplacesPath = path.join(root, 'plugins', 'known_marketplaces.json');
    if (files.userSettings !== undefined) writeFileSync(userSettingsPath, files.userSettings);
    if (files.installedPlugins !== undefined) writeFileSync(installedPluginsPath, files.installedPlugins);
    if (files.knownMarketplaces !== undefined) writeFileSync(knownMarketplacesPath, files.knownMarketplaces);
    return { root, userSettingsPath, installedPluginsPath, knownMarketplacesPath };
  };
  const marketplaceDirectoryOf = (files: ReturnType<typeof fixture>) => path.join(files.root, 'plugins', 'marketplaces', 'thedotmack');

  const registered = (version: string) => JSON.stringify({
    version: 2,
    plugins: { 'claude-mem@thedotmack': [{ scope: 'user', installPath: path.join(CACHE_ROOT, version), version }] },
  });

  it('reads the entry the installer\'s own registerPlugin writes as registered, for every host it installs', async () => {
    const { registerPlugin } = await import('../../../src/npx-cli/commands/install.js');
    const files = fixture({});
    const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = files.root;
    try {
      registerPlugin(INSTALLED);
    } finally {
      if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
    }
    const state = readClaudeCodePluginState(files);
    expect(state.registration).toEqual({ kind: 'registered', versions: [INSTALLED] });
    expect(claudeCodePluginStateDisabledReason(state, marketplaceDirectoryOf(files))).toBeNull();
  });

  it('the installer\'s own registerPlugin replaces or adds only the user-scope entry, and keeps every other entry exactly as read, in its place', async () => {
    const { registerPlugin } = await import('../../../src/npx-cli/commands/install.js');
    const registerIn = (files: ReturnType<typeof fixture>, version: string): void => {
      const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = files.root;
      try {
        registerPlugin(version);
      } finally {
        if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
      }
    };
    const written = (files: ReturnType<typeof fixture>) => JSON.parse(readFileSync(files.installedPluginsPath, 'utf-8'));
    const cacheFolderOf = (files: ReturnType<typeof fixture>, version: string) => path.join(files.root, 'plugins', 'cache', 'thedotmack', 'claude-mem', version);
    // What Claude Code writes for a project's and a local install, with fields this installer never writes.
    const claudeCodeEntry = (scope: 'project' | 'local', version: string) => ({
      scope,
      projectPath: `/work/${scope}-project`,
      installPath: path.join(CACHE_ROOT, version),
      version,
      installedAt: '2026-10-01T08:00:00.000Z',
      lastUpdated: '2026-10-02T09:30:00.000Z',
      gitCommitSha: 'a3f1c2d4e5b6a7980c1d2e3f4a5b6c7d8e9f0a1b',
    });
    const userEntryWritten = (files: ReturnType<typeof fixture>, version: string) => ({
      scope: 'user', installPath: cacheFolderOf(files, version), version, installedAt: expect.any(String), lastUpdated: expect.any(String),
    });
    const otherPlugin = { 'other@market': [{ scope: 'user', installPath: '/elsewhere/1.0.0', version: '1.0.0' }] };

    // A user-scope entry between a project's and a local one: replaced where it was.
    const between = fixture({ installedPlugins: JSON.stringify({ version: 2, plugins: { ...otherPlugin, 'claude-mem@thedotmack': [
      claudeCodeEntry('project', '15.10.0'),
      { scope: 'user', installPath: path.join(CACHE_ROOT, '15.10.5'), version: '15.10.5', installedAt: '2026-09-01T00:00:00.000Z', lastUpdated: '2026-09-01T00:00:00.000Z' },
      claudeCodeEntry('local', '15.11.0'),
    ] } }) });
    registerIn(between, INSTALLED);
    expect(written(between)).toEqual({ version: 2, plugins: { ...otherPlugin, 'claude-mem@thedotmack': [
      claudeCodeEntry('project', '15.10.0'),
      userEntryWritten(between, INSTALLED),
      claudeCodeEntry('local', '15.11.0'),
    ] } });

    // No user-scope entry yet (only a project's own install): added after the others.
    const projectOnly = fixture({ installedPlugins: JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [claudeCodeEntry('project', '15.10.0')] } }) });
    registerIn(projectOnly, INSTALLED);
    expect(written(projectOnly).plugins['claude-mem@thedotmack']).toEqual([claudeCodeEntry('project', '15.10.0'), userEntryWritten(projectOnly, INSTALLED)]);
    expect(readClaudeCodePluginState(projectOnly).registration).toEqual({ kind: 'registered', versions: [INSTALLED] });

    // Two user-scope entries left by hand: one remains, where the first was.
    const twoUserEntries = fixture({ installedPlugins: JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [
      { scope: 'user', installPath: path.join(CACHE_ROOT, '15.10.5'), version: '15.10.5' },
      claudeCodeEntry('project', '15.10.0'),
      { scope: 'user', installPath: path.join(CACHE_ROOT, '15.10.6'), version: '15.10.6' },
    ] } }) });
    registerIn(twoUserEntries, INSTALLED);
    expect(written(twoUserEntries).plugins['claude-mem@thedotmack']).toEqual([userEntryWritten(twoUserEntries, INSTALLED), claudeCodeEntry('project', '15.10.0')]);
  });

  it('reads a missing installed_plugins.json, and one without claude-mem, as not registered', () => {
    for (const installedPlugins of [undefined, JSON.stringify({ version: 2, plugins: { 'other@market': [{ installPath: '/x/1.0.0' }] } }), JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [] } })]) {
      const files = fixture({ installedPlugins });
      expect(readClaudeCodePluginState(files).registration).toEqual({ kind: 'not-registered', path: files.installedPluginsPath });
    }
  });

  it('reads only the user-scope entry the npx installer writes: a project\'s own entry at another version is ignored, and alone is not the npx install', () => {
    const projectEntry = (version: string) => ({ scope: 'project', projectPath: '/work/some-project', installPath: path.join(CACHE_ROOT, version), version });
    const userEntry = { scope: 'user', installPath: path.join(CACHE_ROOT, INSTALLED), version: INSTALLED };
    const both = fixture({ installedPlugins: JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [projectEntry('15.10.0'), userEntry] } }) });
    expect(readClaudeCodePluginState(both).registration).toEqual({ kind: 'registered', versions: [INSTALLED] });

    const projectOnly = fixture({ installedPlugins: JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [projectEntry(INSTALLED)] } }) });
    const state = readClaudeCodePluginState(projectOnly);
    expect(state.registration).toEqual({ kind: 'not-registered', path: projectOnly.installedPluginsPath });
    expect(claudeCodePluginStateDisabledReason(state, marketplaceDirectoryOf(projectOnly))).toContain('not registered at user scope');
  });

  it('reports an installed_plugins.json that does not parse (empty included) as unreadable, since registerPlugin would stop on it', () => {
    for (const installedPlugins of ['{"plugins": {', '']) {
      const files = fixture({ installedPlugins });
      const state = readClaudeCodePluginState(files);
      expect(state.registration).toMatchObject({ kind: 'unreadable', path: files.installedPluginsPath, problem: expect.stringContaining('Corrupt JSON file') });
      expect(claudeCodePluginStateDisabledReason(state, marketplaceDirectoryOf(files))).toContain('whether claude-mem is still installed cannot be read');
    }
  });

  it('reads enabledPlugins false for claude-mem in the user settings as turned off, and anything else as not', () => {
    const disabled = fixture({ userSettings: JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': false } }), installedPlugins: registered(INSTALLED) });
    expect(readClaudeCodePluginState(disabled).userSettings).toEqual({ kind: 'explicitly-disabled', path: disabled.userSettingsPath });
    for (const userSettings of [undefined, '{}', JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }), JSON.stringify({ enabledPlugins: { 'other@market': false } }), '\ufeff{"enabledPlugins": {}}']) {
      const files = fixture({ userSettings, installedPlugins: registered(INSTALLED) });
      expect(readClaudeCodePluginState(files)).toEqual({
        userSettings: { kind: 'not-disabled' },
        registration: { kind: 'registered', versions: [INSTALLED] },
        knownMarketplaces: { kind: 'read', path: files.knownMarketplacesPath, document: null },
      });
    }
  });

  it('reports user settings that do not parse as a JSON object (empty included) as unreadable, since enablePluginInClaudeSettings would stop on them', () => {
    for (const userSettings of ['{"enabledPlugins": {', '', '[]']) {
      const files = fixture({ userSettings, installedPlugins: registered(INSTALLED) });
      const state = readClaudeCodePluginState(files);
      expect(state.userSettings).toMatchObject({ kind: 'unreadable', path: files.userSettingsPath });
      expect(claudeCodePluginStateDisabledReason(state, marketplaceDirectoryOf(files))).toContain('whether claude-mem is turned off in Claude Code cannot be read');
    }
  });

  it('keeps the whole known_marketplaces.json as read, and reports one that does not parse as a JSON object (empty and an array included) as unreadable, since registerMarketplace would stop on it', () => {
    const knownMarketplaces = { 'claude-plugins-official': OFFICIAL_MARKETPLACE_ENTRY, thedotmack: claudeMemMarketplaceEntry(true) };
    const readable = fixture({ installedPlugins: registered(INSTALLED), knownMarketplaces: JSON.stringify(knownMarketplaces) });
    expect(readClaudeCodePluginState(readable).knownMarketplaces).toEqual({ kind: 'read', path: readable.knownMarketplacesPath, document: knownMarketplaces });
    for (const [contents, problem] of [['{"thedotmack": {', 'is not valid JSON'], ['', 'is not valid JSON'], ['[]', 'does not hold a JSON object']]) {
      const files = fixture({ installedPlugins: registered(INSTALLED), knownMarketplaces: contents });
      const state = readClaudeCodePluginState(files);
      expect(state.knownMarketplaces).toEqual({ kind: 'unreadable', path: files.knownMarketplacesPath, problem: expect.stringContaining(`${files.knownMarketplacesPath} ${problem}`) });
      expect(claudeCodePluginStateDisabledReason(state, marketplaceDirectoryOf(files))).toContain('so an update could not register the marketplace there');
    }
  });

  it('accepts the marketplace entry the installer\'s own registerMarketplace writes, and only that one', async () => {
    const { registerMarketplace } = await import('../../../src/npx-cli/commands/install.js');
    const files = fixture({ installedPlugins: registered(INSTALLED) });
    const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = files.root;
    try {
      registerMarketplace();
    } finally {
      if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
    }
    const state = readClaudeCodePluginState(files);
    expect(state.knownMarketplaces).toMatchObject({ kind: 'read', document: { thedotmack: { source: { ...CLAUDE_MEM_MARKETPLACE_SOURCE }, installLocation: marketplaceDirectoryOf(files) } } });
    expect(claudeCodePluginStateDisabledReason(state, marketplaceDirectoryOf(files))).toBeNull();
    // The same entry seen from another Claude config dir is another install location.
    expect(claudeCodePluginStateDisabledReason(state, path.join(tempDir, 'another-config', 'plugins', 'marketplaces', 'thedotmack'))).toContain('has installLocation');
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
    expect(autoUpdateDisabledReason(settings)).toBe('CLAUDE_MEM_AUTO_UPDATE=false');
  });

  it('reads CLAUDE_MEM_AUTO_UPDATE off when either the file or the environment has it off: the environment never turns on a saved off', () => {
    // [what settings.json holds (undefined: no key), the environment's value (undefined: unset), the value read]
    const rows: Array<[unknown, string | undefined, string]> = [
      ['true', 'false', 'false'],
      ['false', 'true', 'false'],
      [false, 'TRUE', 'false'],
      ['false', undefined, 'false'],
      [undefined, 'false', 'false'],
      // Any value but true in either place leaves it off, named as it is.
      ['off', 'true', 'off'],
      ['true', 'off', 'off'],
      // Both on, or on where the other has nothing: on.
      ['true', 'true', 'true'],
      [undefined, 'true', 'true'],
      ['true', undefined, 'true'],
      [undefined, undefined, 'true'],
    ];
    rows.forEach(([saved, fromEnv, expected], index) => {
      const settingsPath = settingsFile(`env-and-file-${index}`, JSON.stringify(saved === undefined ? {} : { CLAUDE_MEM_AUTO_UPDATE: saved }));
      const env = fromEnv === undefined ? {} : { CLAUDE_MEM_AUTO_UPDATE: fromEnv };
      expect({ saved, fromEnv, read: readAutoUpdateSettings(settingsPath, env).CLAUDE_MEM_AUTO_UPDATE }).toEqual({ saved, fromEnv, read: expected });
    });
    // The other keys keep the settings manager's rule: the environment over the file.
    const savedUrl = settingsFile('env-over-file-url', JSON.stringify({ CLAUDE_MEM_WORKER_URL: 'http://192.168.1.20:37777' }));
    expect(readAutoUpdateSettings(savedUrl, { CLAUDE_MEM_WORKER_URL: '' }).CLAUDE_MEM_WORKER_URL).toBe('');
  });

  const RELEASE_URL_FROM_THE_ENVIRONMENT = 'https://elsewhere.example/promoted-release.json';

  it('reads the release-switch URL from settings.json alone, never from the environment, and the file may still name a file:// or https URL', () => {
    // [what settings.json holds (undefined: no key), the environment's value (undefined: unset), the value read]
    const rows: Array<[string | undefined, string | undefined, string]> = [
      [undefined, RELEASE_URL_FROM_THE_ENVIRONMENT, ''],
      ['', RELEASE_URL_FROM_THE_ENVIRONMENT, ''],
      ['file:///sandbox/promoted-release.json', RELEASE_URL_FROM_THE_ENVIRONMENT, 'file:///sandbox/promoted-release.json'],
      ['https://127.0.0.1:8443/promoted-release.json', '', 'https://127.0.0.1:8443/promoted-release.json'],
      ['https://127.0.0.1:8443/promoted-release.json', undefined, 'https://127.0.0.1:8443/promoted-release.json'],
    ];
    rows.forEach(([saved, fromEnv, expected], index) => {
      const settingsPath = settingsFile(`release-url-${index}`, JSON.stringify(saved === undefined ? {} : { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: saved }));
      const env = fromEnv === undefined ? {} : { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: fromEnv };
      expect({ saved, fromEnv, read: readAutoUpdateSettings(settingsPath, env).CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL }).toEqual({ saved, fromEnv, read: expected });
    });
    // No settings.json: the shipped empty value, which is the built-in switch.
    const missing = path.join(tempDir, 'release-url-missing', 'settings.json');
    expect(readAutoUpdateSettings(missing, { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: RELEASE_URL_FROM_THE_ENVIRONMENT }).CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL).toBe('');
  });

  it('never fetches the release switch the environment names: the check reads the built-in one, or the file settings.json names', async () => {
    silenceLogger();
    const env = { CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: RELEASE_URL_FROM_THE_ENVIRONMENT };
    const sandboxSwitch = 'file:///sandbox/promoted-release.json';
    // [what settings.json saves, the URL the check fetches]
    const rows: Array<[Record<string, string>, string]> = [[{}, DEFAULT_PROMOTED_RELEASE_URL], [{ CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: sandboxSwitch }, sandboxSwitch]];
    for (const [index, [saved, fetched]] of rows.entries()) {
      const settingsPath = settingsFile(`release-url-fetched-${index}`, JSON.stringify(saved));
      const checkHarness = buildCheckHarness({ responses: { [sandboxSwitch]: json({ schemaVersion: 1, promotedVersion: INSTALLED }) } });
      checkHarness.deps.readSettings = () => readAutoUpdateSettings(settingsPath, env);
      await runAutoUpdateCheck(checkHarness.deps);
      expect(checkHarness.fetches[0].url).toBe(fetched);
      expect(checkHarness.fetches.map((recordedFetch) => recordedFetch.url)).not.toContain(RELEASE_URL_FROM_THE_ENVIRONMENT);
    }
  });

  it('reads the release-switch URL from settings.json alone for the worker\'s tick and doctor\'s row alike, whatever the environment says', async () => {
    silenceLogger();
    const { productionAutoUpdateSwitchReaders } = await import('../../../src/services/auto-update/auto-update-switch-readers.js');
    const { autoUpdateDoctorSources } = await import('../../../src/npx-cli/commands/doctor.js');
    expectClaudeMemSettingsPathOutsideTheRealDataDir();
    // A Claude config of its own, never the real ~/.claude, with claude-mem
    // registered at user scope so gates 1 and 2 read on; Claude Code's managed
    // settings are this folder's.
    const claudeConfig = path.join(tempDir, 'claude-config-for-the-release-url');
    const installRoot = path.join(claudeConfig, 'plugins', 'cache', 'thedotmack', 'claude-mem', INSTALLED);
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(path.join(claudeConfig, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'claude-mem@thedotmack': [{ scope: 'user', installPath: installRoot, version: INSTALLED }] },
    }));
    spyOn(autoUpdateCheckModule, 'claudeCodeManagedSettingsDirectory').mockReturnValue(path.join(claudeConfig, 'managed-settings'));
    const pluginRoot: PluginRootResolution = { root: installRoot, version: INSTALLED, missingDependencies: [] };
    // Every variable these readers take, so the shell running the test cannot change what they read.
    const variables = ['CLAUDE_CONFIG_DIR', ...Object.keys(SHIPPED_SETTINGS), 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'FORCE_AUTOUPDATE_PLUGINS'];
    const savedVariables = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
    const savedSettings = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
    mkdirSync(path.dirname(USER_SETTINGS_PATH), { recursive: true });
    for (const name of variables) delete process.env[name];
    process.env.CLAUDE_CONFIG_DIR = claudeConfig;
    process.env.CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL = RELEASE_URL_FROM_THE_ENVIRONMENT;
    const sandboxSwitch = 'file:///sandbox/promoted-release.json';
    try {
      // [what settings.json saves, the URL each reader reads]
      const rows: Array<[Record<string, string>, string]> = [[{ CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: sandboxSwitch }, sandboxSwitch], [{}, '']];
      for (const [saved, expected] of rows) {
        writeFileSync(USER_SETTINGS_PATH, JSON.stringify(saved));
        const reads = {
          // The worker's tick (worker-service.ts buildAutoUpdateCheckDeps).
          worker: readAutoUpdateSwitches(productionAutoUpdateSwitchReaders({ env: process.env, resolvePluginRoot: () => pluginRoot })),
          // Doctor's Auto-update row.
          doctor: autoUpdateDoctorSources(pluginRoot).readSwitches(),
        };
        const releaseUrlRead = Object.fromEntries(Object.entries(reads).map(([reader, read]) => [reader, read.kind === 'on' ? read.settings.CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL : read]));
        expect({ saved, releaseUrlRead }).toEqual({ saved, releaseUrlRead: { worker: expected, doctor: expected } });
      }
    } finally {
      for (const [name, value] of Object.entries(savedVariables)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (savedSettings === null) rmSync(USER_SETTINGS_PATH, { force: true });
      else writeFileSync(USER_SETTINGS_PATH, savedSettings);
    }
  });

  it('turns it off for the worker\'s tick and doctor\'s row alike when settings.json saves it off and the environment says true', async () => {
    silenceLogger();
    const { productionAutoUpdateSwitchReaders } = await import('../../../src/services/auto-update/auto-update-switch-readers.js');
    const { autoUpdateDoctorSources } = await import('../../../src/npx-cli/commands/doctor.js');
    expectClaudeMemSettingsPathOutsideTheRealDataDir();
    // A Claude config of its own: none of these may read the real ~/.claude, and Claude Code's managed settings are this folder's.
    const claudeConfig = path.join(tempDir, 'claude-config-for-the-readers');
    mkdirSync(path.join(claudeConfig, 'plugins'), { recursive: true });
    spyOn(autoUpdateCheckModule, 'claudeCodeManagedSettingsDirectory').mockReturnValue(path.join(claudeConfig, 'managed-settings'));
    const savedSettings = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;
    const savedVariables = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_MEM_AUTO_UPDATE: process.env.CLAUDE_MEM_AUTO_UPDATE };
    mkdirSync(path.dirname(USER_SETTINGS_PATH), { recursive: true });
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({ CLAUDE_MEM_AUTO_UPDATE: 'false' }));
    process.env.CLAUDE_CONFIG_DIR = claudeConfig;
    process.env.CLAUDE_MEM_AUTO_UPDATE = 'true';
    try {
      const off = { kind: 'off', decision: { decision: 'disabled', reason: 'CLAUDE_MEM_AUTO_UPDATE=false' } };
      // The worker's tick (worker-service.ts buildAutoUpdateCheckDeps).
      expect(readAutoUpdateSwitches(productionAutoUpdateSwitchReaders({ env: process.env, resolvePluginRoot: () => null }))).toEqual(off);
      // Doctor's Auto-update row.
      expect(autoUpdateDoctorSources(null).readSwitches()).toEqual(off);
    } finally {
      for (const [name, value] of Object.entries(savedVariables)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (savedSettings === null) rmSync(USER_SETTINGS_PATH, { force: true });
      else writeFileSync(USER_SETTINGS_PATH, savedSettings);
    }
  });

  it('turns off from settings.json, also when written as a JSON boolean', () => {
    const settingsPath = settingsFile('boolean', JSON.stringify({ CLAUDE_MEM_AUTO_UPDATE: false }));
    expect(autoUpdateDisabledReason(readAutoUpdateSettings(settingsPath, {}))).toBe('CLAUDE_MEM_AUTO_UPDATE=false');
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
      expect(autoUpdateDisabledReason(readAutoUpdateSettings(settingsPath, {}))).toBe(`CLAUDE_MEM_AUTO_UPDATE="${numberValue}" (only "true" turns it on)`);
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
