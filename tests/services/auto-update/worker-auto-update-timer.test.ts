import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { WorkerService } from '../../../src/services/worker-service.js';
import { CorpusRoutes } from '../../../src/services/worker/http/routes/CorpusRoutes.js';
import { WorkViewRoutes } from '../../../src/services/worker/http/routes/WorkViewRoutes.js';
import * as telegramWrapupNotifier from '../../../src/services/integrations/TelegramWrapupNotifier.js';
import * as autoUpdateCheck from '../../../src/services/auto-update/auto-update-check.js';
import {
  AUTO_UPDATE_FIRST_TICK_DELAY_MS,
  AUTO_UPDATE_QUIET_WINDOW_MS,
  AUTO_UPDATE_TICK_INTERVAL_MS,
  claudeCodeManagedSettingsDirectory,
  fetchJsonWithTimeout,
  npmVersionMetadataUrl,
  readAutoUpdateSettings,
  readClaudeCodeSettingsEnvBlocks,
  runAutoUpdateCheck,
  type AutoUpdateCheckDeps,
  type AutoUpdateSettings,
  type FetchJsonResult,
} from '../../../src/services/auto-update/auto-update-check.js';
import { autoUpdateStatePath, defaultAutoUpdateState, type AutoUpdateState } from '../../../src/services/auto-update/auto-update-state.js';
import { FORBID_REAL_AUTO_UPDATE_ENV } from '../../../src/services/auto-update/auto-update-launch.js';
import * as autoUpdateLaunch from '../../../src/services/auto-update/auto-update-launch.js';
import * as spawnModule from '../../../src/shared/spawn.js';
import { claudeSettingsPath, installedPluginsPath, marketplaceDirectory, pluginCacheRootDirectory } from '../../../src/npx-cli/utils/paths.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { USER_SETTINGS_PATH } from '../../../src/shared/paths.js';
import * as supervisor from '../../../src/supervisor/index.js';
import * as processRegistry from '../../../src/supervisor/process-registry.js';
import * as processManager from '../../../src/services/infrastructure/ProcessManager.js';
import * as portReclaim from '../../../src/shared/port-reclaim.js';
import * as telemetry from '../../../src/services/telemetry/telemetry.js';
import { logger } from '../../../src/utils/logger.js';

// WorkerService.startAutoUpdateTimer wires the check to the worker. These tests
// run it on a bare prototype (no database, providers or HTTP server unless a
// test adds one) with captured timers. A tick that passes the off switches is
// given its install, state and network by the test, and CLAUDE_CONFIG_DIR
// points at a temp dir, so none reads the real ~/.claude or reaches the network.

const MINUTE_MS = 60 * 1000;
const INSTALLED = '15.11.0';
const PROMOTED = '15.12.0';

const SHIPPED_SETTINGS: AutoUpdateSettings = {
  CLAUDE_MEM_AUTO_UPDATE: 'true',
  CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: '',
  CLAUDE_MEM_WORKER_AUTOSTART: 'true',
  CLAUDE_MEM_WORKER_URL: '',
  CLAUDE_MEM_RUNTIME: 'worker',
};

// Project-local scratch (gitignored), never the system temp folder, as in
// tests/worker/http/routes/setup-state-routes.test.ts.
const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');

let claudeConfigDir: string;
let savedClaudeConfigDir: string | undefined;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  claudeConfigDir = mkdtempSync(path.join(scratchRoot, 'auto-update-worker-claude-config-'));
  savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  // claude-mem installed in that Claude config, the way the installer registers it (install.ts registerPlugin).
  mkdirSync(path.dirname(installedPluginsPath()), { recursive: true });
  writeFileSync(installedPluginsPath(), JSON.stringify({
    version: 2,
    plugins: { 'claude-mem@thedotmack': [{ scope: 'user', installPath: path.join(pluginCacheRootDirectory(), INSTALLED), version: INSTALLED }] },
  }));
});

afterAll(() => {
  if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  rmSync(claudeConfigDir, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(path.join(claudeConfigDir, 'settings.json'), { recursive: true, force: true });
  mock.restore();
});

function buildWorkerFixture() {
  const worker = Object.create(WorkerService.prototype) as any;
  const signals = {
    sessionActivity: false,
    newestCapturedActivityAt: null as number | null,
    queueDepth: 0,
    inFlightRequests: 0,
    viewerStreams: 0,
    myWorkStreams: 0,
    myWorkBackgroundWork: [] as string[],
    cardWordingRequests: 0,
    corpusBuilds: 0,
    sessionWrapups: 0,
  };
  const sessionCutoffs: number[] = [];
  Object.assign(worker, {
    isShuttingDown: false,
    autoUpdateTimer: null,
    sessionManager: {
      hasSessionActivitySince: (cutoffMs: number) => { sessionCutoffs.push(cutoffMs); return signals.sessionActivity; },
      getTotalQueueDepth: () => signals.queueDepth,
      getSessionWrapupsInFlight: () => signals.sessionWrapups,
    },
    dbManager: { getSessionStore: () => ({ getNewestCapturedActivityEpoch: () => signals.newestCapturedActivityAt }) },
    server: {
      getInFlightRequestCount: () => signals.inFlightRequests,
      getLastRequestAt: () => { throw new Error('the auto-updater must not read the last-request time'); },
    },
    sseBroadcaster: { getClientCount: () => signals.viewerStreams },
    workViewRoutes: {
      getClientCount: () => signals.myWorkStreams,
      backgroundWorkRunning: () => signals.myWorkBackgroundWork,
      cardWordingRequestsRunning: () => signals.cardWordingRequests,
    },
    corpusRoutes: { corpusBuildsRunning: () => signals.corpusBuilds },
  });

  const timeouts: Array<{ callback: () => void; delayMs: number }> = [];
  const intervals: Array<{ callback: () => void; delayMs: number }> = [];
  const unrefs: string[] = [];
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delayMs: number) => {
    timeouts.push({ callback, delayMs });
    return { unref() { unrefs.push('first tick'); } };
  }) as any);
  spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delayMs: number) => {
    intervals.push({ callback, delayMs });
    return { unref() { unrefs.push('hourly tick'); } };
  }) as any);
  const cleared = { timeouts: 0, intervals: 0 };
  spyOn(globalThis, 'clearTimeout').mockImplementation((() => { cleared.timeouts++; }) as any);
  spyOn(globalThis, 'clearInterval').mockImplementation((() => { cleared.intervals++; }) as any);

  const info = spyOn(logger, 'info').mockImplementation(() => {});
  const error = spyOn(logger, 'error').mockImplementation(() => {});
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  const debug = spyOn(logger, 'debug').mockImplementation(() => {});
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('no network in this test');
  }) as any);
  // Off by default, so a tick stops at the off switch unless a test turns it on.
  const readSettings = spyOn(autoUpdateCheck, 'readAutoUpdateSettings').mockImplementation((() => ({
    ...SHIPPED_SETTINGS,
    CLAUDE_MEM_AUTO_UPDATE: 'false',
  })) as any);

  return { worker, signals, sessionCutoffs, timeouts, intervals, unrefs, cleared, info, warn, debug, error, fetchSpy, readSettings };
}

/** Let a fire-and-forget tick settle; the disabled path awaits nothing but promises. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

const decisionLines = (spy: ReturnType<typeof spyOn>, name: string) =>
  spy.mock.calls.filter((call) => call[1] === `Auto-update decision: ${name}`);

const json = (body: unknown): FetchJsonResult => ({ ok: true, status: 200, body });

/** Claude Code's settings env blocks as the worker reads them, with the managed directory moved into the test's temp dir. */
const readTestClaudeCodeSettingsEnv = () => readClaudeCodeSettingsEnvBlocks({
  userSettingsPath: claudeSettingsPath(),
  managedSettingsDirectory: path.join(claudeConfigDir, 'no-managed-settings'),
});

/**
 * The worker's own deps for one tick, with auto-update on and the install,
 * state and network supplied here. Claude Code's user settings are read from
 * the test's CLAUDE_CONFIG_DIR and its managed settings from a directory
 * there that does not exist, so a managed policy on the machine running the
 * test cannot change the outcome. The quiet signals and the liveness probe
 * stay the worker's. The launch is recorded here: the worker's own launcher
 * refuses under the test tripwire (tests/preload.ts), which the
 * buildAutoUpdateCheckDeps tests below prove.
 */
function workerTickDeps(worker: any, overrides: Partial<AutoUpdateCheckDeps> = {}): AutoUpdateCheckDeps & { stored: () => AutoUpdateState } {
  let stored = defaultAutoUpdateState();
  const deps: AutoUpdateCheckDeps = {
    ...(worker.buildAutoUpdateCheckDeps(new Set()) as AutoUpdateCheckDeps),
    launchSupervisor: async () => {},
    readClaudeCodeSettingsEnv: readTestClaudeCodeSettingsEnv,
    readSettings: () => SHIPPED_SETTINGS,
    resolvePluginRoot: () => ({ root: path.join(pluginCacheRootDirectory(), INSTALLED), version: INSTALLED, missingDependencies: [] }),
    readState: () => structuredClone(stored),
    writeState: (state) => { stored = structuredClone(state); },
    fetchJson: async (url) => url === npmVersionMetadataUrl(PROMOTED)
      ? json({ name: 'claude-mem', version: PROMOTED, gitHead: 'eb00299a6', dist: { attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } })
      : json({ schemaVersion: 1, promotedVersion: PROMOTED }),
    ...overrides,
  };
  return Object.assign(deps, { stored: () => stored });
}

describe('WorkerService.startAutoUpdateTimer', () => {
  it('runs the first check 5 minutes after start, then one an hour, never holding the event loop open', () => {
    const workerFixture = buildWorkerFixture();
    workerFixture.worker.startAutoUpdateTimer();
    expect(workerFixture.timeouts.map((timer) => timer.delayMs)).toEqual([AUTO_UPDATE_FIRST_TICK_DELAY_MS]);
    expect(AUTO_UPDATE_FIRST_TICK_DELAY_MS).toBe(5 * 60 * 1000);
    expect(workerFixture.unrefs).toEqual(['first tick']);

    workerFixture.timeouts[0].callback();
    expect(workerFixture.intervals.map((timer) => timer.delayMs)).toEqual([AUTO_UPDATE_TICK_INTERVAL_MS]);
    expect(AUTO_UPDATE_TICK_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(workerFixture.unrefs).toEqual(['first tick', 'hourly tick']);

    workerFixture.worker.startAutoUpdateTimer();
    expect(workerFixture.timeouts).toHaveLength(1);
  });

  it('never starts during shutdown, and stop clears whichever timer is armed', () => {
    const workerFixture = buildWorkerFixture();
    workerFixture.worker.isShuttingDown = true;
    workerFixture.worker.startAutoUpdateTimer();
    expect(workerFixture.timeouts).toHaveLength(0);

    workerFixture.worker.isShuttingDown = false;
    workerFixture.worker.startAutoUpdateTimer();
    workerFixture.worker.stopAutoUpdateTimer();
    expect(workerFixture.cleared).toEqual({ timeouts: 1, intervals: 1 });
    expect(workerFixture.worker.autoUpdateTimer).toBeNull();
  });

  it('re-reads settings on every tick and logs "disabled" once per boot', async () => {
    const workerFixture = buildWorkerFixture();
    workerFixture.worker.startAutoUpdateTimer();
    workerFixture.timeouts[0].callback();
    await settle();
    workerFixture.intervals[0].callback();
    await settle();

    expect(workerFixture.readSettings.mock.calls.map((call) => call[0])).toEqual([USER_SETTINGS_PATH, USER_SETTINGS_PATH]);
    expect(decisionLines(workerFixture.info, 'disabled')).toHaveLength(1);
    expect(workerFixture.fetchSpy).not.toHaveBeenCalled();
    expect(workerFixture.error).not.toHaveBeenCalled();
  });

  it('logs a failing tick at ERROR with its stage, every time, and keeps running', async () => {
    const workerFixture = buildWorkerFixture();
    const realDeps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
    spyOn(workerFixture.worker, 'buildAutoUpdateCheckDeps').mockImplementation((() => ({
      ...realDeps,
      readSettings: () => SHIPPED_SETTINGS,
      readClaudeCodeSettingsEnv: readTestClaudeCodeSettingsEnv,
      resolvePluginRoot: () => { throw new Error('EACCES: permission denied'); },
    })) as any);

    workerFixture.worker.startAutoUpdateTimer();
    workerFixture.timeouts[0].callback();
    await settle();

    expect(workerFixture.error).toHaveBeenCalledTimes(1);
    expect(workerFixture.error.mock.calls[0][2]).toEqual({ stage: 'resolve-plugin-root' });
    expect(workerFixture.intervals).toHaveLength(1);
    // Only a broken settings file is logged at ERROR once per boot; this stage is logged each time.
    workerFixture.intervals[0].callback();
    await settle();
    expect(workerFixture.error).toHaveBeenCalledTimes(2);
  });

  it('skips a Claude Code user settings file it cannot parse for its switches, warns once per boot naming it, and stays off because the installer would stop on it', async () => {
    const workerFixture = buildWorkerFixture();
    // Claude Code's user settings, found through CLAUDE_CONFIG_DIR, with a trailing comma: Claude Code runs without it.
    writeFileSync(claudeSettingsPath(), '{"env": {"DISABLE_AUTOUPDATER": "1"},}');
    const realDeps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
    const pluginRootLookups = mock(() => null);
    spyOn(workerFixture.worker, 'buildAutoUpdateCheckDeps').mockImplementation(((oncePerBootLogsWritten: Set<string>) => ({
      ...realDeps,
      readSettings: () => SHIPPED_SETTINGS,
      readClaudeCodeSettingsEnv: readTestClaudeCodeSettingsEnv,
      resolvePluginRoot: pluginRootLookups,
      oncePerBootLogsWritten,
    })) as any);
    const skippedWarnings = () => workerFixture.warn.mock.calls.filter((call) => String(call[1]).startsWith('Skipped the Claude Code settings at'));

    workerFixture.worker.startAutoUpdateTimer();
    workerFixture.timeouts[0].callback();
    await settle();
    workerFixture.intervals[0].callback();
    await settle();

    expect(workerFixture.error).not.toHaveBeenCalled();
    expect(skippedWarnings()).toHaveLength(1);
    expect(skippedWarnings()[0][1]).toContain(claudeSettingsPath());
    expect(skippedWarnings()[0][2]).toEqual({ path: claudeSettingsPath(), problem: expect.stringContaining('is not valid JSON') });
    // Its DISABLE_AUTOUPDATER is not in force. The file still keeps the updater
    // off: an update would stop on it (install.ts enablePluginInClaudeSettings
    // refuses to overwrite a corrupt file), so neither tick reaches the install.
    const disabledLines = decisionLines(workerFixture.info, 'disabled');
    expect(disabledLines).toHaveLength(1);
    expect(disabledLines[0][2]).toEqual({ reason: expect.stringContaining(`${claudeSettingsPath()} is not valid JSON`) });
    expect(String((disabledLines[0][2] as { reason: string }).reason)).not.toContain('DISABLE_AUTOUPDATER');
    expect(pluginRootLookups).not.toHaveBeenCalled();
  });

  describe('an unreadable settings.json', () => {
    let tempDir: string;
    let unreadableSettingsPath: string;

    beforeAll(() => {
      tempDir = mkdtempSync(path.join(scratchRoot, 'auto-update-timer-'));
      unreadableSettingsPath = path.join(tempDir, 'settings.json');
      writeFileSync(unreadableSettingsPath, '{"CLAUDE_MEM_AUTO_UPDATE": "false",');
    });

    afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

    it('logs that ERROR once per boot and each later tick it stops at DEBUG, so the file sends one exception event a boot', async () => {
      const workerFixture = buildWorkerFixture();
      workerFixture.readSettings.mockRestore();
      const realDeps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
      const pluginRootLookups = mock(() => null);
      spyOn(workerFixture.worker, 'buildAutoUpdateCheckDeps').mockImplementation(((oncePerBootLogsWritten: Set<string>) => ({
        ...realDeps,
        readSettings: () => readAutoUpdateSettings(unreadableSettingsPath),
        resolvePluginRoot: pluginRootLookups,
        oncePerBootLogsWritten,
      })) as any);
      const failedTickLines = (spy: ReturnType<typeof spyOn>) =>
        spy.mock.calls.filter((call) => call[1] === 'Auto-update check failed; the next tick tries again');

      workerFixture.worker.startAutoUpdateTimer();
      workerFixture.timeouts[0].callback();
      await settle();
      for (let hour = 0; hour < 2; hour++) {
        workerFixture.intervals[0].callback();
        await settle();
      }

      // Every tick still stops at read-settings: fail closed.
      expect(failedTickLines(workerFixture.error).map((call) => call[2])).toEqual([{ stage: 'read-settings' }]);
      expect(failedTickLines(workerFixture.debug).map((call) => call[2])).toEqual([
        { stage: 'read-settings', loggedAtErrorEarlierThisBoot: true },
        { stage: 'read-settings', loggedAtErrorEarlierThisBoot: true },
      ]);
      expect(String(failedTickLines(workerFixture.debug)[1][3])).toContain(`${unreadableSettingsPath} exists but cannot be read as settings`);
      expect(pluginRootLookups).not.toHaveBeenCalled();
      expect(workerFixture.fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe('WorkerService.start', () => {
  /** The real start() with every boot effect around the timer stubbed: supervisor, PID file, heartbeat, telemetry. */
  function buildStartFixture(initializeBackground: () => Promise<void>) {
    const workerFixture = buildWorkerFixture();
    const bootSteps: string[] = [];
    const listen = mock(async () => { bootSteps.push('listen'); });
    Object.assign(workerFixture.worker, {
      tvToken: '',
      server: { ...workerFixture.worker.server, listen, getLastResponseFinishedAt: () => 0 },
      detectPreviousShutdown: () => {},
      initializeBackground: mock(() => { bootSteps.push('initializeBackground'); return initializeBackground(); }),
    });
    const startAutoUpdateTimer = workerFixture.worker.startAutoUpdateTimer.bind(workerFixture.worker);
    workerFixture.worker.startAutoUpdateTimer = () => { bootSteps.push('startAutoUpdateTimer'); startAutoUpdateTimer(); };
    spyOn(supervisor, 'startSupervisor').mockResolvedValue(undefined as any);
    spyOn(supervisor, 'getSupervisor').mockReturnValue({ registerProcess: () => {} } as any);
    spyOn(processManager, 'writePidFile').mockImplementation(() => {});
    spyOn(portReclaim, 'startWorkerHeartbeat').mockImplementation((() => {}) as any);
    spyOn(telemetry, 'enableExceptionAutocaptureForWorker').mockImplementation(() => {});
    spyOn(processRegistry, 'setRegistryDegradedReporter').mockImplementation(() => {});
    spyOn(logger, 'setErrorSink').mockImplementation(() => {});
    return { ...workerFixture, bootSteps, listen };
  }

  it('arms the auto-update timer as soon as the server listens, while background initialization has not finished', async () => {
    const startFixture = buildStartFixture(() => new Promise<void>(() => {}));
    await startFixture.worker.start();

    expect(startFixture.bootSteps).toEqual(['listen', 'startAutoUpdateTimer', 'initializeBackground']);
    expect(startFixture.timeouts.map((timer) => timer.delayMs)).toContain(AUTO_UPDATE_FIRST_TICK_DELAY_MS);
    expect(startFixture.worker.autoUpdateTimer).not.toBeNull();
  });

  it('keeps it armed when background initialization fails', async () => {
    const startFixture = buildStartFixture(async () => { throw new Error('SQLITE_IOERR during migrations'); });
    await startFixture.worker.start();
    await settle();

    expect(startFixture.error.mock.calls.map((call) => call[1])).toContain('Background initialization failed');
    expect(startFixture.worker.autoUpdateTimer).not.toBeNull();
    // Its first tick runs on that worker.
    const firstTick = startFixture.timeouts.find((timer) => timer.delayMs === AUTO_UPDATE_FIRST_TICK_DELAY_MS)!;
    firstTick.callback();
    await settle();
    expect(startFixture.readSettings).toHaveBeenCalledWith(USER_SETTINGS_PATH);
  });
});

describe('WorkerService.buildAutoUpdateCheckDeps', () => {
  it('wires the production effects and reads the settings when the tick asks', () => {
    const workerFixture = buildWorkerFixture();
    const readSettingsFiles = spyOn(autoUpdateCheck, 'readClaudeCodeSettingsEnvBlocks').mockImplementation(() => ({ envBlocks: [], skipped: [], claudeMemMarketplaceDeclarations: [] }));
    const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
    expect(deps.fetchJson).toBe(fetchJsonWithTimeout);
    expect(deps.pluginCacheRootDirectory).toBe(pluginCacheRootDirectory);
    expect(deps.marketplaceDirectory).toBe(marketplaceDirectory);
    expect(deps.isProcessAlive).toBe(processRegistry.isPidAlive);
    expect(deps.env).toBe(process.env);
    expect(workerFixture.readSettings).not.toHaveBeenCalled();
    expect(deps.readSettings().CLAUDE_MEM_AUTO_UPDATE).toBe('false');
    expect(workerFixture.readSettings).toHaveBeenCalledWith(USER_SETTINGS_PATH);

    // Claude Code's user settings through CLAUDE_CONFIG_DIR, and its managed settings at the platform path.
    expect(readSettingsFiles).not.toHaveBeenCalled();
    deps.readClaudeCodeSettingsEnv();
    expect(readSettingsFiles.mock.calls).toEqual([[{
      userSettingsPath: path.join(claudeConfigDir, 'settings.json'),
      managedSettingsDirectory: claudeCodeManagedSettingsDirectory(),
    }]]);

    // claude-mem's own entries in Claude Code's files, known_marketplaces.json (the file install.ts
    // registerMarketplace writes) included, through CLAUDE_CONFIG_DIR too.
    const knownMarketplacesFile = path.join(claudeConfigDir, 'plugins', 'known_marketplaces.json');
    const readPluginState = spyOn(autoUpdateCheck, 'readClaudeCodePluginState');
    expect(deps.readClaudeCodePluginState()).toEqual({
      userSettings: { kind: 'not-disabled' },
      registration: { kind: 'registered', versions: [INSTALLED] },
      knownMarketplaces: { kind: 'read', path: knownMarketplacesFile, document: null },
    });
    expect(readPluginState.mock.calls).toEqual([[{
      userSettingsPath: path.join(claudeConfigDir, 'settings.json'),
      installedPluginsPath: path.join(claudeConfigDir, 'plugins', 'installed_plugins.json'),
      knownMarketplacesPath: knownMarketplacesFile,
    }]]);

    // Written back at the same path, through the writer that leaves a read-only file alone.
    const writeKnownMarketplaces = spyOn(autoUpdateCheck, 'writeClaudeCodeKnownMarketplacesUnlessReadOnly').mockImplementation(() => {});
    deps.writeClaudeCodeKnownMarketplaces({ thedotmack: { autoUpdate: false } });
    expect(writeKnownMarketplaces.mock.calls).toEqual([[knownMarketplacesFile, { thedotmack: { autoUpdate: false } }]]);

    // npx looked up the way the supervisor's installer run finds it.
    const findNpx = spyOn(autoUpdateLaunch, 'findNpxForTheInstaller').mockImplementation(() => '/opt/node/bin/npx');
    expect(deps.findNpxOnWorkerPath()).toBe('/opt/node/bin/npx');
    expect(findNpx.mock.calls).toEqual([[]]);
  });

  it('gives gate 3 the supervisor\'s readings of an interrupted attempt', () => {
    const workerFixture = buildWorkerFixture();
    // Stubbed, so nothing reads the real install.
    const reader = async () => ({ kind: 'on-previous-version' as const, where: 'stub' });
    const readerFactory = spyOn(autoUpdateLaunch, 'workerInterruptedAttemptReader').mockImplementation(() => reader);
    const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
    expect(readerFactory.mock.calls).toEqual([[]]);
    expect(deps.readInterruptedAttemptInstall).toBe(reader);
  });

  it('sends the outcomes the worker records itself through telemetry\'s captureEvent', () => {
    const workerFixture = buildWorkerFixture();
    const captured = spyOn(telemetry, 'captureEvent').mockImplementation(() => {});
    const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
    deps.captureEvent('auto_update_failed', { failure_stage: 'supervisor-never-started' });
    expect(captured.mock.calls).toEqual([['auto_update_failed', { failure_stage: 'supervisor-never-started' }]]);
  });

  it('reads "quiet" from session activity, the newest prompt or tool use, queued work, open requests and background work, never the last-request time', () => {
    const workerFixture = buildWorkerFixture();
    const nowMs = Date.UTC(2026, 10, 7, 12, 0, 0);
    spyOn(Date, 'now').mockImplementation(() => nowMs);
    const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());

    expect(deps.isWorkerQuiet()).toBe(true);
    expect(workerFixture.sessionCutoffs).toEqual([nowMs - AUTO_UPDATE_QUIET_WINDOW_MS]);

    workerFixture.signals.sessionActivity = true;
    expect(deps.isWorkerQuiet()).toBe(false);
    workerFixture.signals.sessionActivity = false;
    workerFixture.signals.newestCapturedActivityAt = nowMs - 6 * MINUTE_MS;
    expect(deps.isWorkerQuiet()).toBe(false);
    workerFixture.signals.newestCapturedActivityAt = nowMs - AUTO_UPDATE_QUIET_WINDOW_MS;
    expect(deps.isWorkerQuiet()).toBe(true);
    workerFixture.signals.queueDepth = 1;
    expect(deps.isWorkerQuiet()).toBe(false);
    workerFixture.signals.queueDepth = 0;
    workerFixture.signals.inFlightRequests = 1; // a slow search, say
    expect(deps.isWorkerQuiet()).toBe(false);
    workerFixture.signals.inFlightRequests = 0;
    workerFixture.signals.myWorkBackgroundWork = ['extraction'];
    expect(deps.isWorkerQuiet()).toBe(false);
  });

  it('leaves open viewer and My Work tabs out of "busy", with the count the idle-exit monitor gets', () => {
    const workerFixture = buildWorkerFixture();
    const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());

    // A viewer tab and a My Work tab, each holding its event stream open.
    Object.assign(workerFixture.signals, { inFlightRequests: 2, viewerStreams: 1, myWorkStreams: 1 });
    expect(deps.isWorkerQuiet()).toBe(true);
    expect(workerFixture.worker.viewerEventStreamClientCount()).toBe(2);

    // One more open request is work.
    workerFixture.signals.inFlightRequests = 3;
    expect(deps.isWorkerQuiet()).toBe(false);
  });

  it('reports the worker\'s shutdown flag to the check', () => {
    const workerFixture = buildWorkerFixture();
    const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
    expect(deps.isWorkerShuttingDown()).toBe(false);
    workerFixture.worker.isShuttingDown = true;
    expect(deps.isWorkerShuttingDown()).toBe(true);
  });

  it('launches through the real launcher, which the test tripwire stops before it writes the state or starts a process', async () => {
    const workerFixture = buildWorkerFixture();
    const stateBefore = existsSync(autoUpdateStatePath()) ? readFileSync(autoUpdateStatePath(), 'utf-8') : null;
    const startedProcesses = spyOn(spawnModule, 'spawnHidden');
    const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());

    expect(process.env[FORBID_REAL_AUTO_UPDATE_ENV]).toBe('1');
    await expect(deps.launchSupervisor({ targetVersion: '15.12.0', previousVersion: '15.11.0' }))
      .rejects.toThrow(`Refusing to launch an auto-update supervisor: ${FORBID_REAL_AUTO_UPDATE_ENV} is set`);
    expect(startedProcesses).not.toHaveBeenCalled();
    expect(existsSync(autoUpdateStatePath()) ? readFileSync(autoUpdateStatePath(), 'utf-8') : null).toBe(stateBefore);
    expect(workerFixture.fetchSpy).not.toHaveBeenCalled();
  });

  it('a full tick that reaches gate 9 with the worker\'s own launcher ends launch-failed under the tripwire, the version not blocked', async () => {
    const workerFixture = buildWorkerFixture();
    const startedProcesses = spyOn(spawnModule, 'spawnHidden');
    const deps = workerTickDeps(workerFixture.worker, {
      launchSupervisor: (workerFixture.worker.buildAutoUpdateCheckDeps(new Set()) as AutoUpdateCheckDeps).launchSupervisor,
    });

    const decision = await runAutoUpdateCheck(deps);

    expect(decision).toMatchObject({ decision: 'launch-failed', targetVersion: PROMOTED, previousVersion: INSTALLED });
    expect((decision as { message: string }).message).toContain(FORBID_REAL_AUTO_UPDATE_ENV);
    expect(deps.stored().inFlightAttempt).toBeNull();
    expect(deps.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'launch-supervisor' });
    expect(deps.stored().versionsThatFailedToApply).toEqual([]);
    expect(startedProcesses).not.toHaveBeenCalled();
  });

  it('reads busy on the first tick after a worker restart when a prompt came 6 minutes ago', async () => {
    const workerFixture = buildWorkerFixture();
    // A restarted worker: the real session manager, its session map empty.
    workerFixture.worker.sessionManager = new SessionManager({} as any);
    // The prompt is in the database, which outlives the restart.
    const store = new SessionStore(':memory:');
    try {
      store.createSDKSession('content-session-1', 'project', 'first prompt');
      store.saveUserPrompt('content-session-1', 1, 'fix the flaky test', undefined, undefined, undefined, Date.now() - 6 * MINUTE_MS);
      workerFixture.worker.dbManager = { getSessionStore: () => store };
      const deps = workerTickDeps(workerFixture.worker);

      expect(workerFixture.worker.sessionManager.hasSessionActivitySince(Date.now() - AUTO_UPDATE_QUIET_WINDOW_MS)).toBe(false);
      expect(await runAutoUpdateCheck(deps)).toMatchObject({ decision: 'deferred-busy', promotedVersion: PROMOTED });
      expect(deps.stored().busyDeferralStartedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('counts My Work\'s extraction run and history import as busy, the work the installer waits for before a restart', async () => {
    const workerFixture = buildWorkerFixture();
    for (const running of [['extraction'], ['history-import']]) {
      workerFixture.signals.myWorkBackgroundWork = running;
      expect((await runAutoUpdateCheck(workerTickDeps(workerFixture.worker))).decision).toBe('deferred-busy');
    }
    workerFixture.signals.myWorkBackgroundWork = [];
    expect((await runAutoUpdateCheck(workerTickDeps(workerFixture.worker))).decision).toBe('apply');
  });

  it('reads the extraction run from My Work\'s own rule: an automatic refresh this or another live worker is running', () => {
    const workerFixture = buildWorkerFixture();
    let refreshStatus: Record<string, unknown> | null = { state: 'running', pid: process.pid };
    // The options tests/worker/http/routes/setup-state-routes.test.ts builds My Work's routes with.
    const routes = new WorkViewRoutes({
      databasePath: path.join(import.meta.dir, '..', '..', 'fixtures', 'prompt-import', 'home', 'no-work-state.db'),
      reviewPath: ':memory:', pollIntervalMs: 20, humanCopy: null, ledgerDir: null, setupScan: null,
      setupStatePath: path.join(claudeConfigDir, 'setup-state.json'), settingsPath: path.join(claudeConfigDir, 'claude-mem-settings.json'),
      autoRefresh: { status: () => refreshStatus, start() {}, close() {}, async runNow() { return 'idle'; } } as never,
    });
    try {
      workerFixture.worker.workViewRoutes = routes;
      const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());
      expect(routes.backgroundWorkRunning({ countScanWaitingForUploadAnswer: false })).toEqual(['extraction']);
      expect(deps.isWorkerQuiet()).toBe(false);
      // Finished, or left 'running' by a worker that is gone.
      refreshStatus = { state: 'ok', pid: process.pid };
      expect(deps.isWorkerQuiet()).toBe(true);
    } finally {
      routes.close();
    }
  });

  it('counts the setup scan as busy only in the phases where it works, not held at the upload question', () => {
    const workerFixture = buildWorkerFixture();
    // The options tests/worker/http/routes/setup-state-routes.test.ts builds My Work's routes with.
    const routes = new WorkViewRoutes({
      databasePath: path.join(import.meta.dir, '..', '..', 'fixtures', 'prompt-import', 'home', 'no-work-state.db'),
      reviewPath: ':memory:', pollIntervalMs: 20, humanCopy: null, ledgerDir: null, setupScan: null, autoRefresh: null,
      setupStatePath: path.join(claudeConfigDir, 'setup-state.json'), settingsPath: path.join(claudeConfigDir, 'claude-mem-settings.json'),
    });
    try {
      // A scan in a given phase, set the way setup-state-routes.test.ts sets one for setupIsActive.
      let phase = 'awaiting-consent';
      (routes as unknown as { setupScan: unknown }).setupScan = { state: () => ({ phase }) };
      workerFixture.worker.workViewRoutes = routes;
      const deps: AutoUpdateCheckDeps = workerFixture.worker.buildAutoUpdateCheckDeps(new Set());

      // Held at "upload your prompts?": nothing runs, in memory with no time limit, and a restart drops it anyway.
      expect(workerFixture.worker.runningBackgroundJobNames()).toEqual([]);
      expect(deps.isWorkerQuiet()).toBe(true);
      for (phase of ['reading', 'checking', 'saving', 'uploading']) {
        expect(workerFixture.worker.runningBackgroundJobNames()).toEqual(['extraction']);
        expect(deps.isWorkerQuiet()).toBe(false);
      }
      for (phase of ['idle', 'done', 'failed']) expect(deps.isWorkerQuiet()).toBe(true);
    } finally {
      routes.close();
    }
  });

  it('counts My Work\'s card wording, a corpus build and a Telegram wrap-up as busy', async () => {
    const workerFixture = buildWorkerFixture();
    for (const job of ['cardWordingRequests', 'corpusBuilds', 'sessionWrapups'] as const) {
      workerFixture.signals[job] = 1;
      const deps = workerTickDeps(workerFixture.worker);
      expect(workerFixture.worker.runningBackgroundJobNames()).toHaveLength(1);
      expect((await runAutoUpdateCheck(deps)).decision).toBe('deferred-busy');
      workerFixture.signals[job] = 0;
    }
    expect(workerFixture.worker.runningBackgroundJobNames()).toEqual([]);
    workerFixture.signals.cardWordingRequests = 2;
    workerFixture.signals.corpusBuilds = 1;
    workerFixture.signals.sessionWrapups = 1;
    workerFixture.signals.myWorkBackgroundWork = ['history-import'];
    expect(workerFixture.worker.runningBackgroundJobNames()).toEqual(['history-import', 'my-work-card-wording', 'corpus-build', 'telegram-session-wrapup']);
  });

  it('reads a worker whose startup has not opened the database, or not mounted My Work, as busy, and logs what is missing', async () => {
    const workerFixture = buildWorkerFixture();
    const busyWarnings = () => workerFixture.warn.mock.calls.filter((call) => call[1] === 'Could not read whether the worker is busy; treating it as busy');

    // Startup has not reached the database (or failed before it).
    workerFixture.worker.dbManager = new DatabaseManager();
    expect(await runAutoUpdateCheck(workerTickDeps(workerFixture.worker))).toMatchObject({ decision: 'deferred-busy' });
    expect(busyWarnings().at(-1)?.[2]).toEqual({ cause: 'Database not initialized' });

    // The database is open, but My Work's routes were never mounted.
    workerFixture.worker.dbManager = { getSessionStore: () => ({ getNewestCapturedActivityEpoch: () => null }) };
    const myWorkRoutes = workerFixture.worker.workViewRoutes;
    workerFixture.worker.workViewRoutes = null;
    expect(await runAutoUpdateCheck(workerTickDeps(workerFixture.worker))).toMatchObject({ decision: 'deferred-busy' });
    expect(String(busyWarnings().at(-1)?.[2]?.cause)).toContain('My Work\'s routes are not mounted');

    // My Work is up, but startup stopped before the corpus routes were registered.
    workerFixture.worker.workViewRoutes = myWorkRoutes;
    workerFixture.worker.corpusRoutes = null;
    expect(await runAutoUpdateCheck(workerTickDeps(workerFixture.worker))).toMatchObject({ decision: 'deferred-busy' });
    expect(String(busyWarnings().at(-1)?.[2]?.cause)).toContain('The corpus routes are not registered');
    expect(busyWarnings()).toHaveLength(3);
  });
});

describe('the long-running jobs the quiet check reads', () => {
  /** A corpus route's handler, with a request whose client can leave (copied from corpus-rebuild-guard.test.ts). */
  function corpusRoute(routes: CorpusRoutes, routePath: string, params: Record<string, string>, body: unknown) {
    let handler!: (req: Request, res: Response) => void;
    routes.setupRoutes({
      get: mock(() => {}),
      delete: mock(() => {}),
      post: mock((registeredPath: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
        if (registeredPath === routePath) handler = handlers[handlers.length - 1];
      }),
    } as any);
    const closeListeners: Array<() => void> = [];
    const listen = (event: string, listener: () => void) => { if (event === 'close') closeListeners.push(listener); };
    const end = mock(() => {});
    const req = { body, params, path: routePath, query: {}, headers: {}, socket: { on: listen, off: mock(() => {}) } } as unknown as Request;
    const res = { json: mock(() => {}), status: mock(() => ({ json: mock(() => {}) })), headersSent: false, on: listen, off: mock(() => {}), end } as unknown as Response;
    return { run: () => handler(req, res), clientLeaves: () => { for (const listener of closeListeners) listener(); }, end };
  }

  const corpusFile = (name: string) => ({
    version: 1 as const, name, description: '', created_at: '', updated_at: '', filter: {},
    stats: { observation_count: 3, token_estimate: 0, date_range: { earliest: '', latest: '' }, type_breakdown: {} },
    system_prompt: '', session_id: null, observations: [],
  });

  it('counts a corpus build and a rebuild until they settle, also after their client has left', async () => {
    spyOn(logger, 'info').mockImplementation(() => {});
    const finishBuild: Array<() => void> = [];
    const build = mock((name: string) => new Promise((resolve) => { finishBuild.push(() => resolve(corpusFile(name))); }));
    const routes = new CorpusRoutes(
      { read: mock(() => corpusFile('existing')), write: mock(() => {}), list: mock(() => []), delete: mock(() => false) } as any,
      { build } as any,
      {} as any,
    );
    const building = corpusRoute(routes, '/api/corpus', {}, { name: 'new' });
    const rebuilding = corpusRoute(routes, '/api/corpus/:name/rebuild', { name: 'existing' }, {});
    expect(routes.corpusBuildsRunning()).toBe(0);

    building.run();
    rebuilding.run();
    await settle();
    expect(build).toHaveBeenCalledTimes(2);
    expect(routes.corpusBuildsRunning()).toBe(2);

    // The client leaves: the server stops counting the request, the build keeps going.
    building.clientLeaves();
    await settle();
    expect(routes.corpusBuildsRunning()).toBe(2);

    for (const finish of finishBuild) finish();
    await settle();
    expect(routes.corpusBuildsRunning()).toBe(0);
    expect(building.end).toHaveBeenCalled();
  });

  it('counts a Telegram session wrap-up until it settles, whether it is sent or fails', async () => {
    spyOn(logger, 'warn').mockImplementation(() => {});
    const settleWrapup: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    spyOn(telegramWrapupNotifier, 'deliverSessionWrapup').mockImplementation((() => new Promise((resolve, reject) => {
      settleWrapup.push({ resolve: () => resolve('sent'), reject });
    })) as any);
    const sessionManager = new SessionManager({ getSessionStore: () => ({}) } as any);
    sessionManager.setTelegramWrapupFormatter((async () => 'summary') as any);

    // No session in the map: the wrap-up is delivered now.
    await sessionManager.requestSessionWrapup(41);
    await sessionManager.requestSessionWrapup(42);
    expect(sessionManager.getSessionWrapupsInFlight()).toBe(2);
    settleWrapup[0].resolve();
    settleWrapup[1].reject(new Error('Telegram answered 502'));
    await settle();
    expect(sessionManager.getSessionWrapupsInFlight()).toBe(0);
  });

  it('leaves no wrap-up counted when the database read that starts one throws', async () => {
    const deliver = spyOn(telegramWrapupNotifier, 'deliverSessionWrapup');
    const sessionManager = new SessionManager({ getSessionStore: () => { throw new Error('Database not initialized'); } } as any);
    sessionManager.setTelegramWrapupFormatter((async () => 'summary') as any);
    await expect(sessionManager.requestSessionWrapup(41)).rejects.toThrow('Database not initialized');
    expect(deliver).not.toHaveBeenCalled();
    expect(sessionManager.getSessionWrapupsInFlight()).toBe(0);
  });

  it('reads My Work\'s card-wording requests from its copy worker, none without one', () => {
    const options = {
      databasePath: path.join(import.meta.dir, '..', '..', 'fixtures', 'prompt-import', 'home', 'no-work-state.db'),
      reviewPath: ':memory:', pollIntervalMs: 20, ledgerDir: null, setupScan: null, autoRefresh: null,
      setupStatePath: path.join(claudeConfigDir, 'setup-state.json'), settingsPath: path.join(claudeConfigDir, 'claude-mem-settings.json'),
    };
    let generating = 2;
    const humanCopy = {
      status: () => ({ cached: 0, queued: 3, generating, failures: [], revision: 0 }),
      pauseWhile() {}, load: async () => {}, start() {}, close() {}, observe: (view: unknown) => view,
    };
    const withCopy = new WorkViewRoutes({ ...options, humanCopy: humanCopy as never });
    const withoutCopy = new WorkViewRoutes({ ...options, humanCopy: null });
    try {
      expect(withCopy.cardWordingRequestsRunning()).toBe(2);
      generating = 0;
      expect(withCopy.cardWordingRequestsRunning()).toBe(0);
      expect(withoutCopy.cardWordingRequestsRunning()).toBe(0);
    } finally {
      withCopy.close();
      withoutCopy.close();
    }
  });
});

describe('SessionStore.getNewestCapturedActivityEpoch', () => {
  let store: SessionStore;

  afterEach(() => store?.close());

  it('is null for a database with no prompt and no tool use', () => {
    store = new SessionStore(':memory:');
    expect(store.getNewestCapturedActivityEpoch()).toBeNull();
  });

  it('is the newest of this device\'s prompts and captured tool uses', () => {
    store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession('content-session-1', 'project', 'first prompt');
    store.saveUserPrompt('content-session-1', 1, 'first', sessionDbId, undefined, undefined, 1_000);
    store.saveUserPrompt('content-session-1', 2, 'second', sessionDbId, undefined, undefined, 2_000);
    expect(store.getNewestCapturedActivityEpoch()).toBe(2_000);

    store.upsertToolUse({ toolUseId: 'tool-use-1', contentSessionId: 'content-session-1', sessionDbId, project: 'project', toolName: 'Read', createdAtEpoch: 3_000 });
    expect(store.getNewestCapturedActivityEpoch()).toBe(3_000);
  });

  it('leaves out prompts synced from another device', () => {
    store = new SessionStore(':memory:');
    store.saveUserPrompt('content-session-1', 1, 'here', undefined, undefined, undefined, 1_000);
    store.db.prepare(`INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, origin_device_id, origin_local_id)
      VALUES ('content-session-2', 1, 'on the laptop', 'x', 9000, 'other-device', '17')`).run();
    expect(store.getNewestCapturedActivityEpoch()).toBe(1_000);
  });
});
