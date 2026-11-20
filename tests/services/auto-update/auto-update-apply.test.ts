import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import {
  applyAutoUpdate,
  AUTO_UPDATE_FORWARD_FIX_COMMAND,
  autoUpdateFixCommand,
  readInterruptedAttemptInstall,
  writeOrphanedMarker,
  type AutoUpdateApplyAttempt,
  type AutoUpdateApplyDeps,
  type AutoUpdateInstallerRun,
  type InterruptedAttemptReadingDeps,
  type MarketplaceCopyRead,
} from '../../../src/services/auto-update/auto-update-apply.js';
import type { NpmPublicationRead } from '../../../src/services/auto-update/auto-update-check.js';
import { autoUpdateInstallerFolder, autoUpdateInstallerRunFolderName, readDatabaseSchemaStamp, readInstallVersions, runAutoUpdateInstaller } from '../../../src/services/auto-update/auto-update-launch.js';
import { registerPlugin } from '../../../src/npx-cli/commands/install.js';
import { defaultAutoUpdateState, type AutoUpdateState } from '../../../src/services/auto-update/auto-update-state.js';
import { LATEST_SCHEMA_VERSION } from '../../../src/services/sqlite/connection.js';
import { scrubProperties } from '../../../src/services/telemetry/scrub.js';
import { commandInvocation } from '../../../src/shared/spawn.js';
import { isPidAlive } from '../../../src/supervisor/process-registry.js';
import { logger } from '../../../src/utils/logger.js';

// applyAutoUpdate with every effect injected, over a real install laid out in
// a scratch folder the way the installer lays it out: cache/<version> folders
// with and without their dependencies, the marketplace copy, Claude Code's
// installed_plugins.json, `.orphaned_at` markers and a SQLite database. The
// three version readings are the production readers (readInstallVersions:
// the resolver, the registration reader, the marketplace package.json), the
// marker writer and the schema-stamp reader are the production ones too, and
// every registration an installer run leaves is written by the installer's
// own registerPlugin.
// Each scripted installer changes that layout the way a real run would. Only
// the worker is simulated: its pid, version and startup phase, judged by the
// production proof's rule (restart-verify.ts verifyWorkerFinishedStarting,
// tested on its own against a real HTTP server). Nothing here runs npx or
// touches the real ~/.claude; the tests that need a real process tree run a
// harmless Bun script.

const MINUTE_MS = 60 * 1000;
const TARGET = '15.13.0';
const PREVIOUS = '15.12.0';
const NEWER = '15.14.0';
const STARTED_AT = Date.UTC(2026, 10, 8, 10, 0, 0);
/** Five minutes into the attempt, when the scripted supervisor finishes. */
const NOW = STARTED_AT + 5 * MINUTE_MS;
const SUPERVISOR_PID = 5151;
const OLD_WORKER_PID = 7001;
/** The one runtime dependency each scratch plugin declares; without it in node_modules the resolver skips that folder. */
const PLUGIN_DEPENDENCY = 'shell-quote';
/**
 * Per-test limit for the tests that run a real process tree: the stand-in
 * installer is killed at a 2 s deadline, then waited on for 1 s.
 */
const REAL_PROCESS_TEST_TIMEOUT_MS = 30_000;

const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
let runDirectory: string;
let installCount = 0;
let savedWorkerScriptOverride: string | undefined;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  runDirectory = mkdtempSync(path.join(scratchRoot, 'auto-update-apply-'));
  // The resolver's opt-in override would win over the scratch layout.
  savedWorkerScriptOverride = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
});

afterAll(() => {
  if (savedWorkerScriptOverride !== undefined) process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = savedWorkerScriptOverride;
  rmSync(runDirectory, { recursive: true, force: true });
});

afterEach(() => {
  mock.restore();
});

const attempt: AutoUpdateApplyAttempt = { targetVersion: TARGET, previousVersion: PREVIOUS, startedAt: STARTED_AT };

/** The worker's record before the supervisor starts (auto-update-launch.ts launchAutoUpdateSupervisor). */
const launchedState = (): AutoUpdateState => ({
  ...defaultAutoUpdateState(),
  lastNetworkCheckAt: STARTED_AT,
  lastSeenPromotedVersion: TARGET,
  inFlightAttempt: { targetVersion: TARGET, previousVersion: PREVIOUS, startedAt: STARTED_AT, supervisorPid: null },
});

// ─── The scratch install ───────────────────────────────────────────────────

interface ScratchInstall {
  root: string;
  /** The scratch Claude config directory (CLAUDE_CONFIG_DIR) the paths below are in. */
  claudeConfig: string;
  cacheRoot: string;
  marketplaceRoot: string;
  installedPluginsFile: string;
  databasePath: string;
}

function createScratchInstall(): ScratchInstall {
  const root = path.join(runDirectory, `install-${++installCount}`);
  const claudeConfig = path.join(root, 'claude-config');
  const install: ScratchInstall = {
    root,
    claudeConfig,
    cacheRoot: path.join(claudeConfig, 'plugins', 'cache', 'thedotmack', 'claude-mem'),
    marketplaceRoot: path.join(claudeConfig, 'plugins', 'marketplaces', 'thedotmack'),
    installedPluginsFile: path.join(claudeConfig, 'plugins', 'installed_plugins.json'),
    databasePath: path.join(root, 'claude-mem-data', 'claude-mem.db'),
  };
  mkdirSync(install.cacheRoot, { recursive: true });
  mkdirSync(path.dirname(install.databasePath), { recursive: true });
  return install;
}

type Dependencies = 'installed' | 'missing';

/** A plugin folder the way the installer copies it (scripts, its plugin manifest and package.json), with the node_modules `bun install` adds when 'installed'. */
function writePluginFolder(directory: string, version: string, dependencies: Dependencies): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  mkdirSync(path.join(directory, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(directory, 'scripts', 'worker-service.cjs'), '// stand-in worker script\n');
  writeFileSync(path.join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-mem', version }));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'claude-mem-plugin', version, dependencies: { [PLUGIN_DEPENDENCY]: '1.9.0' } }));
  if (dependencies === 'installed') {
    mkdirSync(path.join(directory, 'node_modules', PLUGIN_DEPENDENCY), { recursive: true });
    writeFileSync(path.join(directory, 'node_modules', PLUGIN_DEPENDENCY, 'package.json'), JSON.stringify({ name: PLUGIN_DEPENDENCY, version: '1.9.0' }));
  }
}

/** cache/<version>, as install.ts copyPluginToCache writes it. */
function writeCacheVersion(install: ScratchInstall, version: string, dependencies: Dependencies): void {
  writePluginFolder(path.join(install.cacheRoot, version), version, dependencies);
}

/** The marketplace copy, as install.ts copyPluginToMarketplace writes it: the package's package.json at its root, the plugin under plugin/. */
function writeMarketplaceCopy(install: ScratchInstall, version: string, dependencies: Dependencies): void {
  writePluginFolder(path.join(install.marketplaceRoot, 'plugin'), version, dependencies);
  writeFileSync(path.join(install.marketplaceRoot, 'package.json'), JSON.stringify({ name: 'claude-mem', version }));
}

/**
 * installed_plugins.json as an installer run of `version` leaves it: the
 * installer's own registerPlugin (install.ts), run on the scratch Claude
 * config, which replaces or adds only its user-scope entry and keeps every
 * other entry as it read it. CLAUDE_CONFIG_DIR is set only for the call,
 * which is synchronous.
 */
function writeRegistration(install: ScratchInstall, version: string): void {
  const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = install.claudeConfig;
  try {
    registerPlugin(version);
  } finally {
    if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  }
}

/** An entry Claude Code writes for a project's or a local install of claude-mem, at a version of its own. */
function registrationClaudeCodeWrote(install: ScratchInstall, scope: 'project' | 'local', version: string): Record<string, unknown> {
  return {
    scope,
    projectPath: path.join(install.root, `${scope}-project`),
    installPath: path.join(install.cacheRoot, version),
    version,
    installedAt: '2026-10-01T08:00:00.000Z',
    lastUpdated: '2026-10-01T08:00:00.000Z',
    gitCommitSha: 'a3f1c2d4e5b6a7980c1d2e3f4a5b6c7d8e9f0a1b',
  };
}

/** installed_plugins.json holding only entries Claude Code wrote itself, before any npx install registered claude-mem. */
function writeRegistrationsClaudeCodeWrote(install: ScratchInstall, entries: Array<Record<string, unknown>>): void {
  writeFileSync(install.installedPluginsFile, JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': entries } }));
}

/** claude-mem@thedotmack's entries in the scratch installed_plugins.json, as written. */
function readRegistrationEntries(install: ScratchInstall): unknown[] {
  return JSON.parse(readFileSync(install.installedPluginsFile, 'utf-8')).plugins['claude-mem@thedotmack'];
}

/** A complete install of `version`: what a finished `npx claude-mem@<version> update` leaves. */
function writeCompleteInstall(install: ScratchInstall, version: string): void {
  writeMarketplaceCopy(install, version, 'installed');
  writeCacheVersion(install, version, 'installed');
  writeRegistration(install, version);
}

/** A SQLite database whose schema stamp (PRAGMA user_version) is `schemaVersion`, as a worker leaves it. */
function writeDatabaseStamped(install: ScratchInstall, schemaVersion: number): void {
  const database = new Database(install.databasePath, { create: true });
  try {
    database.run('PRAGMA journal_mode = WAL');
    database.run(`PRAGMA user_version = ${schemaVersion}`);
  } finally {
    database.close();
  }
}

const readScratchInstallVersions = (install: ScratchInstall) => readInstallVersions({
  searchRoots: { cacheRoot: install.cacheRoot, marketplaceRoot: install.marketplaceRoot, cwd: install.root },
  installedPluginsFile: install.installedPluginsFile,
});

// ─── The simulated worker and the scripted installers ──────────────────────

type StartupPhase = 'ready' | 'starting' | 'failed';

interface SimulatedWorld {
  install: ScratchInstall;
  /**
   * The worker process, null when none runs. `answers: false` is one whose
   * event loop its synchronous migrations hold: alive, with its PID file
   * written, but silent on the port.
   */
  worker: { pid: number; version: string; phase: StartupPhase; answers: boolean } | null;
  nextWorkerPid: number;
}

type ScriptedInstaller = (world: SimulatedWorld) => AutoUpdateInstallerRun | Promise<AutoUpdateInstallerRun>;

const exitedWith = (exitCode: number): AutoUpdateInstallerRun => ({ kind: 'exited', exitCode, signal: null });

function startWorker(world: SimulatedWorld, version: string, phase: StartupPhase, options: { answers?: boolean } = {}): void {
  world.worker = { pid: world.nextWorkerPid++, version, phase, answers: options.answers ?? true };
}

/** A finished update to `version`: every file written, and its worker started, which finishes starting unless told otherwise. */
const installsCompletely = (version: string, options: { workerPhase?: StartupPhase; exitCode?: number } = {}): ScriptedInstaller => (world) => {
  writeCompleteInstall(world.install, version);
  startWorker(world, version, options.workerPhase ?? 'ready');
  return exitedWith(options.exitCode ?? 0);
};

/** A run that stops the worker (pre-overwrite) and then fails before writing anything. */
const stopsTheWorkerThenExits = (exitCode: number): ScriptedInstaller => (world) => {
  world.worker = null;
  return exitedWith(exitCode);
};

/**
 * A run that stops in "Setting up runtime" (bun install), in the installer's
 * task order: the marketplace copy and cache/<version> are written without
 * their dependencies, and installed_plugins.json already registers <version>.
 * The resolver skips folders with missing dependencies, so it still picks the
 * previous version.
 */
const stopsHalfWritten = (version: string): ScriptedInstaller => (world) => {
  world.worker = null;
  writeMarketplaceCopy(world.install, version, 'missing');
  writeCacheVersion(world.install, version, 'missing');
  writeRegistration(world.install, version);
  return exitedWith(1);
};

/**
 * Every file written, and no worker started: a non-interactive run that found
 * no marketplace copy takes itself for a fresh install and skips "Starting
 * worker daemon" after it stopped the old worker (install.ts
 * shouldSkipWorkerAutostart), and a run that aborts after its last copy step
 * never gets there.
 */
const installsWithoutStartingAWorker = (version: string, options: { exitCode?: number } = {}): ScriptedInstaller => (world) => {
  world.worker = null;
  writeCompleteInstall(world.install, version);
  return exitedWith(options.exitCode ?? 0);
};

/** A cache-only install (#3534): cache/<version> and its registration, no marketplace copy. */
const cacheOnlyLayout = (version: string) => (install: ScratchInstall): void => {
  writeCacheVersion(install, version, 'installed');
  writeRegistration(install, version);
};

interface HarnessOptions {
  installers?: Record<string, ScriptedInstaller>;
  publication?: NpmPublicationRead;
  state?: AutoUpdateState;
  /** ensureWorkerStarted cannot bring a worker up. */
  workerWillNotStart?: boolean;
  /** Lay the install out differently from "PREVIOUS installed completely". */
  layout?: (install: ScratchInstall) => void;
  /** What happens to the worker while a proof waits, by the proof's index (0 for the first): it may finish starting, fail, or die. */
  duringProof?: (world: SimulatedWorld, proofIndex: number) => void;
}

function buildApplyHarness(options: HarnessOptions = {}) {
  const install = createScratchInstall();
  (options.layout ?? ((scratch) => writeCompleteInstall(scratch, PREVIOUS)))(install);
  let stored = structuredClone(options.state ?? launchedState());
  const writes: AutoUpdateState[] = [];
  const world: SimulatedWorld = {
    install,
    worker: { pid: OLD_WORKER_PID, version: PREVIOUS, phase: 'ready', answers: true },
    nextWorkerPid: OLD_WORKER_PID + 1,
  };
  const installerRuns: string[] = [];
  const proofs: Array<{ oldPid: number | null; version: string }> = [];
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const publicationReads: string[] = [];
  /** Workers ensureWorkerStarted's wedged-port reclaim killed. */
  const killedWorkers: number[] = [];
  let workerStarts = 0;
  const deps: AutoUpdateApplyDeps = {
    now: () => NOW,
    readState: () => structuredClone(stored),
    writeState: (state) => { stored = structuredClone(state); writes.push(structuredClone(state)); },
    processId: SUPERVISOR_PID,
    getCurrentWorkerPid: async () => world.worker?.pid ?? null,
    runInstaller: async (version) => {
      installerRuns.push(version);
      const scripted = options.installers?.[version];
      if (!scripted) throw new Error(`no scripted installer for ${version}`);
      return scripted(world);
    },
    // The production proof's rule: a worker other than oldPid on the version, whose startup reported ready; failed ends the wait.
    proveWorkerOnVersion: async (oldPid, version) => {
      options.duringProof?.(world, proofs.length);
      proofs.push({ oldPid, version });
      const worker = world.worker;
      if (worker && worker.answers && worker.pid !== oldPid && worker.version === version) {
        if (worker.phase === 'ready') return { ok: true, pid: worker.pid };
        if (worker.phase === 'failed') return { ok: false, startupFailed: true, detail: `pid ${worker.pid}: SQLITE_CORRUPT during migrations` };
      }
      return { ok: false, startupFailed: false, detail: `360 s, last /api/ready phase: ${JSON.stringify(worker)}` };
    },
    readInstallVersions: () => readScratchInstallVersions(install),
    readDatabaseSchemaStamp: () => readDatabaseSchemaStamp(install.databasePath),
    supervisorSchemaVersion: LATEST_SCHEMA_VERSION,
    pluginCacheDirectory: (version) => path.join(install.cacheRoot, version),
    stampOrphaned: writeOrphanedMarker,
    // The production read's rule: a worker answering, else one the PID file names alive.
    readRunningWorker: async () => {
      const worker = world.worker;
      if (worker === null) return { kind: 'none' };
      return worker.answers ? { kind: 'answering', pid: worker.pid } : { kind: 'alive-not-answering', pid: worker.pid };
    },
    // What worker-spawner.ts ensureWorkerStarted does: a live worker that answers nothing past its boot grace is
    // reclaimed by the wedged-port path (killed), then a worker is started from the script the install resolves to.
    ensureWorkerStarted: async () => {
      workerStarts++;
      if (world.worker !== null && !world.worker.answers) {
        killedWorkers.push(world.worker.pid);
        world.worker = null;
      }
      if (options.workerWillNotStart) return 'dead';
      const resolved = readScratchInstallVersions(install).resolved;
      if (world.worker === null && resolved !== null) startWorker(world, resolved, 'ready');
      return 'ready';
    },
    readNpmPublication: async (version) => { publicationReads.push(version); return options.publication ?? { kind: 'published' }; },
    captureEvent: (event, properties) => { events.push({ event, properties }); },
  };
  return {
    deps,
    install,
    world,
    // A copy: bun's toMatchObject writes its asymmetric matchers into the object it is given.
    stored: () => structuredClone(stored),
    writes,
    installerRuns,
    proofs,
    events,
    publicationReads,
    killedWorkers,
    workerStarts: () => workerStarts,
    isOrphaned: (version: string) => existsSync(path.join(install.cacheRoot, version, '.orphaned_at')),
    versions: () => readScratchInstallVersions(install),
  };
}

/** The marketplace reading of a whole copy of `version`. */
const intactMarketplaceCopy = (version: string) => ({ packageVersion: version, pluginManifestVersion: version, hasWorkerScript: true });

type ApplyHarness = ReturnType<typeof buildApplyHarness>;

function silenceLogger() {
  return {
    info: spyOn(logger, 'info').mockImplementation(() => {}),
    warn: spyOn(logger, 'warn').mockImplementation(() => {}),
    error: spyOn(logger, 'error').mockImplementation(() => {}),
    debug: spyOn(logger, 'debug').mockImplementation(() => {}),
  };
}

function expectFailureTelemetry(harness: ApplyHarness, failureStage: string, restoreResult: string): void {
  expect(harness.events).toEqual([{
    event: 'auto_update_failed',
    properties: { from_version: PREVIOUS, to_version: TARGET, failure_stage: failureStage, restore_result: restoreResult },
  }]);
}

describe('the scratch install reads the way a real one does', () => {
  it('resolves to the newest folder whose dependencies are installed, skipping .orphaned_at, and reads the registration and marketplace copy', () => {
    const install = createScratchInstall();
    writeCompleteInstall(install, PREVIOUS);
    expect(readScratchInstallVersions(install)).toEqual({ resolved: PREVIOUS, registered: { kind: 'read', versions: [PREVIOUS] }, marketplace: intactMarketplaceCopy(PREVIOUS) });

    writeCacheVersion(install, TARGET, 'missing');
    expect(readScratchInstallVersions(install).resolved).toBe(PREVIOUS);
    writeCacheVersion(install, TARGET, 'installed');
    expect(readScratchInstallVersions(install).resolved).toBe(TARGET);
    expect(writeOrphanedMarker(path.join(install.cacheRoot, TARGET), NOW)).toEqual({ kind: 'stamped' });
    expect(readScratchInstallVersions(install).resolved).toBe(PREVIOUS);

    writeFileSync(install.installedPluginsFile, '{"plugins": {');
    expect(readScratchInstallVersions(install).registered).toMatchObject({ kind: 'unreadable', message: expect.stringContaining('Corrupt JSON file') });
  });
});

describe('applyAutoUpdate', () => {
  it('success: claims the attempt, installs, proves a worker on the target finished starting, and records applied', async () => {
    silenceLogger();
    const harness = buildApplyHarness({ installers: { [TARGET]: installsCompletely(TARGET) } });

    const result = await applyAutoUpdate(attempt, harness.deps);

    expect(result).toMatchObject({ kind: 'finished', recorded: 'recorded', restoreResult: null });
    // The supervisor's first write: its pid, and the phase it starts in, into the worker's record.
    expect(harness.writes[0]!.inFlightAttempt).toEqual({ targetVersion: TARGET, previousVersion: PREVIOUS, startedAt: STARTED_AT, supervisorPid: SUPERVISOR_PID, supervisorPhase: 'installing-target' });
    // No restore ran, so no other phase was written before the outcome.
    expect(harness.writes).toHaveLength(2);
    expect(harness.installerRuns).toEqual([TARGET]);
    // The proof needs a new pid: the worker running before the install was OLD_WORKER_PID.
    expect(harness.proofs).toEqual([{ oldPid: OLD_WORKER_PID, version: TARGET }]);
    const state = harness.stored();
    expect(state.inFlightAttempt).toBeNull();
    expect(state.lastAttemptOutcome).toEqual({
      result: 'applied',
      targetVersion: TARGET,
      previousVersion: PREVIOUS,
      finishedAt: NOW,
      message: expect.stringContaining('a worker on it finished starting'),
    });
    expect(state.versionsThatFailedToApply).toEqual([]);
    expect(harness.isOrphaned(TARGET)).toBe(false);
    expect(harness.events).toEqual([{ event: 'auto_update_applied', properties: { from_version: PREVIOUS, to_version: TARGET } }]);
  });

  it('installer exits non-zero but the target is fully in place and its worker finished starting: applied', async () => {
    silenceLogger();
    // A late step failed (install.ts sets exit code 1 when an agent's setup fails) after the switch was complete.
    const harness = buildApplyHarness({ installers: { [TARGET]: installsCompletely(TARGET, { exitCode: 1 }) } });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'applied', message: expect.stringContaining('the installer exited with code 1, the install resolves to 15.13.0') });
  });

  it('installer exits non-zero with nothing changed: failed, with a worker running on the previous version, and the target not blocked', async () => {
    silenceLogger();
    const harness = buildApplyHarness({ installers: { [TARGET]: stopsTheWorkerThenExits(1) } });

    await applyAutoUpdate(attempt, harness.deps);

    // Nothing switched, so nothing is stamped or reinstalled; the stopped worker is started again.
    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.isOrphaned(TARGET)).toBe(false);
    expect(harness.workerStarts()).toBe(1);
    expect(harness.world.worker).toMatchObject({ version: PREVIOUS, phase: 'ready' });
    expect(harness.proofs.at(-1)).toEqual({ oldPid: null, version: PREVIOUS });
    const state = harness.stored();
    expect(state.inFlightAttempt).toBeNull();
    expect(state.lastAttemptOutcome).toMatchObject({
      result: 'failed',
      failureStage: 'installer-exit',
      finishedAt: NOW,
      message: expect.stringContaining('exited with code 1, and the install resolves to 15.12.0, not 15.13.0. Nothing switched'),
    });
    // Nothing of the target was written (an npx download blip, an abort at the installer's worker stop):
    // it is tried again at the next due check instead of blocked for good.
    expect(harness.stored().lastAttemptOutcome!.message).toContain('Nothing of 15.13.0 was written, so it is tried again at the next due check.');
    expect(state.versionsThatFailedToApply).toEqual([]);
    expectFailureTelemetry(harness, 'installer-exit', 'not-needed');
  });

  it('nothing switched on an install with no marketplace copy (the cache alone): still nothing switched, not a restore', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      layout: (install) => { writeCacheVersion(install, PREVIOUS, 'installed'); writeRegistration(install, PREVIOUS); },
      installers: { [TARGET]: stopsTheWorkerThenExits(1) },
    });
    expect(harness.versions().marketplace).toEqual({ packageVersion: null, pluginManifestVersion: null, hasWorkerScript: false });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'installer-exit' });
  });

  it('a half-written install (cache/<target> without dependencies, registered at it) is a switch that started: stamped and restored', async () => {
    silenceLogger();
    const harness = buildApplyHarness({ installers: { [TARGET]: stopsHalfWritten(TARGET), [PREVIOUS]: installsCompletely(PREVIOUS) } });

    await applyAutoUpdate(attempt, harness.deps);

    // The resolver alone still says PREVIOUS (the target's folder is incomplete), but the registration moved.
    expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
    expect(harness.isOrphaned(TARGET)).toBe(true);
    expect(harness.publicationReads).toEqual([PREVIOUS]);
    expect(harness.versions()).toEqual({ resolved: PREVIOUS, registered: { kind: 'read', versions: [PREVIOUS] }, marketplace: intactMarketplaceCopy(PREVIOUS) });
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restored',
      failureStage: 'installer-exit',
      message: expect.stringMatching(/installed_plugins\.json registers 15\.13\.0.*Stamped .*15\.13\.0.*\.orphaned_at.*Restored 15\.12\.0/),
    });
    // A failure after the switch started still blocks the target.
    expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
    expectFailureTelemetry(harness, 'installer-exit', 'restored');
  });

  it('a third, newer version installed meanwhile: failed as superseded, nothing stamped, no installer run, no downgrade', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: {
        [TARGET]: (world) => {
          // Another updater finished 15.14.0 while this run was still downloading, and this run then failed.
          writeCompleteInstall(world.install, NEWER);
          startWorker(world, NEWER, 'ready');
          return exitedWith(1);
        },
      },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.isOrphaned(TARGET)).toBe(false);
    expect(harness.isOrphaned(NEWER)).toBe(false);
    expect(harness.versions().resolved).toBe(NEWER);
    expect(harness.world.worker).toMatchObject({ version: NEWER });
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'failed',
      failureStage: 'superseded-by-another-update',
      message: expect.stringContaining('15.14.0 is newer than 15.13.0: another update moved the install on while this one ran, so nothing was stamped or reinstalled'),
    });
    expectFailureTelemetry(harness, 'superseded-by-another-update', 'not-attempted');
  });

  it('installer exits 0 but the new worker never finishes starting: a failed switch, so the restore runs', async () => {
    silenceLogger();
    const harness = buildApplyHarness({ installers: { [TARGET]: installsCompletely(TARGET, { workerPhase: 'starting' }), [PREVIOUS]: installsCompletely(PREVIOUS) } });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
    expect(harness.isOrphaned(TARGET)).toBe(true);
    // The restore's proof needs a pid other than the one answering before it ran.
    expect(harness.proofs).toEqual([{ oldPid: OLD_WORKER_PID, version: TARGET }, { oldPid: OLD_WORKER_PID + 1, version: PREVIOUS }]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restored',
      failureStage: 'prove-install',
      message: expect.stringContaining('no worker on 15.13.0 finished starting within the startup ceiling'),
    });
    // Only restore_failed names a fix: a restored install works.
    expect(harness.stored().lastAttemptOutcome!.fixCommand).toBeUndefined();
    expectFailureTelemetry(harness, 'prove-install', 'restored');
  });

  it('installer exits 0 but the new worker reports that its startup failed: restored, with the worker\'s message', async () => {
    silenceLogger();
    const harness = buildApplyHarness({ installers: { [TARGET]: installsCompletely(TARGET, { workerPhase: 'failed' }), [PREVIOUS]: installsCompletely(PREVIOUS) } });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restored',
      failureStage: 'prove-install',
      message: expect.stringContaining('the worker on 15.13.0 reported that its startup failed (pid 7002: SQLITE_CORRUPT during migrations)'),
    });
  });

  it('a database already stamped by the target: restore_failed, blocked by the schema; nothing stamped, the previous version not reinstalled, the target\'s worker left as it is', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: {
        [TARGET]: (world) => {
          // The target's worker stamped its newer schema before it migrated, then its startup failed.
          writeCompleteInstall(world.install, TARGET);
          writeDatabaseStamped(world.install, LATEST_SCHEMA_VERSION + 1);
          startWorker(world, TARGET, 'failed');
          return exitedWith(0);
        },
        [PREVIOUS]: installsCompletely(PREVIOUS),
      },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.isOrphaned(TARGET)).toBe(false);
    expect(harness.publicationReads).toEqual([]);
    // A worker runs (its startup failed, and it still answers), so none is started over it.
    expect(harness.workerStarts()).toBe(0);
    expect(harness.killedWorkers).toEqual([]);
    expect(harness.proofs.at(-1)).toEqual({ oldPid: null, version: TARGET });
    const outcome = harness.stored().lastAttemptOutcome!;
    // Only a release newer than the target can fix it: the condition is recorded with the command, as the message states it.
    expect(outcome).toMatchObject({ result: 'restore_failed', failureStage: 'restore-blocked-by-schema', fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND, fixCommandWhen: 'once-a-release-newer-than-the-target-is-out' });
    expect(outcome.message).toContain(`The database is stamped with schema v${LATEST_SCHEMA_VERSION + 1}, newer than the v${LATEST_SCHEMA_VERSION} that 15.12.0 knows, so 15.12.0 cannot open the database any more`);
    expect(outcome.message).toContain('Waited again for a worker on 15.13.0, but the worker on 15.13.0 reported that its startup failed (pid 7002: SQLITE_CORRUPT during migrations).');
    expect(outcome.message).toContain(`Run: ${AUTO_UPDATE_FORWARD_FIX_COMMAND} once a release newer than 15.13.0 is out.`);
    expect(outcome.message).not.toContain(autoUpdateFixCommand(PREVIOUS));
    expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
    expectFailureTelemetry(harness, 'restore-blocked-by-schema', 'not-attempted');
  });

  describe('a database the target stamped, with its worker still migrating it', () => {
    /** The target's installer: every file in place, the newer schema stamped, its worker alive but silent while it migrates. */
    const installsAndStartsMigrating: ScriptedInstaller = (world) => {
      writeCompleteInstall(world.install, TARGET);
      writeDatabaseStamped(world.install, LATEST_SCHEMA_VERSION + 1);
      startWorker(world, TARGET, 'starting', { answers: false });
      return exitedWith(0);
    };

    it('waits for it again without starting or stopping anything, and records applied once it finishes starting', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: { [TARGET]: installsAndStartsMigrating, [PREVIOUS]: installsCompletely(PREVIOUS) },
        // The migrations outlast the first proof's wait, and end during the second.
        duringProof: (world, proofIndex) => {
          if (proofIndex === 1 && world.worker) Object.assign(world.worker, { phase: 'ready', answers: true });
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET]);
      expect(harness.workerStarts()).toBe(0);
      expect(harness.killedWorkers).toEqual([]);
      expect(harness.proofs).toEqual([{ oldPid: OLD_WORKER_PID, version: TARGET }, { oldPid: null, version: TARGET }]);
      expect(harness.isOrphaned(TARGET)).toBe(false);
      const state = harness.stored();
      expect(state.lastAttemptOutcome).toMatchObject({
        result: 'applied',
        message: expect.stringContaining(`Updated 15.12.0 → 15.13.0 after a second wait: 15.13.0's installer exited 0, but a worker process (pid 7002) was running but not answering, so none was started or stopped, and no worker on 15.13.0 finished starting`),
      });
      expect(harness.stored().lastAttemptOutcome!.message).toContain('a worker on it then finished starting (pid 7002)');
      expect(state.versionsThatFailedToApply).toEqual([]);
      expect(harness.events).toEqual([{ event: 'auto_update_applied', properties: { from_version: PREVIOUS, to_version: TARGET } }]);
    });

    it('a migration that then reports failed: restore_failed with the forward fix, and still nothing started or stopped', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: { [TARGET]: installsAndStartsMigrating },
        duringProof: (world, proofIndex) => {
          if (proofIndex === 1 && world.worker) Object.assign(world.worker, { phase: 'failed', answers: true });
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.workerStarts()).toBe(0);
      expect(harness.killedWorkers).toEqual([]);
      const outcome = harness.stored().lastAttemptOutcome!;
      expect(outcome).toMatchObject({ result: 'restore_failed', failureStage: 'restore-blocked-by-schema', fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND, fixCommandWhen: 'once-a-release-newer-than-the-target-is-out' });
      expect(outcome.message).toContain('the worker on 15.13.0 reported that its startup failed');
      expect(outcome.message).toContain(`Run: ${AUTO_UPDATE_FORWARD_FIX_COMMAND} once a release newer than 15.13.0 is out.`);
      expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
    });

    it('a migration still running when the second wait ends: restore_failed with the forward fix, the worker left running', async () => {
      silenceLogger();
      const harness = buildApplyHarness({ installers: { [TARGET]: installsAndStartsMigrating } });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.workerStarts()).toBe(0);
      expect(harness.killedWorkers).toEqual([]);
      expect(harness.world.worker).toMatchObject({ pid: OLD_WORKER_PID + 1, version: TARGET, answers: false });
      const outcome = harness.stored().lastAttemptOutcome!;
      expect(outcome).toMatchObject({ result: 'restore_failed', failureStage: 'restore-blocked-by-schema', fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND });
      expect(outcome.message).toContain('a worker process (pid 7002) was running but not answering, so none was started or stopped, and no worker on 15.13.0 finished starting within the startup ceiling');
      expect(outcome.message).toContain(`Run: ${AUTO_UPDATE_FORWARD_FIX_COMMAND}`);
    });

    it('no worker alive any more (it died mid-migration): one is started on the target, and applied once it finishes starting', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: { [TARGET]: installsAndStartsMigrating },
        duringProof: (world, proofIndex) => {
          if (proofIndex === 0) world.worker = null;
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.workerStarts()).toBe(1);
      expect(harness.killedWorkers).toEqual([]);
      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'applied', message: expect.stringContaining('after a second wait') });
      expect(harness.stored().versionsThatFailedToApply).toEqual([]);
    });
  });

  it('a database stamped no newer than this code knows does not block the restore', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      layout: (install) => { writeCompleteInstall(install, PREVIOUS); writeDatabaseStamped(install, LATEST_SCHEMA_VERSION); },
      installers: { [TARGET]: installsCompletely(TARGET, { workerPhase: 'starting' }), [PREVIOUS]: installsCompletely(PREVIOUS) },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'restored' });
  });

  it('a schema stamp that cannot be read blocks the restore too: nothing shows the previous version can open the database', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: {
        [TARGET]: (world) => {
          writeCompleteInstall(world.install, TARGET);
          writeFileSync(world.install.databasePath, 'not a sqlite database');
          startWorker(world, TARGET, 'starting');
          return exitedWith(0);
        },
      },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.isOrphaned(TARGET)).toBe(false);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restore_failed',
      failureStage: 'schema-stamp-unreadable',
      message: expect.stringContaining(`could not be read`),
      fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND,
    });
    expect(harness.stored().lastAttemptOutcome!.message).toContain(`Run: ${AUTO_UPDATE_FORWARD_FIX_COMMAND}`);
  });

  it('restore also fails: restore_failed, naming the previous version\'s fix command, which npm shows fully published', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: { [TARGET]: installsCompletely(TARGET, { workerPhase: 'starting' }), [PREVIOUS]: () => exitedWith(1) },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
    expect(autoUpdateFixCommand(PREVIOUS)).toBe(`npx claude-mem@${PREVIOUS} update`);
    // The stamp makes every resolver skip cache/<target>, but the marketplace copy still holds the
    // target until an installer rewrites it, so the install resolves to the target again.
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restore_failed',
      failureStage: 'prove-install',
      message: expect.stringMatching(new RegExp(`Could not restore ${PREVIOUS}: the installer for ${PREVIOUS} exited with code 1, and the install resolves to ${TARGET}, not ${PREVIOUS}\\. Run: npx claude-mem@${PREVIOUS} update$`)),
      fixCommand: autoUpdateFixCommand(PREVIOUS),
    });
    expect(harness.stored().inFlightAttempt).toBeNull();
    expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
    expectFailureTelemetry(harness, 'prove-install', 'restore-installer-failed');
  });

  it('previous version not fully published: restore_failed, its installer never run, and the fix does not name it', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: { [TARGET]: installsCompletely(TARGET, { workerPhase: 'starting' }) },
      publication: { kind: 'not-published', missing: ['gitHead', 'SLSA provenance'] },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    // The stamp still lands first, so every resolver skips the target's cache folder.
    expect(harness.isOrphaned(TARGET)).toBe(true);
    const outcome = harness.stored().lastAttemptOutcome!;
    expect(outcome).toMatchObject({ result: 'restore_failed', fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND });
    expect(outcome.message).toContain(`npm does not show it published by the workflow (missing: gitHead, SLSA provenance), so its installer was not run. Run: ${AUTO_UPDATE_FORWARD_FIX_COMMAND}`);
    expect(outcome.message).not.toContain(autoUpdateFixCommand(PREVIOUS));
    expectFailureTelemetry(harness, 'prove-install', 'previous-not-published');
  });

  it('previous version\'s npm metadata unreadable: restore_failed, its installer never run, and the fix does not name it', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: { [TARGET]: installsCompletely(TARGET, { workerPhase: 'starting' }) },
      publication: { kind: 'failed', message: 'https://registry.npmjs.org/claude-mem/15.12.0: HTTP 503' },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.stored().lastAttemptOutcome!.message).toContain(`Run: ${AUTO_UPDATE_FORWARD_FIX_COMMAND}`);
    expect(harness.stored().lastAttemptOutcome!.message).not.toContain(autoUpdateFixCommand(PREVIOUS));
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'restore_failed', fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND });
    expectFailureTelemetry(harness, 'prove-install', 'previous-publication-unknown');
  });

  // Between its first readings and the previous version's installer, the
  // restore awaits npm's metadata and the worker pid read. What lands in that
  // window is read again right before the installer would start.
  describe('what lands while the restore awaits npm and the worker pid read', () => {
    /** The target's installer exits 0 but its worker never finishes starting: the restore path, with the previous version's installer scripted to finish. */
    const restoreHarness = () => buildApplyHarness({
      installers: { [TARGET]: installsCompletely(TARGET, { workerPhase: 'starting' }), [PREVIOUS]: installsCompletely(PREVIOUS) },
    });

    /** Run `land` during the restore's npm read of the previous version, then read as before. */
    const duringTheNpmRead = (harness: ApplyHarness, land: () => void): void => {
      const readNpmPublication = harness.deps.readNpmPublication;
      harness.deps.readNpmPublication = async (version) => {
        land();
        return readNpmPublication(version);
      };
    };

    /** A manual `npx claude-mem@15.14.0 update` that finished: every file of the newer version written, and its worker started. */
    const newerUpdateFinishes = (harness: ApplyHarness) => (): void => {
      writeCompleteInstall(harness.install, NEWER);
      startWorker(harness.world, NEWER, 'ready');
    };

    it('a newer version installed meanwhile: failed as superseded, the previous version\'s installer never run, no downgrade', async () => {
      silenceLogger();
      const harness = restoreHarness();
      duringTheNpmRead(harness, newerUpdateFinishes(harness));

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.publicationReads).toEqual([PREVIOUS]);
      expect(harness.installerRuns).toEqual([TARGET]);
      expect(harness.versions()).toEqual({ resolved: NEWER, registered: { kind: 'read', versions: [NEWER] }, marketplace: intactMarketplaceCopy(NEWER) });
      expect(harness.world.worker).toMatchObject({ version: NEWER, phase: 'ready' });
      const outcome = harness.stored().lastAttemptOutcome!;
      expect(outcome).toMatchObject({ result: 'failed', failureStage: 'superseded-by-another-update' });
      expect(outcome.message).toContain(`Read again right before ${PREVIOUS}'s installer would have started: The install resolves to ${NEWER}; installed_plugins.json registers ${NEWER}; the marketplace copy is ${NEWER}. ${NEWER} is newer than ${TARGET}: another update moved the install on while the restore waited, so ${PREVIOUS} was not reinstalled.`);
      // The target's cache folder was stamped before the npm read; the newer version is untouched.
      expect(harness.isOrphaned(TARGET)).toBe(true);
      expect(harness.isOrphaned(NEWER)).toBe(false);
      expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
      expectFailureTelemetry(harness, 'superseded-by-another-update', 'not-attempted');
    });

    it('the same when it lands during the worker pid read, the last await before the installer', async () => {
      silenceLogger();
      const harness = restoreHarness();
      const getCurrentWorkerPid = harness.deps.getCurrentWorkerPid;
      let pidReads = 0;
      harness.deps.getCurrentWorkerPid = async () => {
        // The first read is before the target's installer; the second, before the previous version's.
        if (++pidReads === 2) newerUpdateFinishes(harness)();
        return getCurrentWorkerPid();
      };

      await applyAutoUpdate(attempt, harness.deps);

      expect(pidReads).toBe(2);
      expect(harness.installerRuns).toEqual([TARGET]);
      expect(harness.versions().resolved).toBe(NEWER);
      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'superseded-by-another-update' });
    });

    it('a database stamped meanwhile with a schema newer than the previous version knows: restore_failed, blocked by the schema, the previous version not reinstalled', async () => {
      silenceLogger();
      const harness = restoreHarness();
      // The target's worker, still starting, claims the database for its newer schema.
      duringTheNpmRead(harness, () => writeDatabaseStamped(harness.install, LATEST_SCHEMA_VERSION + 1));

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET]);
      const outcome = harness.stored().lastAttemptOutcome!;
      expect(outcome).toMatchObject({
        result: 'restore_failed',
        failureStage: 'restore-blocked-by-schema',
        fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND,
        fixCommandWhen: 'once-a-release-newer-than-the-target-is-out',
      });
      expect(outcome.message).toContain(`Read again right before ${PREVIOUS}'s installer would have started: the database is stamped with schema v${LATEST_SCHEMA_VERSION + 1}, newer than the v${LATEST_SCHEMA_VERSION} that ${PREVIOUS} knows: it was stamped while the restore waited, so ${PREVIOUS} cannot open the database any more and was not reinstalled.`);
      expect(outcome.message).toContain(`Run: ${AUTO_UPDATE_FORWARD_FIX_COMMAND} once a release newer than ${TARGET} is out.`);
      expect(outcome.message).not.toContain(autoUpdateFixCommand(PREVIOUS));
      expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
      expectFailureTelemetry(harness, 'restore-blocked-by-schema', 'not-attempted');
    });

    it('a schema stamp that can no longer be read: restore_failed, nothing shows the previous version can open it, so it is not reinstalled', async () => {
      silenceLogger();
      const harness = restoreHarness();
      duringTheNpmRead(harness, () => writeFileSync(harness.install.databasePath, 'not a sqlite database'));

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET]);
      const outcome = harness.stored().lastAttemptOutcome!;
      expect(outcome).toMatchObject({ result: 'restore_failed', failureStage: 'schema-stamp-unreadable', fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND });
      expect(outcome.message).toContain(`Read again right before ${PREVIOUS}'s installer would have started: the database's schema stamp could not be read`);
      expectFailureTelemetry(harness, 'schema-stamp-unreadable', 'not-attempted');
    });

    it('a stamp written meanwhile that the previous version still knows lets the restore run', async () => {
      silenceLogger();
      const harness = restoreHarness();
      duringTheNpmRead(harness, () => writeDatabaseStamped(harness.install, LATEST_SCHEMA_VERSION));

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'restored' });
    });
  });

  it('install moved before the installer started (registered at another version): failed, nothing run, the version not blocked', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      // The user ran `npx claude-mem@15.12.5 update` between the worker's decision and the supervisor's start.
      layout: (install) => { writeCompleteInstall(install, PREVIOUS); writeRegistration(install, '15.12.5'); },
      installers: { [TARGET]: installsCompletely(TARGET) },
      state: { ...launchedState(), versionsThatFailedToApply: ['15.11.0'] },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([]);
    expect(harness.workerStarts()).toBe(0);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'failed',
      failureStage: 'install-moved-before-start',
      message: expect.stringContaining('installed_plugins.json registers 15.12.5'),
    });
    expect(harness.stored().versionsThatFailedToApply).toEqual(['15.11.0']);
    expect(harness.stored().inFlightAttempt).toBeNull();
    expectFailureTelemetry(harness, 'install-moved-before-start', 'not-attempted');
  });

  it('install moved before the installer started (resolves to another version): failed, nothing run', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      layout: (install) => { writeCompleteInstall(install, PREVIOUS); writeCacheVersion(install, '15.12.5', 'installed'); },
      installers: { [TARGET]: installsCompletely(TARGET) },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'install-moved-before-start', message: expect.stringContaining('The install resolves to 15.12.5') });
  });

  describe('an installer that ends without starting a worker', () => {
    it('cache-only install: the target is complete but the installer skipped the worker start, so one is started on it and proven: applied', async () => {
      silenceLogger();
      const harness = buildApplyHarness({ layout: cacheOnlyLayout(PREVIOUS), installers: { [TARGET]: installsWithoutStartingAWorker(TARGET) } });
      expect(harness.versions().marketplace).toEqual({ packageVersion: null, pluginManifestVersion: null, hasWorkerScript: false });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET]);
      // The installer stopped the old worker and started none; the supervisor started one from what the install resolves to.
      expect(harness.workerStarts()).toBe(1);
      expect(harness.world.worker).toMatchObject({ version: TARGET, phase: 'ready' });
      expect(harness.proofs).toEqual([{ oldPid: OLD_WORKER_PID, version: TARGET }]);
      expect(harness.isOrphaned(TARGET)).toBe(false);
      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'applied', message: expect.stringContaining('the installer exited 0, the install resolves to 15.13.0') });
      expect(harness.stored().versionsThatFailedToApply).toEqual([]);
      expect(harness.events.map((entry) => entry.event)).toEqual(['auto_update_applied']);
    });

    it('restore side: the previous installer completes its cache folder but stops before starting a worker, so one is started on it: restored', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        layout: cacheOnlyLayout(PREVIOUS),
        installers: { [TARGET]: stopsHalfWritten(TARGET), [PREVIOUS]: installsWithoutStartingAWorker(PREVIOUS, { exitCode: 1 }) },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
      expect(harness.isOrphaned(TARGET)).toBe(true);
      // The target never resolved (its folder lacked dependencies), so the only start is the restore's.
      expect(harness.workerStarts()).toBe(1);
      expect(harness.world.worker).toMatchObject({ version: PREVIOUS, phase: 'ready' });
      expect(harness.stored().lastAttemptOutcome).toMatchObject({
        result: 'restored',
        message: expect.stringContaining('Restored 15.12.0: its installer exited with code 1, the install resolves to it, and a worker on it finished starting'),
      });
      expectFailureTelemetry(harness, 'installer-exit', 'restored');
    });

    it('a worker the installer started is never started over before its proof', async () => {
      silenceLogger();
      const harness = buildApplyHarness({ installers: { [TARGET]: installsCompletely(TARGET) } });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.workerStarts()).toBe(0);
      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'applied' });
    });
  });

  describe('a marketplace copy the installer stopped replacing partway through', () => {
    // install.ts copyPluginToMarketplace removes and recopies plugin/ and the copy's other folders one by one, then
    // writes package.json last. EBUSY or EPERM on Windows, or a full disk, stops it in between, so package.json still
    // names the previous version while plugin/ is gone, or already the target's. Pi and DSH start from that folder.
    const partialCopies: Array<{ name: string; leave: (install: ScratchInstall) => void; expected: MarketplaceCopyRead }> = [
      {
        name: 'plugin/ removed and not copied again',
        leave: (install) => rmSync(path.join(install.marketplaceRoot, 'plugin'), { recursive: true, force: true }),
        expected: { packageVersion: PREVIOUS, pluginManifestVersion: null, hasWorkerScript: false },
      },
      {
        name: 'plugin/ already the target\'s, package.json still the previous version\'s',
        leave: (install) => writePluginFolder(path.join(install.marketplaceRoot, 'plugin'), TARGET, 'missing'),
        expected: { packageVersion: PREVIOUS, pluginManifestVersion: TARGET, hasWorkerScript: true },
      },
    ];

    for (const partial of partialCopies) {
      it(`${partial.name}: a switch that started, so the previous version is restored`, async () => {
        silenceLogger();
        const harness = buildApplyHarness({
          installers: {
            [TARGET]: (world) => {
              world.worker = null;
              partial.leave(world.install);
              return exitedWith(1);
            },
            [PREVIOUS]: installsCompletely(PREVIOUS),
          },
        });

        await applyAutoUpdate(attempt, harness.deps);

        expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
        expect(harness.versions().marketplace).toEqual(intactMarketplaceCopy(PREVIOUS));
        const outcome = harness.stored().lastAttemptOutcome!;
        expect(outcome).toMatchObject({ result: 'restored', failureStage: 'installer-exit', message: expect.stringContaining('the marketplace copy is incomplete') });
        expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
        expectFailureTelemetry(harness, 'installer-exit', 'restored');
      });

      it(`${partial.name}: read as it is`, () => {
        const install = createScratchInstall();
        writeCompleteInstall(install, PREVIOUS);
        partial.leave(install);
        expect(readScratchInstallVersions(install).marketplace).toEqual(partial.expected);
      });
    }
  });

  describe('a failure that wrote nothing is tried again', () => {
    it('removes the block gate 3 added while it took this supervisor for vanished', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: {
          [TARGET]: (world) => {
            // What gate 3 writes for an attempt it takes for vanished (auto-update-check.ts recordVanishedSupervisor).
            harness.deps.writeState({
              ...harness.deps.readState(),
              inFlightAttempt: null,
              lastAttemptOutcome: { result: 'failed', targetVersion: TARGET, previousVersion: PREVIOUS, finishedAt: NOW - MINUTE_MS, failureStage: 'supervisor-vanished' },
              versionsThatFailedToApply: ['15.12.5', TARGET],
            });
            return stopsTheWorkerThenExits(1)(world);
          },
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'installer-exit' });
      expect(harness.stored().versionsThatFailedToApply).toEqual(['15.12.5']);
    });

    it('an installer that could not even start writes nothing either: not blocked', async () => {
      silenceLogger();
      const harness = buildApplyHarness({ installers: { [TARGET]: () => ({ kind: 'npx-not-found', message: 'npx was not found on PATH' }) } });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'npx-not-found' });
      expect(harness.stored().versionsThatFailedToApply).toEqual([]);
    });
  });

  it('a project\'s and a local registration at other versions are not the install moving, and the update keeps both exactly as Claude Code wrote them', async () => {
    silenceLogger();
    let claudeCodeEntries: Array<Record<string, unknown>> = [];
    const harness = buildApplyHarness({
      layout: (install) => {
        claudeCodeEntries = [registrationClaudeCodeWrote(install, 'project', '15.10.0'), registrationClaudeCodeWrote(install, 'local', '15.11.0')];
        writeRegistrationsClaudeCodeWrote(install, claudeCodeEntries);
        writeCompleteInstall(install, PREVIOUS);
      },
      installers: { [TARGET]: installsCompletely(TARGET) },
    });
    expect(harness.versions().registered).toEqual({ kind: 'read', versions: [PREVIOUS] });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'applied' });
    // The target's installer (registerPlugin) replaced only the user-scope entry, and left Claude Code's in place.
    expect(readRegistrationEntries(harness.install)).toEqual([
      ...claudeCodeEntries,
      { scope: 'user', installPath: path.join(harness.install.cacheRoot, TARGET), version: TARGET, installedAt: expect.any(String), lastUpdated: expect.any(String) },
    ]);
  });

  describe('deadline hit and kills', () => {
    it('kills the installer\'s whole process tree, then takes the restore path', async () => {
      silenceLogger();
      const pidsFile = path.join(runDirectory, 'installer-pids.json');
      const logPath = path.join(runDirectory, 'auto-update-attempt.log');
      // A harmless stand-in for a hung installer: it starts a child of its own,
      // records both pids, and never exits.
      const hungInstaller = [
        "const { spawn } = require('child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        `require('fs').writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ installer: process.pid, child: child.pid }));`,
        'setInterval(() => {}, 1000);',
      ].join('\n');
      // Long enough for Bun to start the script and its child and write the pids
      // (well under a second here), short enough to keep the test fast.
      const deadlineMs = 2_000;
      const harness = buildApplyHarness({
        installers: {
          [TARGET]: async (world) => {
            // The hung run had already written the target before it stopped making progress.
            stopsHalfWritten(TARGET)(world);
            return runAutoUpdateInstaller(commandInvocation(process.execPath, ['-e', hungInstaller]), { logPath, deadlineMs, runFolderName: autoUpdateInstallerRunFolderName(STARTED_AT, TARGET) });
          },
          [PREVIOUS]: installsCompletely(PREVIOUS),
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      const pids = JSON.parse(readFileSync(pidsFile, 'utf-8')) as { installer: number; child: number };
      // SIGKILL is immediate; the wait only covers reaping the killed processes.
      await waitUntilGone([pids.installer, pids.child], 10_000);
      expect(isPidAlive(pids.installer)).toBe(false);
      expect(isPidAlive(pids.child)).toBe(false);
      expect(readFileSync(logPath, 'utf-8')).toContain('ran past its 2 s deadline; its process tree was killed; it exited');
      expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
      expect(harness.isOrphaned(TARGET)).toBe(true);
      expect(harness.stored().lastAttemptOutcome).toMatchObject({
        result: 'restored',
        failureStage: 'installer-timeout',
        message: expect.stringContaining('ran past its 2 s deadline and its process tree was killed'),
      });
      expectFailureTelemetry(harness, 'installer-timeout', 'restored');
    }, REAL_PROCESS_TEST_TIMEOUT_MS);

    it('a failed kill of the target\'s installer: it may still run, so no other installer starts and nothing is stamped', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: {
          [TARGET]: (world) => {
            stopsHalfWritten(TARGET)(world);
            return { kind: 'timed-out', deadlineMs: 2_065_000, killError: 'taskkill failed for PID 4321 (exit 1): Access is denied.', installerPid: 4321, installerStillRunning: true };
          },
          [PREVIOUS]: installsCompletely(PREVIOUS),
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET]);
      expect(harness.isOrphaned(TARGET)).toBe(false);
      expect(harness.proofs).toEqual([]);
      const outcome = harness.stored().lastAttemptOutcome!;
      // The fix may run only once the installer still running has finished: recorded with the command, as the message states it.
      expect(outcome).toMatchObject({ result: 'restore_failed', failureStage: 'installer-still-running', fixCommand: autoUpdateFixCommand(PREVIOUS), fixCommandWhen: 'once-the-running-update-has-finished' });
      expect(outcome.message).toContain('killing its process tree failed (taskkill failed for PID 4321 (exit 1): Access is denied.), but its process (pid 4321) was still running after it');
      expect(outcome.message).toContain(`Once it has exited, run: ${autoUpdateFixCommand(PREVIOUS)}`);
      expectFailureTelemetry(harness, 'installer-still-running', 'not-attempted');
    });

    it('a killed restore installer still running: restore_failed at installer-still-running, and no third installer', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: {
          [TARGET]: installsCompletely(TARGET, { workerPhase: 'starting' }),
          [PREVIOUS]: () => ({ kind: 'timed-out', deadlineMs: 2_065_000, killError: null, installerPid: 4322, installerStillRunning: true }),
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
      expect(harness.stored().lastAttemptOutcome).toMatchObject({
        result: 'restore_failed',
        failureStage: 'installer-still-running',
        message: expect.stringContaining('its process tree was killed, but its process (pid 4322) was still running after it, so no other installer was started. Once it has exited, run: npx claude-mem@15.12.0 update'),
        fixCommand: autoUpdateFixCommand(PREVIOUS),
        fixCommandWhen: 'once-the-running-update-has-finished',
      });
      expectFailureTelemetry(harness, 'installer-still-running', 'restore-installer-failed');
    });
  });

  it('an exception mid-run still writes the outcome and clears the attempt; before anything of the target was written, the target is tried again, as when nothing switched', async () => {
    const logs = silenceLogger();
    const harness = buildApplyHarness({
      installers: { [TARGET]: () => { throw new Error('installer runner exploded'); } },
      // Gate 3 had blocked it while it took this supervisor for vanished; nothing switched, so the block goes too.
      state: { ...launchedState(), versionsThatFailedToApply: ['15.12.5', TARGET] },
    });

    const result = await applyAutoUpdate(attempt, harness.deps);

    expect(result).toMatchObject({ kind: 'finished', recorded: 'recorded' });
    const state = harness.stored();
    expect(state.inFlightAttempt).toBeNull();
    expect(state.lastAttemptOutcome).toMatchObject({
      // The install still resolves to and is registered at the previous version, so nothing is left to restore.
      result: 'failed',
      failureStage: 'supervisor-exception',
      message: expect.stringContaining('installer runner exploded'),
    });
    // A fresh copy: toMatchObject above wrote its matcher into `state`.
    expect(harness.stored().lastAttemptOutcome!.message).toContain(`the marketplace copy is ${PREVIOUS}. Nothing of ${TARGET} was written, so it is tried again at the next due check.`);
    expect(state.versionsThatFailedToApply).toEqual(['15.12.5']);
    expect(logs.error.mock.calls.map((call) => call[1])).toContain('Auto-update supervisor stopped on an unexpected error');
    expectFailureTelemetry(harness, 'supervisor-exception', 'unknown');
  });

  it('an exception that leaves the install on the previous version but part of the target in the marketplace copy blocks the target: that is a switch that started', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: { [TARGET]: (world) => { writeMarketplaceCopy(world.install, TARGET, 'missing'); throw new Error('lost the installer mid-run'); } },
    });
    // The resolver and the registration still say the previous version.
    expect(harness.versions()).toMatchObject({ resolved: PREVIOUS, registered: { kind: 'read', versions: [PREVIOUS] } });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.versions()).toMatchObject({ resolved: PREVIOUS, registered: { kind: 'read', versions: [PREVIOUS] }, marketplace: intactMarketplaceCopy(TARGET) });
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'supervisor-exception' });
    expect(harness.stored().lastAttemptOutcome!.message).not.toContain('tried again');
    expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
  });

  it('an exception once the restore had begun blocks the target, even with the install back on the previous version', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: {
        [TARGET]: stopsHalfWritten(TARGET),
        // The restore put every file back, then the supervisor stopped on an error before its proof.
        [PREVIOUS]: (world) => { writeCompleteInstall(world.install, PREVIOUS); throw new Error('lost the restore installer mid-run'); },
      },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
    expect(harness.versions()).toEqual({ resolved: PREVIOUS, registered: { kind: 'read', versions: [PREVIOUS] }, marketplace: intactMarketplaceCopy(PREVIOUS) });
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'failed', failureStage: 'supervisor-exception', message: expect.stringContaining('lost the restore installer mid-run') });
    expect(harness.stored().lastAttemptOutcome!.message).not.toContain('tried again');
    expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
  });

  it('an exception after the version moved is restore_failed with the fix command, since nothing proved where the install is', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: { [TARGET]: (world) => { writeCompleteInstall(world.install, TARGET); throw new Error('lost the installer mid-run'); } },
    });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restore_failed',
      failureStage: 'supervisor-exception',
      message: expect.stringContaining(`The install resolves to ${TARGET}; installed_plugins.json registers ${TARGET}; the marketplace copy is ${TARGET}. Nothing restored ${PREVIOUS}. Run: npx claude-mem@${PREVIOUS} update`),
      fixCommand: autoUpdateFixCommand(PREVIOUS),
      fixCommandWhen: 'now',
    });
  });

  it('an exception after the target stamped its newer schema names the target\'s own installer, to run now: never the previous version, nor latest', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: {
        [TARGET]: (world) => {
          writeCompleteInstall(world.install, TARGET);
          writeDatabaseStamped(world.install, LATEST_SCHEMA_VERSION + 1);
          throw new Error('lost the installer mid-run');
        },
      },
    });

    await applyAutoUpdate(attempt, harness.deps);

    // The target was promoted and shown fully published before the attempt; latest may be a release the owner holds.
    expect(harness.stored().lastAttemptOutcome!.message).toContain(`Run: ${autoUpdateFixCommand(TARGET)}`);
    expect(harness.stored().lastAttemptOutcome!.message).not.toContain(autoUpdateFixCommand(PREVIOUS));
    expect(harness.stored().lastAttemptOutcome!.message).not.toContain(AUTO_UPDATE_FORWARD_FIX_COMMAND);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({ fixCommand: autoUpdateFixCommand(TARGET), fixCommandWhen: 'now' });
  });

  it('spawn failure: an installer that cannot start fails at installer-spawn and leaves the previous version running', async () => {
    silenceLogger();
    const spawnDirectory = mkdtempSync(path.join(scratchRoot, 'auto-update-apply-spawn-'));
    try {
      const logPath = path.join(spawnDirectory, 'auto-update-attempt.log');
      const harness = buildApplyHarness({
        installers: {
          // The real runner with a command that does not exist: Bun returns no pid, then emits ENOENT.
          // The deadline is never reached: the spawn error settles the run first.
          [TARGET]: async () => runAutoUpdateInstaller(
            commandInvocation(path.join(spawnDirectory, 'no-such-installer'), ['update']),
            { logPath, deadlineMs: 60_000, runFolderName: autoUpdateInstallerRunFolderName(STARTED_AT, TARGET) },
          ),
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.stored().lastAttemptOutcome).toMatchObject({
        result: 'failed',
        failureStage: 'installer-spawn',
        message: expect.stringContaining('could not be started'),
      });
      // Nothing ran, so there was nothing to prove before the previous worker's proof.
      expect(harness.proofs).toEqual([{ oldPid: null, version: PREVIOUS }]);
      expect(readFileSync(logPath, 'utf-8')).toContain('could not start the installer');
      expectFailureTelemetry(harness, 'installer-spawn', 'not-needed');
    } finally {
      rmSync(spawnDirectory, { recursive: true, force: true });
    }
  });

  /**
   * The real runner, when the run's folder cannot be made: a file stands where the installer folder goes in the
   * data dir (tests/preload.ts points that at a scratch folder), so mkdir fails before anything starts, as a
   * leftover a process still holds can make it fail on Windows. The file is removed again afterwards.
   */
  async function runWithAnInstallerFolderThatCannotBeMade(logPath: string, version: string) {
    const installerFolder = autoUpdateInstallerFolder();
    rmSync(installerFolder, { recursive: true, force: true });
    writeFileSync(installerFolder, 'not a folder');
    try {
      return await runAutoUpdateInstaller(
        commandInvocation(process.execPath, ['-e', 'process.exit(0)']),
        { logPath, deadlineMs: 60_000, runFolderName: autoUpdateInstallerRunFolderName(STARTED_AT, version) },
      );
    } finally {
      rmSync(installerFolder, { force: true });
    }
  }

  it('folder failure: a target installer whose folder cannot be made fails at installer-folder, starts nothing, and is tried again', async () => {
    silenceLogger();
    const logPath = path.join(runDirectory, 'auto-update-folder-failure.log');
    const harness = buildApplyHarness({ installers: { [TARGET]: () => runWithAnInstallerFolderThatCannotBeMade(logPath, TARGET) } });

    expect(await applyAutoUpdate(attempt, harness.deps)).toMatchObject({ kind: 'finished', recorded: 'recorded', restoreResult: 'not-needed' });

    const folderNotMade = `the folder ${autoUpdateInstallerFolder()} could not be made`;
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'failed',
      failureStage: 'installer-folder',
      message: expect.stringContaining(`The installer for ${TARGET} could not be run: ${folderNotMade}`),
    });
    expect(harness.stored().versionsThatFailedToApply).toEqual([]);
    // Nothing ran, so only the previous version's worker was proven.
    expect(harness.proofs).toEqual([{ oldPid: null, version: PREVIOUS }]);
    expect(readFileSync(logPath, 'utf-8')).toContain(`not running: ${process.execPath} -e process.exit(0): ${folderNotMade}`);
    expectFailureTelemetry(harness, 'installer-folder', 'not-needed');
  });

  it('folder failure on the restore: restore_failed with the previous version\'s fix, never a supervisor exception', async () => {
    silenceLogger();
    const logPath = path.join(runDirectory, 'auto-update-restore-folder-failure.log');
    const harness = buildApplyHarness({
      installers: { [TARGET]: stopsHalfWritten(TARGET), [PREVIOUS]: () => runWithAnInstallerFolderThatCannotBeMade(logPath, PREVIOUS) },
    });

    expect(await applyAutoUpdate(attempt, harness.deps)).toMatchObject({ kind: 'finished', recorded: 'recorded', restoreResult: 'restore-installer-failed' });

    expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restore_failed',
      failureStage: 'installer-exit',
      message: expect.stringContaining(`Could not restore ${PREVIOUS}: the installer for ${PREVIOUS} could not be run: the folder ${autoUpdateInstallerFolder()} could not be made`),
      fixCommand: autoUpdateFixCommand(PREVIOUS),
      fixCommandWhen: 'now',
    });
    expect(harness.stored().lastAttemptOutcome!.message).toMatch(new RegExp(`Run: npx claude-mem@${PREVIOUS} update$`));
    expect(harness.stored().inFlightAttempt).toBeNull();
    expect(harness.stored().versionsThatFailedToApply).toEqual([TARGET]);
    expectFailureTelemetry(harness, 'installer-exit', 'restore-installer-failed');
  });

  it('npx not found (Windows): fails at npx-not-found, nothing switched, the previous version running', async () => {
    silenceLogger();
    const harness = buildApplyHarness({ installers: { [TARGET]: () => ({ kind: 'npx-not-found', message: 'npx was not found on PATH' }) } });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'failed',
      failureStage: 'npx-not-found',
      message: expect.stringContaining('The installer for 15.13.0 could not be run: npx was not found on PATH'),
    });
    expect(harness.world.worker).toMatchObject({ version: PREVIOUS, phase: 'ready' });
    expectFailureTelemetry(harness, 'npx-not-found', 'not-needed');
  });

  it('the previous version\'s worker does not come back after a run that switched nothing: restore_failed with the fix command, the target not blocked', async () => {
    silenceLogger();
    const harness = buildApplyHarness({ installers: { [TARGET]: stopsTheWorkerThenExits(1) }, workerWillNotStart: true });

    await applyAutoUpdate(attempt, harness.deps);

    expect(harness.installerRuns).toEqual([TARGET]);
    // The fix names the previous version only once npm shows it fully published.
    expect(harness.publicationReads).toEqual([PREVIOUS]);
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restore_failed',
      failureStage: 'installer-exit',
      message: expect.stringContaining(`but after starting a worker (dead), no worker on ${PREVIOUS} finished starting within the startup ceiling (360 s, last /api/ready phase: null). Nothing of ${TARGET} was written, so it is tried again at the next due check. Run: npx claude-mem@${PREVIOUS} update`),
      fixCommand: autoUpdateFixCommand(PREVIOUS),
      fixCommandWhen: 'now',
    });
    expect(harness.stored().versionsThatFailedToApply).toEqual([]);
    expectFailureTelemetry(harness, 'installer-exit', 'previous-worker-unproven');
  });

  it('the same, with a previous version npm does not show fully published: the target\'s own installer, to run now, never latest', async () => {
    silenceLogger();
    const harness = buildApplyHarness({
      installers: { [TARGET]: stopsTheWorkerThenExits(1) },
      workerWillNotStart: true,
      publication: { kind: 'not-published', missing: ['gitHead', 'SLSA provenance'] },
    });

    await applyAutoUpdate(attempt, harness.deps);

    // Nothing of the target was written, and the worker promoted it and npm showed it fully published before the attempt.
    expect(harness.stored().lastAttemptOutcome).toMatchObject({
      result: 'restore_failed',
      message: expect.stringContaining(`Nothing of ${TARGET} was written, so it is tried again at the next due check. Run: npx claude-mem@${TARGET} update`),
      fixCommand: autoUpdateFixCommand(TARGET),
      fixCommandWhen: 'now',
    });
    expect(harness.stored().lastAttemptOutcome!.message).not.toContain(AUTO_UPDATE_FORWARD_FIX_COMMAND);
  });

  describe('how far the supervisor got, recorded in its attempt for gate 3', () => {
    it('records installing the target with its claim, and restoring the previous version right before that version\'s installer runs', async () => {
      silenceLogger();
      const phaseWhenEachInstallerRan: Record<string, unknown> = {};
      const notingThePhase = (version: string, installer: ScriptedInstaller): ScriptedInstaller => (world) => {
        phaseWhenEachInstallerRan[version] = harness.deps.readState().inFlightAttempt?.supervisorPhase;
        return installer(world);
      };
      const harness = buildApplyHarness({
        installers: { [TARGET]: notingThePhase(TARGET, stopsHalfWritten(TARGET)), [PREVIOUS]: notingThePhase(PREVIOUS, installsCompletely(PREVIOUS)) },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(phaseWhenEachInstallerRan).toEqual({ [TARGET]: 'installing-target', [PREVIOUS]: 'restoring-previous-version' });
      // The claim, the restore's phase, then the outcome, which replaces the attempt.
      expect(harness.writes.map((write) => write.inFlightAttempt?.supervisorPhase ?? null)).toEqual(['installing-target', 'restoring-previous-version', null]);
      expect(harness.writes[1]!.inFlightAttempt).toEqual({ targetVersion: TARGET, previousVersion: PREVIOUS, startedAt: STARTED_AT, supervisorPid: SUPERVISOR_PID, supervisorPhase: 'restoring-previous-version' });
      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'restored' });
    });

    it('writes no phase into an attempt in flight that is not its own, logs it, and still restores', async () => {
      const logs = silenceLogger();
      const anotherAttempt = { targetVersion: NEWER, previousVersion: PREVIOUS, startedAt: STARTED_AT + 2 * MINUTE_MS, supervisorPid: 9001 };
      const harness = buildApplyHarness({
        installers: {
          [TARGET]: (world) => {
            // While this supervisor ran, the worker took it for vanished and launched another attempt.
            harness.deps.writeState({ ...harness.deps.readState(), inFlightAttempt: anotherAttempt });
            return stopsHalfWritten(TARGET)(world);
          },
          [PREVIOUS]: installsCompletely(PREVIOUS),
        },
      });

      const result = await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
      // Left exactly as it was by the phase write, and by the final write.
      expect(harness.stored().inFlightAttempt).toEqual(anotherAttempt);
      expect(result).toMatchObject({ kind: 'finished', recorded: 'left-to-another-attempt' });
      expect(logs.warn.mock.calls.map((call) => call[1])).toContain('The attempt in flight is no longer this supervisor\'s, so it does not record how far it got');
    });

    it('logs a phase it cannot write, and still restores and records its outcome', async () => {
      const logs = silenceLogger();
      const harness = buildApplyHarness({ installers: { [TARGET]: stopsHalfWritten(TARGET), [PREVIOUS]: installsCompletely(PREVIOUS) } });
      const writeState = harness.deps.writeState;
      let writeNumber = 0;
      harness.deps.writeState = (state) => {
        // The claim is the first write and the outcome the third: only the restore's phase, the second, fails.
        if (++writeNumber === 2) throw new Error('EIO: i/o error, write');
        writeState(state);
      };

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.installerRuns).toEqual([TARGET, PREVIOUS]);
      expect(logs.error.mock.calls.map((call) => call[1])).toContain('Auto-update supervisor could not record how far it got in the state file, and goes on');
      expect(harness.stored()).toMatchObject({ inFlightAttempt: null, lastAttemptOutcome: { result: 'restored' } });
    });
  });

  describe('the final write', () => {
    it('writes nothing when a different attempt is in flight at the end, and logs it', async () => {
      const logs = silenceLogger();
      const harness = buildApplyHarness({
        installers: {
          [TARGET]: (world) => {
            // While this supervisor ran, the worker took it for vanished and launched another attempt.
            harness.deps.writeState({
              ...harness.deps.readState(),
              inFlightAttempt: { targetVersion: '15.14.0', previousVersion: PREVIOUS, startedAt: STARTED_AT + 2 * MINUTE_MS, supervisorPid: 9001 },
            });
            return installsCompletely(TARGET)(world);
          },
        },
      });

      const result = await applyAutoUpdate(attempt, harness.deps);

      expect(result).toMatchObject({ kind: 'finished', recorded: 'left-to-another-attempt' });
      // The other attempt's record is untouched, and no outcome of this one was written over it.
      expect(harness.stored().inFlightAttempt).toMatchObject({ targetVersion: '15.14.0', supervisorPid: 9001 });
      expect(harness.stored().lastAttemptOutcome).toBeNull();
      expect(logs.warn.mock.calls.map((call) => call[1])).toContain('Another auto-update attempt is in flight, so this supervisor leaves the state file as it is');
    });

    it('applied after the worker recorded it vanished: writes applied and unblocks the version', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: {
          [TARGET]: (world) => {
            // What gate 3 writes for an attempt it takes for vanished (auto-update-check.ts recordVanishedSupervisor).
            harness.deps.writeState({
              ...harness.deps.readState(),
              inFlightAttempt: null,
              lastAttemptOutcome: { result: 'failed', targetVersion: TARGET, previousVersion: PREVIOUS, finishedAt: NOW - MINUTE_MS, failureStage: 'supervisor-vanished' },
              versionsThatFailedToApply: ['15.12.5', TARGET],
            });
            return installsCompletely(TARGET)(world);
          },
        },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.stored().lastAttemptOutcome).toMatchObject({ result: 'applied', targetVersion: TARGET });
      expect(harness.stored().versionsThatFailedToApply).toEqual(['15.12.5']);
    });

    it('replaces its own attempt and clears the busy deferral on success', async () => {
      silenceLogger();
      const harness = buildApplyHarness({
        installers: { [TARGET]: installsCompletely(TARGET) },
        state: { ...launchedState(), busyDeferralStartedAt: STARTED_AT - MINUTE_MS, busyDeferralObservedBusyMs: MINUTE_MS, busyDeferralLastBusyObservationAt: STARTED_AT },
      });

      await applyAutoUpdate(attempt, harness.deps);

      expect(harness.stored()).toMatchObject({ inFlightAttempt: null, busyDeferralStartedAt: null, busyDeferralObservedBusyMs: 0, busyDeferralLastBusyObservationAt: null });
    });

    it('a supervisor whose attempt is not the one in flight runs nothing and writes nothing', async () => {
      const logs = silenceLogger();
      for (const state of [
        { ...launchedState(), inFlightAttempt: null },
        { ...launchedState(), inFlightAttempt: { ...launchedState().inFlightAttempt!, startedAt: STARTED_AT + 1 } },
        { ...launchedState(), inFlightAttempt: { ...launchedState().inFlightAttempt!, supervisorPid: 4444 } },
      ]) {
        const harness = buildApplyHarness({ installers: { [TARGET]: installsCompletely(TARGET) }, state });
        const result = await applyAutoUpdate(attempt, harness.deps);
        expect(result.kind).toBe('not-claimed');
        expect(harness.installerRuns).toEqual([]);
        expect(harness.writes).toEqual([]);
        expect(harness.events).toEqual([]);
      }
      expect(logs.warn).toHaveBeenCalledTimes(3);
    });

    it('when the state file cannot be written at the end, it logs the outcome it could not record, still reports telemetry, and throws', async () => {
      const logs = silenceLogger();
      const harness = buildApplyHarness({ installers: { [TARGET]: installsCompletely(TARGET) } });
      const writeState = harness.deps.writeState;
      let writesAllowed = 1;
      harness.deps.writeState = (state) => {
        if (writesAllowed-- <= 0) throw new Error('EACCES: the data dir became read-only');
        writeState(state);
      };

      await expect(applyAutoUpdate(attempt, harness.deps)).rejects.toThrow('EACCES');

      expect(logs.error.mock.calls.map((call) => call[1])).toContain('Auto-update supervisor could not record its outcome in the state file');
      expect(harness.events.map((entry) => entry.event)).toEqual(['auto_update_applied']);
    });
  });

  it('sends only properties the telemetry whitelist keeps', () => {
    const properties = { from_version: PREVIOUS, to_version: TARGET, failure_stage: 'restore-blocked-by-schema', restore_result: 'not-attempted' };
    expect(scrubProperties(properties)).toEqual(properties);
  });
});

// Gate 3's reading of an attempt whose supervisor and installer a reboot cut
// off (auto-update-check.ts recordVanishedSupervisor), over the same scratch
// layouts and production readers as the supervisor's own tests.
describe('readInterruptedAttemptInstall', () => {
  const versions = { targetVersion: TARGET, previousVersion: PREVIOUS };

  /** The supervisor's own reading of the scratch install; gate 3 names the fix itself, so nothing else is read. */
  function readingDeps(install: ScratchInstall): { deps: InterruptedAttemptReadingDeps } {
    return { deps: { readInstallVersions: () => readScratchInstallVersions(install) } };
  }

  /** Cut off after "Registering plugin", before "Setting up runtime": the target registered, its folders without dependencies. */
  function cutOffAfterRegistering(): ScratchInstall {
    const install = createScratchInstall();
    writeCompleteInstall(install, PREVIOUS);
    writeMarketplaceCopy(install, TARGET, 'missing');
    writeCacheVersion(install, TARGET, 'missing');
    writeRegistration(install, TARGET);
    return install;
  }

  it('the target registered but not resolvable: half-switched, with where the install is', async () => {
    const install = cutOffAfterRegistering();
    expect(readScratchInstallVersions(install).resolved).toBe(PREVIOUS);

    expect(await readInterruptedAttemptInstall(versions, readingDeps(install).deps)).toEqual({
      kind: 'half-switched',
      where: `The install resolves to ${PREVIOUS}; installed_plugins.json registers ${TARGET}; the marketplace copy is ${TARGET}.`,
    });
  });

  it('a marketplace copy cut off partway through, with everything else at the previous version: half-switched', async () => {
    const install = createScratchInstall();
    writeCompleteInstall(install, PREVIOUS);
    rmSync(path.join(install.marketplaceRoot, 'plugin'), { recursive: true, force: true });

    expect(await readInterruptedAttemptInstall(versions, readingDeps(install).deps)).toMatchObject({
      kind: 'half-switched',
      where: expect.stringContaining('the marketplace copy is incomplete: its package.json is 15.12.0, its plugin manifest missing or versionless, and its worker script missing'),
    });
  });

  it('everything at the previous version, with no marketplace copy or one intact at another older version (a Claude Code clone): on the previous version', async () => {
    const layouts: Array<(install: ScratchInstall) => void> = [
      (install) => writeCompleteInstall(install, PREVIOUS),
      cacheOnlyLayout(PREVIOUS),
      (install) => { cacheOnlyLayout(PREVIOUS)(install); writeMarketplaceCopy(install, '15.11.0', 'missing'); },
    ];
    for (const layout of layouts) {
      const install = createScratchInstall();
      layout(install);
      expect(await readInterruptedAttemptInstall(versions, readingDeps(install).deps)).toMatchObject({ kind: 'on-previous-version' });
    }
  });

  it('a version newer than the target in place: moved past it, nothing to fix', async () => {
    const install = createScratchInstall();
    writeCompleteInstall(install, NEWER);
    expect(await readInterruptedAttemptInstall(versions, readingDeps(install).deps)).toMatchObject({ kind: 'moved-past-target', newerVersion: NEWER });
  });
});

describe('readDatabaseSchemaStamp', () => {
  it('reads the stamp without writing to the database, and reports no database and an unreadable one', () => {
    const install = createScratchInstall();
    expect(readDatabaseSchemaStamp(install.databasePath)).toEqual({ kind: 'no-database' });
    writeDatabaseStamped(install, 74);
    const before = readFileSync(install.databasePath);
    expect(readDatabaseSchemaStamp(install.databasePath)).toEqual({ kind: 'stamped', schemaVersion: 74 });
    expect(readFileSync(install.databasePath).equals(before)).toBe(true);
    writeFileSync(install.databasePath, 'not a sqlite database');
    expect(readDatabaseSchemaStamp(install.databasePath)).toMatchObject({ kind: 'unreadable', message: expect.stringContaining(install.databasePath) });
  });
});

describe('writeOrphanedMarker', () => {
  let cacheRoot: string;

  beforeAll(() => {
    cacheRoot = mkdtempSync(path.join(scratchRoot, 'auto-update-orphaned-marker-'));
  });

  afterAll(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('writes the epoch-ms marker Claude Code writes, keeps one already there, and never creates the directory', () => {
    const versionDirectory = path.join(cacheRoot, TARGET);
    mkdirSync(versionDirectory);
    expect(writeOrphanedMarker(versionDirectory, NOW)).toEqual({ kind: 'stamped' });
    expect(readFileSync(path.join(versionDirectory, '.orphaned_at'), 'utf-8')).toBe(String(NOW));

    expect(writeOrphanedMarker(versionDirectory, NOW + MINUTE_MS)).toEqual({ kind: 'already-stamped' });
    expect(readFileSync(path.join(versionDirectory, '.orphaned_at'), 'utf-8')).toBe(String(NOW));

    const missing = path.join(cacheRoot, '99.0.0');
    expect(writeOrphanedMarker(missing, NOW)).toEqual({ kind: 'no-directory' });
    expect(existsSync(missing)).toBe(false);
  });

  it('reports any other write error instead of hiding it', () => {
    silenceLogger();
    const notADirectory = path.join(cacheRoot, 'a-file');
    writeFileSync(notADirectory, 'x');
    const result = writeOrphanedMarker(notADirectory, NOW);
    expect(result.kind).toBe('failed');
  });
});

/** Poll until every pid is gone (signal 0 fails) or the budget runs out. */
async function waitUntilGone(pids: number[], budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (pids.some(isPidAlive) && Date.now() < deadline) {
    // A short poll: the reap follows the kill almost at once.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
