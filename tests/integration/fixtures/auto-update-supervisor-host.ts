/**
 * Fixture host for auto-update-supervisor-survives-tree-kill.test.ts.
 *
 * Two roles, by argv[2]:
 *
 *   stand-in-parent   Plays the worker: launches the supervisor, prints
 *                     {"event":"launched",...}, then stays alive until the
 *                     test tree-kills it. AUTO_UPDATE_FIXTURE_LAUNCH picks how:
 *                       hop     the worker's real launcher: launchAutoUpdateSupervisor
 *                               with autoUpdateLaunchDeps, the effects
 *                               productionAutoUpdateLaunchDeps returns behind
 *                               the test tripwire. It writes the attempt into
 *                               DATA_DIR and starts `<this script>
 *                               auto-update-apply ... --detached-hop`, as the
 *                               worker starts its own script;
 *                       direct  the off baseline: the supervisor as a plain
 *                               child, with no hop.
 *   auto-update-apply The hop or the supervisor, through the production
 *                     command (runAutoUpdateApplyCommand) and the production
 *                     detached start, with the installer and the worker probes
 *                     replaced by harmless stand-ins: the "installer" is a Bun
 *                     one-liner that records its pid, waits
 *                     AUTO_UPDATE_FIXTURE_INSTALLER_MS and writes the version
 *                     it "installed".
 *
 * Everything it writes stays in AUTO_UPDATE_FIXTURE_DIR, a project-local
 * scratch directory the test creates and also passes as CLAUDE_MEM_DATA_DIR,
 * so the launcher's state file and attempt log land there too. It never runs
 * npx, never reads the real ~/.claude, never starts a worker and sends no
 * telemetry.
 */

import { spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeOrphanedMarker, type AutoUpdateApplyAttempt, type AutoUpdateApplyDeps, type InstallVersionsRead } from '../../../src/services/auto-update/auto-update-apply.js';
import {
  autoUpdateApplyArgv,
  autoUpdateAttemptLogPath,
  autoUpdateInstallerRunFolderName,
  autoUpdateLaunchDeps,
  launchAutoUpdateSupervisor,
  runAutoUpdateApplyCommand,
  runAutoUpdateInstaller,
  startDetachedAutoUpdateProcess,
  type AutoUpdateApplyCommandDeps,
} from '../../../src/services/auto-update/auto-update-launch.js';
import { autoUpdateStatePath, readAutoUpdateState, writeAutoUpdateState } from '../../../src/services/auto-update/auto-update-state.js';
import { LATEST_SCHEMA_VERSION } from '../../../src/services/sqlite/connection.js';
import { DATA_DIR } from '../../../src/shared/paths.js';
import { commandInvocation } from '../../../src/shared/spawn.js';

const FIXTURE_PATH = fileURLToPath(import.meta.url);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set by the test`);
  return value;
}

const fixtureDirectory = requiredEnv('AUTO_UPDATE_FIXTURE_DIR');
// The launcher writes into DATA_DIR: refuse to run anywhere but the test's scratch directory.
if (path.resolve(DATA_DIR) !== path.resolve(fixtureDirectory)) {
  throw new Error(`CLAUDE_MEM_DATA_DIR must be the fixture directory (${fixtureDirectory}), got DATA_DIR ${DATA_DIR}`);
}
const fixturePaths = {
  installedVersion: path.join(fixtureDirectory, 'installed-version'),
  installerPids: path.join(fixtureDirectory, 'installer-pids'),
  cache: path.join(fixtureDirectory, 'cache'),
};

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readInstalledVersion(): string | null {
  return existsSync(fixturePaths.installedVersion) ? readFileSync(fixturePaths.installedVersion, 'utf-8').trim() : null;
}

/** The stand-in install records its version in one file, so every reading reports it. */
function readFixtureInstallVersions(): InstallVersionsRead {
  const version = readInstalledVersion();
  return {
    resolved: version,
    registered: { kind: 'read', versions: version === null ? [] : [version] },
    marketplace: { packageVersion: version, pluginManifestVersion: version, hasWorkerScript: version !== null },
  };
}

/** The harmless installer: record its pid, wait, then "install" the version. */
function harmlessInstallerSource(version: string): string {
  const runMs = Number(requiredEnv('AUTO_UPDATE_FIXTURE_INSTALLER_MS'));
  return [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(fixturePaths.installerPids)}, process.pid + '\\n');`,
    `setTimeout(() => { fs.writeFileSync(${JSON.stringify(fixturePaths.installedVersion)}, ${JSON.stringify(version)}); process.exit(0); }, ${runMs});`,
  ].join('\n');
}

function fixtureApplyDeps(attempt: AutoUpdateApplyAttempt): AutoUpdateApplyDeps {
  return {
    now: Date.now,
    readState: () => readAutoUpdateState(),
    writeState: (state) => writeAutoUpdateState(state),
    processId: process.pid,
    getCurrentWorkerPid: async () => null,
    runInstaller: (version) => runAutoUpdateInstaller(
      commandInvocation(process.execPath, ['-e', harmlessInstallerSource(version)]),
      // Far past the stand-in installer's own run, so only a real hang would reach it.
      { logPath: autoUpdateAttemptLogPath(attempt.startedAt), deadlineMs: 120_000, runFolderName: autoUpdateInstallerRunFolderName(attempt.startedAt, version) },
    ),
    proveWorkerOnVersion: async (_oldPid, version) => readInstalledVersion() === version
      ? { ok: true, pid: process.pid }
      : { ok: false, startupFailed: false, detail: `installed-version is ${readInstalledVersion() ?? 'missing'}` },
    readInstallVersions: readFixtureInstallVersions,
    readDatabaseSchemaStamp: () => ({ kind: 'no-database' }),
    supervisorSchemaVersion: LATEST_SCHEMA_VERSION,
    pluginCacheDirectory: (version) => path.join(fixturePaths.cache, version),
    stampOrphaned: writeOrphanedMarker,
    // No worker runs here; the stand-in start below starts none either.
    readRunningWorker: async () => ({ kind: 'none' }),
    ensureWorkerStarted: async () => 'ready',
    readNpmPublication: async () => ({ kind: 'published' }),
    captureEvent: () => {},
  };
}

const fixtureCommandDeps: AutoUpdateApplyCommandDeps = {
  startSupervisor: (attempt) => startDetachedAutoUpdateProcess(
    process.execPath,
    autoUpdateApplyArgv(FIXTURE_PATH, attempt, { detachedHop: false }),
    { logPath: autoUpdateAttemptLogPath(attempt.startedAt), env: { ...process.env }, cwd: fixtureDirectory },
  ),
  buildApplyDeps: fixtureApplyDeps,
  flushTelemetry: async () => {},
};

async function runStandInParent(): Promise<void> {
  const versions = { targetVersion: requiredEnv('AUTO_UPDATE_FIXTURE_TARGET'), previousVersion: requiredEnv('AUTO_UPDATE_FIXTURE_PREVIOUS') };
  const launch = requiredEnv('AUTO_UPDATE_FIXTURE_LAUNCH');
  if (launch === 'hop') {
    // The worker's own launch, with this script in place of the worker's.
    await launchAutoUpdateSupervisor(versions, autoUpdateLaunchDeps({ scriptPath: FIXTURE_PATH }));
  } else if (launch === 'direct') {
    // The off baseline: the same record the launcher writes, then the
    // supervisor as a plain child, the shape the hop exists to avoid.
    const startedAt = Date.now();
    const state = readAutoUpdateState();
    state.inFlightAttempt = { ...versions, startedAt, supervisorPid: null };
    writeAutoUpdateState(state);
    const logPath = autoUpdateAttemptLogPath(startedAt);
    mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a');
    const supervisor = spawn(process.execPath, autoUpdateApplyArgv(FIXTURE_PATH, { ...versions, startedAt }, { detachedHop: false }), {
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
      cwd: fixtureDirectory,
    });
    supervisor.on('error', (error) => emit({ event: 'error', message: error.message }));
    closeSync(logFd);
  } else {
    throw new Error(`unknown AUTO_UPDATE_FIXTURE_LAUNCH ${launch}`);
  }
  emit({ event: 'launched', pid: process.pid, statePath: autoUpdateStatePath() });
  // Stay alive, as the worker does, until the test tree-kills this process.
  // The period does not matter: the interval only holds the event loop open.
  setInterval(() => {}, 1000);
}

async function main(): Promise<void> {
  const role = process.argv[2];
  if (role === 'stand-in-parent') {
    await runStandInParent();
    return;
  }
  if (role === 'auto-update-apply') {
    process.exit(await runAutoUpdateApplyCommand(process.argv.slice(3), fixtureCommandDeps));
  }
  throw new Error(`unknown role ${role}`);
}

main().catch((error: unknown) => {
  emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
