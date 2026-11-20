import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import type { AutoUpdateApplyDeps } from '../../../src/services/auto-update/auto-update-apply.js';
import {
  AUTO_UPDATE_APPLY_COMMAND,
  AutoUpdateApplyUsageError,
  FORBID_REAL_AUTO_UPDATE_ENV,
  autoUpdateApplyArgv,
  autoUpdateAttemptLogPath,
  autoUpdateInstallerEnv,
  autoUpdateInstallerFolder,
  autoUpdateInstallerRunFolderName,
  autoUpdateLaunchDeps,
  autoUpdateWorkerProof,
  claudeMemUpdateInvocation,
  findNpxForTheInstaller,
  type ClaudeMemUpdateInvocation,
  launchAutoUpdateSupervisor,
  makeAutoUpdateInstallerRunFolder,
  parseAutoUpdateApplyArguments,
  productionAutoUpdateApplyCommandDeps,
  productionAutoUpdateApplyDeps,
  productionAutoUpdateLaunchDeps,
  readRunningWorker,
  runAutoUpdateApplyCli,
  runAutoUpdateApplyCommand,
  runAutoUpdateInstaller,
  startDetachedAutoUpdateProcess,
  type AutoUpdateApplyCommandDeps,
  type AutoUpdateLaunchDeps,
  type StartedAutoUpdateProcess,
} from '../../../src/services/auto-update/auto-update-launch.js';
import { AutoUpdateLaunchError, NPM_PUBLIC_REGISTRY_URL, npmVersionMetadataUrl } from '../../../src/services/auto-update/auto-update-check.js';
import { AUTO_UPDATE_SUPERVISOR_DEADLINE_MS, WORKER_PID_CAPTURE_TIMEOUT_MS } from '../../../src/services/auto-update/auto-update-deadlines.js';
import { autoUpdateStatePath, defaultAutoUpdateState, type AutoUpdateState } from '../../../src/services/auto-update/auto-update-state.js';
import { LATEST_SCHEMA_VERSION } from '../../../src/services/sqlite/connection.js';
import type { PidInfo } from '../../../src/supervisor/process-registry.js';
import { spawnDaemon } from '../../../src/services/infrastructure/ProcessManager.js';
import { Server, type ServerOptions } from '../../../src/services/server/Server.js';
import { InitPhaseTracker } from '../../../src/services/server/init-phase.js';
import { INSTALL_RUN_BY_AUTO_UPDATE_ENV, withoutNpmSettingsFromAutoUpdateNpxFlags } from '../../../src/shared/auto-update-install-run.js';
import { paths } from '../../../src/shared/paths.js';
import { commandInvocation, type CommandInvocation } from '../../../src/shared/spawn.js';
import * as spawnModule from '../../../src/shared/spawn.js';
import { logger } from '../../../src/utils/logger.js';
import { listenOnEphemeralPort } from '../../helpers/ephemeral-port.js';

// The process plumbing around the supervisor. Real processes here are only
// harmless Bun one-liners started by the test itself; the production
// factories are checked to refuse under the test tripwire.

const TARGET = '15.13.0';
const PREVIOUS = '15.12.0';
const STARTED_AT = Date.UTC(2026, 10, 8, 10, 0, 0);
const attempt = { targetVersion: TARGET, previousVersion: PREVIOUS, startedAt: STARTED_AT };
/** A deadline or budget these runs never reach: each ends in milliseconds, or is refused before it starts. */
const NEVER_REACHED_DEADLINE_MS = 60_000;
/** The run folder the runner tests use; each run removes what an earlier one left, so one name serves them all. */
const RUN_FOLDER_NAME = autoUpdateInstallerRunFolderName(STARTED_AT, TARGET);
/**
 * Per-test limit for tests that start real Bun processes. Each starts and exits
 * in well under a second here; bun test's 5 s default is tight on a loaded runner.
 */
const REAL_PROCESS_TEST_TIMEOUT_MS = 30_000;

const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
let runDirectory: string;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  runDirectory = mkdtempSync(path.join(scratchRoot, 'auto-update-launch-'));
});

afterAll(() => {
  rmSync(runDirectory, { recursive: true, force: true });
});

afterEach(() => {
  mock.restore();
});

function silenceLogger() {
  return {
    info: spyOn(logger, 'info').mockImplementation(() => {}),
    warn: spyOn(logger, 'warn').mockImplementation(() => {}),
    error: spyOn(logger, 'error').mockImplementation(() => {}),
    debug: spyOn(logger, 'debug').mockImplementation(() => {}),
  };
}

let logCounter = 0;
const freshLogPath = (): string => path.join(runDirectory, `attempt-${++logCounter}.log`);

/** The command line claudeMemUpdateInvocation builds, when it found npx. */
function readyInvocation(result: ClaudeMemUpdateInvocation): CommandInvocation {
  if (result.kind !== 'ready') throw new Error(`expected an invocation, got ${JSON.stringify(result)}`);
  return result.invocation;
}

describe('the test tripwire: no test can start a real auto-update', () => {
  it('is set for every test process by tests/preload.ts', () => {
    expect(process.env[FORBID_REAL_AUTO_UPDATE_ENV]).toBe('1');
  });

  it('stops the worker\'s launcher, the hop and supervisor CLI, and the supervisor\'s effects before they act', async () => {
    const logs = silenceLogger();
    const spawned = spyOn(spawnModule, 'spawnHidden');
    const stateBefore = existsSync(autoUpdateStatePath()) ? readFileSync(autoUpdateStatePath(), 'utf-8') : null;
    const refusal = `${FORBID_REAL_AUTO_UPDATE_ENV} is set`;

    expect(() => productionAutoUpdateLaunchDeps({ scriptPath: '/never/run/worker-service.cjs' })).toThrow(refusal);
    expect(() => productionAutoUpdateApplyCommandDeps({ scriptPath: '/never/run/worker-service.cjs', port: 1 })).toThrow(refusal);
    expect(() => productionAutoUpdateApplyDeps({ port: 1, logPath: freshLogPath(), attemptStartedAt: STARTED_AT })).toThrow(refusal);
    // The dispatcher's case turns the refusal into a failed exit, even for a well-formed hop.
    const hopArgs = autoUpdateApplyArgv('/never/run/worker-service.cjs', attempt, { detachedHop: true }).slice(2);
    expect(await runAutoUpdateApplyCli(hopArgs, { scriptPath: '/never/run/worker-service.cjs', port: 1 })).toBe(1);
    expect(logs.error.mock.calls.map((call) => call[1])).toContain(`${AUTO_UPDATE_APPLY_COMMAND} refused to start`);

    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(autoUpdateStatePath()) ? readFileSync(autoUpdateStatePath(), 'utf-8') : null).toBe(stateBefore);
  });

  it('stops the installer runner for any claude-mem command line, however it was built, before it makes a folder, spawns or opens the log', async () => {
    const spawned = spyOn(spawnModule, 'spawnHidden');
    const logPath = freshLogPath();
    rmSync(path.join(autoUpdateInstallerFolder(), RUN_FOLDER_NAME), { recursive: true, force: true });
    for (const invocation of [
      readyInvocation(claudeMemUpdateInvocation(TARGET, 'darwin')),
      readyInvocation(claudeMemUpdateInvocation(TARGET, 'win32', () => 'C:\\Program Files\\nodejs\\npx.cmd')),
      commandInvocation('bunx', ['claude-mem@latest', 'install']),
    ]) {
      await expect(runAutoUpdateInstaller(invocation, { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME })).rejects.toThrow(`${FORBID_REAL_AUTO_UPDATE_ENV} is set`);
    }
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(path.join(autoUpdateInstallerFolder(), RUN_FOLDER_NAME))).toBe(false);
  });
});

describe('auto-update-apply arguments', () => {
  it('round-trips what the worker and the hop pass', () => {
    const hopArgv = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: true });
    expect(hopArgv).toEqual([
      '/plugin/scripts/worker-service.cjs', AUTO_UPDATE_APPLY_COMMAND,
      '--target-version', TARGET, '--previous-version', PREVIOUS, '--attempt-started-at', String(STARTED_AT), '--detached-hop',
    ]);
    expect(parseAutoUpdateApplyArguments(hopArgv.slice(2))).toEqual({ ...attempt, detachedHop: true });
    const supervisorArgv = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: false });
    expect(parseAutoUpdateApplyArguments(supervisorArgv.slice(2))).toEqual({ ...attempt, detachedHop: false });
  });

  it('accepts a prerelease previous version, the form an installed version can take', () => {
    expect(parseAutoUpdateApplyArguments(['--target-version', TARGET, '--previous-version', '15.12.0-beta.1', '--attempt-started-at', '1']))
      .toMatchObject({ previousVersion: '15.12.0-beta.1' });
  });

  it.each([
    [['--target-version', TARGET, '--previous-version', PREVIOUS], 'must be the attempt\'s start in epoch milliseconds'],
    [['--target-version', TARGET, '--previous-version', PREVIOUS, '--attempt-started-at', '12abc'], 'epoch milliseconds'],
    [['--target-version', 'latest', '--previous-version', PREVIOUS, '--attempt-started-at', '1'], 'exact X.Y.Z release'],
    [['--target-version', '15.13.0-beta.1', '--previous-version', PREVIOUS, '--attempt-started-at', '1'], 'exact X.Y.Z release'],
    [['--target-version', '15.13.0" & calc & "', '--previous-version', PREVIOUS, '--attempt-started-at', '1'], 'exact X.Y.Z release'],
    [['--target-version', TARGET, '--previous-version', '../15.12.0', '--attempt-started-at', '1'], 'must be a claude-mem version'],
    [['--target-version', TARGET, '--previous-version', '--attempt-started-at', '1'], '--previous-version needs a value'],
    [['--target-version', TARGET, '--target-version', TARGET], 'given twice'],
    [['--provider', 'claude'], 'Unknown argument "--provider"'],
  ] as Array<[string[], string]>)('refuses %j', (args, problem) => {
    expect(() => parseAutoUpdateApplyArguments(args)).toThrow(AutoUpdateApplyUsageError);
    expect(() => parseAutoUpdateApplyArguments(args)).toThrow(problem);
  });
});

describe('claudeMemUpdateInvocation', () => {
  it('is exactly `npx --yes --no-workspaces --package=claude-mem@<version> claude-mem update`: npx\'s three flags before the command, only `update` for the installer, and no --prefix', () => {
    expect(claudeMemUpdateInvocation(TARGET, 'linux')).toEqual({
      kind: 'ready',
      invocation: {
        command: 'npx',
        args: ['--yes', '--no-workspaces', `--package=claude-mem@${TARGET}`, 'claude-mem', 'update'],
        windowsVerbatimArguments: false,
      },
    });
  });

  it('runs the package\'s own bin, the only one it has, by name', () => {
    const packageJson = JSON.parse(readFileSync(path.join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf-8')) as { name: string; bin: Record<string, string> };
    expect(packageJson.name).toBe('claude-mem');
    expect(Object.keys(packageJson.bin)).toEqual(['claude-mem']);
    const { args } = readyInvocation(claudeMemUpdateInvocation(TARGET, 'linux'));
    expect(args.slice(args.indexOf(`--package=claude-mem@${TARGET}`) + 1)).toEqual(['claude-mem', 'update']);
  });

  it('runs the npx .cmd shim through cmd.exe on Windows, found the way the other installers find theirs, each argument quoted', () => {
    const lookups: string[] = [];
    const invocation = readyInvocation(claudeMemUpdateInvocation(TARGET, 'win32', (command) => { lookups.push(command); return 'C:\\Program Files\\nodejs\\npx.cmd'; }));
    expect(lookups).toEqual(['npx']);
    expect(invocation).toEqual({
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `""C:\\Program Files\\nodejs\\npx.cmd" "--yes" "--no-workspaces" "--package=claude-mem@${TARGET}" "claude-mem" "update""`],
      windowsVerbatimArguments: true,
    });
  });

  it('fails as npx-not-found on Windows when no npx is on PATH, never falling back to a bare npx.cmd that cmd.exe would look for in its working directory first', () => {
    expect(claudeMemUpdateInvocation(TARGET, 'win32', () => null)).toEqual({ kind: 'npx-not-found', message: 'npx was not found on PATH' });
  });

  it('refuses anything that is not a claude-mem version', () => {
    expect(() => claudeMemUpdateInvocation('latest', 'linux')).toThrow('not a claude-mem version');
  });
});

describe('findNpxForTheInstaller', () => {
  it('on Windows, is the lookup the installer run uses, so the worker finds npx exactly where the supervisor would', () => {
    const lookups: string[] = [];
    const findWindowsCommand = (command: string) => { lookups.push(command); return 'C:\\Program Files\\nodejs\\npx.cmd'; };
    const neverOnPath = () => { throw new Error('Bun.which is not the Windows lookup'); };
    expect(findNpxForTheInstaller('win32', findWindowsCommand, neverOnPath)).toBe('C:\\Program Files\\nodejs\\npx.cmd');
    expect(lookups).toEqual(['npx']);
    // None found there is none for the installer either (claudeMemUpdateInvocation: npx-not-found).
    expect(findNpxForTheInstaller('win32', () => null, neverOnPath)).toBeNull();
    expect(claudeMemUpdateInvocation(TARGET, 'win32', () => null).kind).toBe('npx-not-found');
  });

  it('elsewhere, looks the bare name the installer run starts up on PATH', () => {
    const lookups: string[] = [];
    const neverWindows = () => { throw new Error('the Windows lookup is for Windows only'); };
    expect(findNpxForTheInstaller('linux', neverWindows, (command) => { lookups.push(command); return '/usr/bin/npx'; })).toBe('/usr/bin/npx');
    expect(findNpxForTheInstaller('darwin', neverWindows, () => null)).toBeNull();
    expect(lookups).toEqual(['npx']);
    // The command it stands for: the bare `npx`.
    expect(readyInvocation(claudeMemUpdateInvocation(TARGET, 'linux')).command).toBe('npx');
  });

  it.skipIf(process.platform === 'win32')('reads the worker\'s own PATH by default, through Bun.which', () => {
    const binDirectory = mkdtempSync(path.join(runDirectory, 'npx-on-path-'));
    const npxShim = path.join(binDirectory, 'npx');
    writeFileSync(npxShim, '#!/bin/sh\nexit 0\n');
    chmodSync(npxShim, 0o755);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = binDirectory;
      expect(findNpxForTheInstaller()).toBe(npxShim);
      process.env.PATH = path.join(binDirectory, 'nothing-here');
      expect(findNpxForTheInstaller()).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('the installer\'s run folder (makeAutoUpdateInstallerRunFolder)', () => {
  it('is <data dir>/auto-update-installer/<attempt start>-<version>, under an absolute folder, and never a name that is not one plain path segment', () => {
    expect(autoUpdateInstallerFolder()).toBe(path.resolve(paths.dataDir(), 'auto-update-installer'));
    const dataDir = path.join(runDirectory, 'some-data-dir');
    expect(autoUpdateInstallerFolder(dataDir)).toBe(path.join(dataDir, 'auto-update-installer'));
    expect(path.isAbsolute(autoUpdateInstallerFolder(path.join('relative', 'data-dir')))).toBe(true);
    // The target's run and the restore run of one attempt each get a folder of their own.
    expect(autoUpdateInstallerRunFolderName(STARTED_AT, TARGET)).toBe(`${STARTED_AT}-${TARGET}`);
    expect(autoUpdateInstallerRunFolderName(STARTED_AT, PREVIOUS)).toBe(`${STARTED_AT}-${PREVIOUS}`);
    expect(autoUpdateInstallerRunFolderName(STARTED_AT, '15.12.0-beta.1')).toBe(`${STARTED_AT}-15.12.0-beta.1`);
    for (const [startedAt, version] of [[STARTED_AT, '../15.13.0'], [STARTED_AT, 'latest'], [Number.NaN, TARGET], [-1, TARGET]] as Array<[number, string]>) {
      expect(() => autoUpdateInstallerRunFolderName(startedAt, version)).toThrow('Refusing to name an installer folder');
    }
  });

  it('is made new for the run, holding only a private package.json that is not claude-mem, open to this user only, once what earlier runs left is removed', () => {
    const dataDir = mkdtempSync(path.join(runDirectory, 'data-dir-'));
    const installerFolder = autoUpdateInstallerFolder(dataDir);
    // What an earlier run could leave, in folders whose modes let anyone in.
    const earlierRun = path.join(installerFolder, autoUpdateInstallerRunFolderName(STARTED_AT - 1, PREVIOUS));
    mkdirSync(path.join(earlierRun, 'node_modules', 'claude-mem'), { recursive: true });
    writeFileSync(path.join(earlierRun, 'node_modules', 'claude-mem', 'package.json'), JSON.stringify({ name: 'claude-mem', version: TARGET }));
    writeFileSync(path.join(earlierRun, '.npmrc'), 'registry=https://registry.attacker.example/\n');
    writeFileSync(path.join(installerFolder, 'package.json'), JSON.stringify({ name: 'claude-mem', version: TARGET }));
    chmodSync(earlierRun, 0o777);
    chmodSync(installerFolder, 0o777);
    writeFileSync(path.join(dataDir, 'settings.json'), '{}');

    const runFolder = path.join(installerFolder, RUN_FOLDER_NAME);
    expect(makeAutoUpdateInstallerRunFolder(RUN_FOLDER_NAME, dataDir)).toEqual({ kind: 'made', path: runFolder });

    expect(readdirSync(installerFolder)).toEqual([RUN_FOLDER_NAME]);
    expect(readdirSync(runFolder)).toEqual(['package.json']);
    // No dependencies and no bin: the project npx loads there holds nothing it could run.
    expect(JSON.parse(readFileSync(path.join(runFolder, 'package.json'), 'utf-8'))).toEqual({ name: 'auto-update-installer-run', private: true });
    // Windows applies no mode; the folders take the data dir's permissions there.
    if (process.platform !== 'win32') {
      expect((statSync(installerFolder).mode & 0o777).toString(8)).toBe('700');
      expect((statSync(runFolder).mode & 0o777).toString(8)).toBe('700');
    }
    // Nothing else in the data dir is touched.
    expect(readdirSync(dataDir).sort()).toEqual(['auto-update-installer', 'settings.json']);
  });

  // A folder nothing can remove, as one a process still holds is on Windows: a file in a folder no one may write to.
  // Root removes it anyway, and Windows applies no mode.
  const canMakeAFolderUnremovable = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.skipIf(!canMakeAFolderUnremovable)('goes on when what an earlier run left cannot be removed, logging it, and fails as a result, never a throw, when that leftover holds its own name', () => {
    const logs = silenceLogger();
    const dataDir = mkdtempSync(path.join(runDirectory, 'data-dir-'));
    const installerFolder = autoUpdateInstallerFolder(dataDir);
    const stuckName = autoUpdateInstallerRunFolderName(STARTED_AT - 1, PREVIOUS);
    const stuckRun = path.join(installerFolder, stuckName);
    mkdirSync(path.join(stuckRun, 'locked'), { recursive: true });
    writeFileSync(path.join(stuckRun, 'locked', 'held'), '');
    chmodSync(path.join(stuckRun, 'locked'), 0o500);
    try {
      expect(makeAutoUpdateInstallerRunFolder(RUN_FOLDER_NAME, dataDir)).toEqual({ kind: 'made', path: path.join(installerFolder, RUN_FOLDER_NAME) });
      expect(existsSync(stuckRun)).toBe(true);
      expect(logs.warn.mock.calls.map((call) => call[1])).toContain('Could not remove a folder an earlier auto-update installer run left; the run goes on');

      // A run only ever stands in a folder it made itself.
      expect(makeAutoUpdateInstallerRunFolder(stuckName, dataDir)).toEqual({
        kind: 'failed',
        message: expect.stringContaining(`the folder ${stuckRun} could not be made: `),
      });
    } finally {
      chmodSync(path.join(stuckRun, 'locked'), 0o700);
    }
  });

  it('fails as a result, never a throw, when the installer folder cannot be made', () => {
    const dataDir = mkdtempSync(path.join(runDirectory, 'data-dir-'));
    writeFileSync(autoUpdateInstallerFolder(dataDir), 'not a folder');
    expect(makeAutoUpdateInstallerRunFolder(RUN_FOLDER_NAME, dataDir)).toEqual({
      kind: 'failed',
      message: expect.stringContaining(`the folder ${autoUpdateInstallerFolder(dataDir)} could not be made: `),
    });
  });


});

describe('autoUpdateInstallerEnv', () => {
  /** What a worker started from a hostile project could pass down: a registry in every spelling npm and bun read, beside the user's proxy settings. */
  const inherited: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/Users/someone',
    npm_config_registry: 'https://registry.attacker.example/',
    NPM_CONFIG_REGISTRY: 'https://registry.attacker.example/',
    Npm_Config_Registry: 'https://registry.attacker.example/',
    BUN_CONFIG_REGISTRY: 'https://bun.attacker.example/',
    bun_config_registry: 'https://bun.attacker.example/',
    HTTPS_PROXY: 'http://proxy.corp.example:3128',
    https_proxy: 'http://proxy.corp.example:3128',
    NO_PROXY: 'localhost,127.0.0.1',
    npm_config_proxy: 'http://proxy.corp.example:3128',
    npm_config_https_proxy: 'http://proxy.corp.example:3128',
    npm_config_noproxy: 'localhost',
    // Settings that only share the prefix are not the registry.
    npm_config_registry_timeout: '30000',
  };

  it('sets the registry gate 7 read in every name npm and bun read, removes every inherited spelling, and keeps the proxy settings and the rest', () => {
    const env = autoUpdateInstallerEnv(inherited);
    expect(NPM_PUBLIC_REGISTRY_URL).toBe('https://registry.npmjs.org/');
    expect(npmVersionMetadataUrl(TARGET).startsWith(NPM_PUBLIC_REGISTRY_URL)).toBe(true);
    const registryNames = Object.keys(env).filter((name) => /^(?:npm|bun)_config_registry$/i.test(name)).sort();
    expect(Object.fromEntries(registryNames.map((name) => [name, env[name]]))).toEqual({
      BUN_CONFIG_REGISTRY: NPM_PUBLIC_REGISTRY_URL,
      NPM_CONFIG_REGISTRY: NPM_PUBLIC_REGISTRY_URL,
      npm_config_registry: NPM_PUBLIC_REGISTRY_URL,
    });
    expect(env).toMatchObject({
      PATH: inherited.PATH,
      HOME: inherited.HOME,
      HTTPS_PROXY: inherited.HTTPS_PROXY,
      https_proxy: inherited.https_proxy,
      NO_PROXY: inherited.NO_PROXY,
      npm_config_proxy: inherited.npm_config_proxy,
      npm_config_https_proxy: inherited.npm_config_https_proxy,
      npm_config_noproxy: inherited.npm_config_noproxy,
      npm_config_registry_timeout: '30000',
      [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1',
    });
    // The supervisor's own environment is not changed.
    expect(inherited.NPM_CONFIG_REGISTRY).toBe('https://registry.attacker.example/');
  });

  // npm itself, as npx runs it: its env layer outranks every npmrc file, so neither an inherited variable nor a
  // user npmrc's registry line moves it. Read only (`npm config get` makes no request), with its logs, cache and
  // update check kept out of the real home folder. npm is a .cmd shim on Windows, which this spawn cannot start.
  const npmOnPath = Bun.which('npm');
  it.skipIf(process.platform === 'win32' || npmOnPath === null)('is the registry real npm resolves, over an inherited variable and a user npmrc that name another', () => {
    const npmScratch = mkdtempSync(path.join(runDirectory, 'npm-config-'));
    const userNpmrc = path.join(npmScratch, 'user.npmrc');
    writeFileSync(userNpmrc, 'registry=https://npmrc.attacker.example/\n');
    const env = autoUpdateInstallerEnv({
      ...process.env,
      ...inherited,
      PATH: process.env.PATH,
      HOME: npmScratch,
      npm_config_userconfig: userNpmrc,
      npm_config_cache: path.join(npmScratch, 'cache'),
      npm_config_logs_max: '0',
      npm_config_update_notifier: 'false',
    });
    const resolved = execFileSync(npmOnPath!, ['config', 'get', 'registry'], { cwd: npmScratch, env, encoding: 'utf-8' }).trim();
    expect(resolved).toBe(NPM_PUBLIC_REGISTRY_URL);
    // The same npm reads the user npmrc's line once no registry variable is set.
    const withoutTheVariables = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:npm|bun)_config_registry$/i.test(name)));
    const withoutIt = execFileSync(npmOnPath!, ['config', 'get', 'registry'], { cwd: npmScratch, env: withoutTheVariables, encoding: 'utf-8' }).trim();
    expect(withoutIt).toBe('https://npmrc.attacker.example/');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);
});

describe('the worker an installer run starts: no npm package or yes setting from the auto-updater\'s npx flags', () => {
  /** What npx passes on from a machine's own npm setup, which the worker keeps: its global prefix and npmrc files, and a proxy one of them sets. */
  const machinesOwnNpmSettings: NodeJS.ProcessEnv = {
    npm_config_prefix: '/home/someone/.nvm/versions/node/v24.5.0',
    npm_config_global_prefix: '/home/someone/.nvm/versions/node/v24.5.0',
    npm_config_globalconfig: '/home/someone/.nvm/versions/node/v24.5.0/etc/npmrc',
    npm_config_userconfig: '/home/someone/.npmrc',
    npm_config_proxy: 'http://proxy.corp.example:3128/',
    // npm's own name for the run folder, which no npm setting reads.
    npm_config_local_prefix: `/home/someone/.claude-mem/auto-update-installer/${RUN_FOLDER_NAME}`,
  };

  it('leaves out npm_config_package and npm_config_yes, in any case, when the run is the auto-updater\'s, and nothing else', () => {
    const fromNpx: NodeJS.ProcessEnv = {
      [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1',
      PATH: '/usr/bin:/bin',
      ...machinesOwnNpmSettings,
      npm_config_package: `claude-mem@${TARGET}`,
      NPM_CONFIG_PACKAGE: `claude-mem@${TARGET}`,
      Npm_Config_Package: `claude-mem@${TARGET}`,
      npm_config_yes: 'true',
      NPM_CONFIG_YES: 'true',
      Npm_Config_Yes: 'true',
      // Not one of the two settings, though named like them: npm_config_package_lock is npm's package-lock.
      npm_config_package_lock: 'false',
      npm_config_yes_something: 'kept',
    };
    expect(withoutNpmSettingsFromAutoUpdateNpxFlags(fromNpx)).toEqual({
      [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1',
      PATH: '/usr/bin:/bin',
      ...machinesOwnNpmSettings,
      npm_config_package_lock: 'false',
      npm_config_yes_something: 'kept',
    });
    // The environment it was given is not changed.
    expect(fromNpx.npm_config_package).toBe(`claude-mem@${TARGET}`);
    expect(fromNpx.npm_config_yes).toBe('true');
  });

  it.each([
    ['no marker', undefined],
    ['an empty marker', ''],
    ['a marker with another value', 'true'],
  ])('keeps npm_config_package and npm_config_yes for a person\'s own install: %s', (_case, marker) => {
    const env: NodeJS.ProcessEnv = {
      [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: marker,
      ...machinesOwnNpmSettings,
      npm_config_package: `claude-mem@${TARGET}`,
      npm_config_yes: 'true',
    };
    expect(withoutNpmSettingsFromAutoUpdateNpxFlags(env)).toEqual(env);
  });

  /**
   * The environment spawnDaemon gives the worker, with `variables` set on this process (undefined removes one),
   * caught where it would start the worker: spawn.ts spawnHidden, which starts nothing here.
   */
  function workerEnvironmentFromSpawnDaemon(variables: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const started: NodeJS.ProcessEnv[] = [];
    spyOn(spawnModule, 'spawnHidden').mockImplementation(((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      started.push(options.env);
      return Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
    }) as unknown as typeof spawnModule.spawnHidden);
    const saved = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
    const apply = (values: Record<string, string | undefined>): void => {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
    try {
      apply(variables);
      expect(spawnDaemon('/never/run/worker-service.cjs', 39999)).toBe(4242);
    } finally {
      apply(saved);
    }
    expect(started).toHaveLength(1);
    return started[0]!;
  }

  it('is what spawnDaemon gives the worker: from the auto-updater\'s installer no npm_config_package or npm_config_yes, but the machine\'s npm prefix and npmrc settings; from a person\'s own install all of it', () => {
    const autoUpdateRun = workerEnvironmentFromSpawnDaemon({
      [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1',
      ...machinesOwnNpmSettings,
      npm_config_package: `claude-mem@${TARGET}`,
      npm_config_yes: 'true',
      // Windows keeps one variable per name in any case; elsewhere another spelling, such as the shell's own, can sit beside npx's.
      ...(process.platform === 'win32' ? {} : { NPM_CONFIG_PACKAGE: 'cowsay@1.6.0', NPM_CONFIG_YES: 'false' }),
    });
    expect(Object.keys(autoUpdateRun).filter((name) => /^npm_config_(?:package|yes)$/i.test(name))).toEqual([]);
    expect(autoUpdateRun).toMatchObject({ [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1', CLAUDE_MEM_WORKER_PORT: '39999', ...machinesOwnNpmSettings });

    const personsOwnInstall = workerEnvironmentFromSpawnDaemon({
      [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: undefined,
      npm_config_package: `claude-mem@${TARGET}`,
      npm_config_yes: 'true',
    });
    expect(personsOwnInstall.npm_config_package).toBe(`claude-mem@${TARGET}`);
    expect(personsOwnInstall.npm_config_yes).toBe('true');
  });
});

describe('runAutoUpdateInstaller', () => {
  const bunScript = (source: string) => commandInvocation(process.execPath, ['-e', source]);

  it('runs the installer in a new folder of its own, holding only its package.json and open to this user only, never in the supervisor\'s working directory', async () => {
    // What an earlier run left in the installer folder, with a mode that lets anyone in.
    const earlierRun = path.join(autoUpdateInstallerFolder(), autoUpdateInstallerRunFolderName(STARTED_AT - 1, PREVIOUS));
    mkdirSync(path.join(earlierRun, 'node_modules', 'claude-mem'), { recursive: true });
    writeFileSync(path.join(earlierRun, 'package.json'), JSON.stringify({ name: 'claude-mem', version: TARGET }));
    chmodSync(earlierRun, 0o777);
    // The sandbox run's supervisor (daemonWorkingDirectory): a data dir inside a source checkout whose package is claude-mem at the target version.
    const checkout = mkdtempSync(path.join(runDirectory, 'checkout-'));
    writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'claude-mem', version: TARGET, bin: { 'claude-mem': './dist/npx-cli/index.js' } }));
    const supervisorWorkingDirectory = path.join(checkout, '.scratch', 'claude-mem-data');
    mkdirSync(supervisorWorkingDirectory, { recursive: true });
    const logPath = freshLogPath();
    const testWorkingDirectory = process.cwd();
    process.chdir(supervisorWorkingDirectory);
    try {
      expect(await runAutoUpdateInstaller(bunScript([
        "const fs = require('fs');",
        "const folder = { cwd: process.cwd(), entries: fs.readdirSync('.'), mode: (fs.statSync('.').mode & 0o777).toString(8), packageJson: JSON.parse(fs.readFileSync('package.json', 'utf-8')) };",
        "process.stdout.write('installer-folder=' + JSON.stringify(folder) + '\\n');",
      ].join('\n')), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME }))
        .toEqual({ kind: 'exited', exitCode: 0, signal: null });
    } finally {
      process.chdir(testWorkingDirectory);
    }

    const folder = path.join(autoUpdateInstallerFolder(), RUN_FOLDER_NAME);
    const log = readFileSync(logPath, 'utf-8');
    // Its own output line; the "running:" line before it quotes the script.
    const reported = JSON.parse(/^installer-folder=(.+)$/m.exec(log)?.[1] ?? 'null') as { cwd: string; entries: string[]; mode: string; packageJson: unknown } | null;
    // The child reports its working directory with symlinks resolved (macOS's temp dir is under /private).
    expect(reported?.cwd).toBe(realpathSync(folder));
    expect(reported?.entries).toEqual(['package.json']);
    expect(reported?.packageJson).toEqual({ name: 'auto-update-installer-run', private: true });
    // Windows applies no mode; the folder takes the data dir's permissions there.
    if (process.platform !== 'win32') expect(reported?.mode).toBe('700');
    expect(existsSync(earlierRun)).toBe(false);
    expect(log).toContain(` in ${folder} (deadline `);
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('reports a run whose folder cannot be made as folder-failed, never a throw: nothing starts, and the attempt log says why', async () => {
    const spawned = spyOn(spawnModule, 'spawnHidden');
    const logPath = freshLogPath();
    // A file where the installer folder goes, so mkdir fails, as a leftover a process still holds can make it fail on Windows.
    const installerFolder = autoUpdateInstallerFolder();
    rmSync(installerFolder, { recursive: true, force: true });
    writeFileSync(installerFolder, 'not a folder');
    let run: Awaited<ReturnType<typeof runAutoUpdateInstaller>>;
    try {
      run = await runAutoUpdateInstaller(bunScript('process.exit(0)'), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME });
    } finally {
      rmSync(installerFolder, { force: true });
    }
    const folderNotMade = `the folder ${installerFolder} could not be made: `;
    expect(run).toEqual({ kind: 'folder-failed', message: expect.stringContaining(folderNotMade) });
    expect(spawned).not.toHaveBeenCalled();
    expect(readFileSync(logPath, 'utf-8')).toContain(`not running: ${process.execPath} -e process.exit(0): ${folderNotMade}`);
  });

  it('gives the installer no stdin and no TTY, so it takes the non-interactive path, and appends its output to the attempt log', async () => {
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(bunScript([
      "process.stdout.write(JSON.stringify({ stdinIsTTY: process.stdin.isTTY ?? null }));",
      "let received = '';",
      "process.stdin.on('data', (chunk) => { received += chunk; });",
      "process.stdin.on('end', () => { process.stdout.write(' stdin-ended-with-bytes:' + received.length); process.exit(3); });",
    ].join('\n')), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME });

    expect(run).toEqual({ kind: 'exited', exitCode: 3, signal: null });
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('{"stdinIsTTY":null} stdin-ended-with-bytes:0');
    expect(log).toContain('running: ');
    expect(log).toContain('installer exited (code 3, signal none)');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('inherits the supervisor\'s environment', async () => {
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(bunScript(`process.stdout.write('tripwire=' + process.env.${FORBID_REAL_AUTO_UPDATE_ENV})`), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME });
    expect(run).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(readFileSync(logPath, 'utf-8')).toContain('tripwire=1');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('reports an installer that cannot start: Bun returns no pid and emits ENOENT after spawn returned', async () => {
    const logs = silenceLogger();
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(commandInvocation(path.join(runDirectory, 'missing-npx'), ['--yes']), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME });
    expect(run).toMatchObject({ kind: 'spawn-failed', message: expect.stringContaining('ENOENT') });
    expect(readFileSync(logPath, 'utf-8')).toContain('could not start the installer');
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('reports a spawn that throws', async () => {
    const run = await runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath: freshLogPath(),
      deadlineMs: NEVER_REACHED_DEADLINE_MS,
      runFolderName: RUN_FOLDER_NAME,
      spawnImplementation: (() => { throw new Error('spawn EAGAIN'); }) as never,
    });
    expect(run).toEqual({ kind: 'spawn-failed', message: 'spawn EAGAIN' });
  });

  it('logs an error the child reports after it started, and keeps waiting for its exit', async () => {
    const logs = silenceLogger();
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref() {} });
    const runPromise = runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath: freshLogPath(),
      deadlineMs: NEVER_REACHED_DEADLINE_MS,
      runFolderName: RUN_FOLDER_NAME,
      spawnImplementation: (() => child) as never,
    });
    child.emit('spawn');
    child.emit('error', new Error('kill EPERM'));
    child.emit('exit', 0, null);
    expect(await runPromise).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(logs.warn.mock.calls.map((call) => call[1])).toContain('The auto-update installer reported an error after it started');
  });

  it('kills the tree at the deadline, and records a kill that failed', async () => {
    silenceLogger();
    const killed: number[] = [];
    const logPath = freshLogPath();
    const child = Object.assign(new EventEmitter(), { pid: 4322, unref() {} });
    const run = await runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath,
      // The shortest real timer: this child never exits on its own.
      deadlineMs: 1,
      runFolderName: RUN_FOLDER_NAME,
      spawnImplementation: (() => { setTimeout(() => child.emit('spawn'), 0); return child; }) as never,
      killProcessTree: async (pid) => {
        killed.push(pid);
        // The exit the kill causes arrives before the kill call returns, and must not read as the installer's own exit.
        child.emit('exit', null, 'SIGTERM');
        throw new Error('taskkill failed: Access is denied');
      },
    });
    expect(killed).toEqual([4322]);
    // The installer did exit, so no installer is left running, but the kill is still reported as failed.
    expect(run).toEqual({ kind: 'timed-out', deadlineMs: 1, killError: 'taskkill failed: Access is denied', installerPid: 4322, installerStillRunning: false });
    expect(readFileSync(logPath, 'utf-8')).toContain('killing its process tree failed: taskkill failed: Access is denied; it exited');
  });

  it('reports an installer still running after the kill, whether the kill threw or returned, and logs it as failed', async () => {
    for (const kill of [async () => {}, async () => { throw new Error('kill EPERM'); }]) {
      const logs = silenceLogger();
      const logPath = freshLogPath();
      const child = Object.assign(new EventEmitter(), { pid: 4324, unref() {} });
      const run = await runAutoUpdateInstaller(commandInvocation('npm-like', []), {
        logPath,
        // The shortest real timers: this child never exits, not even when killed.
        deadlineMs: 1,
        runFolderName: RUN_FOLDER_NAME,
        exitAfterKillWaitMs: 1,
        spawnImplementation: (() => { setTimeout(() => child.emit('spawn'), 0); return child; }) as never,
        killProcessTree: kill,
      });
      expect(run).toMatchObject({ kind: 'timed-out', installerPid: 4324, installerStillRunning: true });
      expect(readFileSync(logPath, 'utf-8')).toContain('pid 4324 was still running 1 ms later');
      expect(logs.error.mock.calls.map((call) => call[1])).toContain('The auto-update installer was still running after its process tree was killed');
      mock.restore();
    }
  });

  it('marks the run as the auto-updater\'s in the installer\'s environment, and keeps the rest of it', async () => {
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(bunScript(`process.stdout.write('marker=' + process.env.${INSTALL_RUN_BY_AUTO_UPDATE_ENV} + ' path=' + Boolean(process.env.PATH))`), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME });
    expect(run).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(readFileSync(logPath, 'utf-8')).toContain('marker=1 path=true');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('installs from the registry gate 7 read, whatever registry the supervisor inherited', async () => {
    const logPath = freshLogPath();
    const inherited = { NPM_CONFIG_REGISTRY: 'https://registry.attacker.example/', BUN_CONFIG_REGISTRY: 'https://bun.attacker.example/' };
    const saved = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]));
    Object.assign(process.env, inherited);
    let run: Awaited<ReturnType<typeof runAutoUpdateInstaller>>;
    try {
      run = await runAutoUpdateInstaller(bunScript([
        "const registryNames = Object.keys(process.env).filter((name) => /^(?:npm|bun)_config_registry$/i.test(name)).sort();",
        "process.stdout.write('registries=' + JSON.stringify(Object.fromEntries(registryNames.map((name) => [name, process.env[name]]))));",
      ].join('\n')), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS, runFolderName: RUN_FOLDER_NAME });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(run).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    const reported = /registries=(\{.*\})/.exec(readFileSync(logPath, 'utf-8'))?.[1] ?? '{}';
    const registries = Object.values(JSON.parse(reported) as Record<string, string>);
    expect(registries.length).toBeGreaterThan(0);
    expect(new Set(registries)).toEqual(new Set([NPM_PUBLIC_REGISTRY_URL]));
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('settles even when its handle on the attempt log cannot be closed, and logs that', async () => {
    const logs = silenceLogger();
    const child = Object.assign(new EventEmitter(), { pid: 4325, unref() {} });
    const runPromise = runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath: freshLogPath(),
      deadlineMs: NEVER_REACHED_DEADLINE_MS,
      runFolderName: RUN_FOLDER_NAME,
      // Close the descriptor the runner passes as the child's stdout, so its own close then fails with EBADF.
      spawnImplementation: ((_command: string, _args: string[], options: { stdio: [unknown, number, number] }) => { closeSync(options.stdio[1]); return child; }) as never,
    });
    child.emit('spawn');
    child.emit('exit', 0, null);
    expect(await runPromise).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(logs.warn.mock.calls.map((call) => call[1])).toContain('Could not close the supervisor\'s handle on the attempt log');
  });
});

describe('startDetachedAutoUpdateProcess', () => {
  it('starts a process in its own process group, with its output in the attempt log', async () => {
    const logPath = freshLogPath();
    const started = await startDetachedAutoUpdateProcess(process.execPath, ['-e', "console.log('hop says hi')"], {
      logPath,
      env: { ...process.env },
      cwd: runDirectory,
    });
    if (process.platform !== 'win32') {
      const processGroup = execFileSync('ps', ['-o', 'pgid=', '-p', String(started.pid)], { encoding: 'utf-8' }).trim();
      expect(Number(processGroup)).toBe(started.pid);
    }
    expect(await started.exited).toEqual({ exitCode: 0, signal: null });
    expect(readFileSync(logPath, 'utf-8')).toContain('hop says hi');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('rejects, with no process started, when the runtime cannot be started, including the ENOENT that arrives after spawn returned', async () => {
    const start = startDetachedAutoUpdateProcess(path.join(runDirectory, 'missing-bun'), [], {
      logPath: freshLogPath(),
      env: {},
      cwd: runDirectory,
    });
    await expect(start).rejects.toThrow('ENOENT');
    await expect(start).rejects.toMatchObject({ name: 'AutoUpdateLaunchError', processStarted: false });
  });

  it('rejects, with no process started, when spawn throws', async () => {
    const start = startDetachedAutoUpdateProcess('bun', [], {
      logPath: freshLogPath(),
      env: {},
      cwd: runDirectory,
      spawnImplementation: (() => { throw new Error('spawn EMFILE'); }) as never,
    });
    await expect(start).rejects.toThrow('could not start bun: spawn EMFILE');
    await expect(start).rejects.toMatchObject({ name: 'AutoUpdateLaunchError', processStarted: false });
  });

  it('rejects, with no process started and nothing spawned, when the attempt log cannot be opened', async () => {
    const spawned: string[] = [];
    // A file where the log's folder would be.
    const notAFolder = path.join(runDirectory, `not-a-folder-${++logCounter}`);
    writeFileSync(notAFolder, 'x');
    const start = startDetachedAutoUpdateProcess('bun', [], {
      logPath: path.join(notAFolder, 'attempt.log'),
      env: {},
      cwd: runDirectory,
      spawnImplementation: ((command: string) => { spawned.push(command); throw new Error('not expected'); }) as never,
    });
    await expect(start).rejects.toThrow(`could not start bun: its log ${path.join(notAFolder, 'attempt.log')} could not be opened`);
    await expect(start).rejects.toMatchObject({ name: 'AutoUpdateLaunchError', processStarted: false });
    expect(spawned).toEqual([]);
  });

  it('rejects as a process that may have started when spawn reports it without a pid', async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref() {} });
    const start = startDetachedAutoUpdateProcess('bun', [], {
      logPath: freshLogPath(),
      env: {},
      cwd: runDirectory,
      spawnImplementation: (() => child) as never,
    });
    child.emit('spawn');
    await expect(start).rejects.toThrow('could not start bun: it started without a pid');
    await expect(start).rejects.toMatchObject({ name: 'AutoUpdateLaunchError', processStarted: true });
  });

  it('logs an error after the process started instead of leaving it unhandled', async () => {
    const logs = silenceLogger();
    const child = Object.assign(new EventEmitter(), { pid: 4323, unref() {} });
    const startedPromise = startDetachedAutoUpdateProcess('bun', [], {
      logPath: freshLogPath(),
      env: {},
      cwd: runDirectory,
      spawnImplementation: (() => child) as never,
    });
    child.emit('spawn');
    const started = await startedPromise;
    child.emit('error', new Error('late failure'));
    expect(started.pid).toBe(4323);
    expect(logs.warn.mock.calls.map((call) => call[1])).toContain('An auto-update process reported an error after it started');
  });
});

describe('launchAutoUpdateSupervisor (the worker\'s side)', () => {
  function fakeHop(exit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>, pid = 6161): StartedAutoUpdateProcess {
    return { child: Object.assign(new EventEmitter(), { unref() {} }) as never, pid, exited: exit };
  }

  function launchHarness(startHop: AutoUpdateLaunchDeps['startHop'], overrides: Partial<AutoUpdateLaunchDeps> = {}) {
    let stored: AutoUpdateState = { ...defaultAutoUpdateState(), lastSeenPromotedVersion: TARGET };
    const events: string[] = [];
    const killed: number[] = [];
    const deps: AutoUpdateLaunchDeps = {
      now: () => STARTED_AT,
      readState: () => structuredClone(stored),
      writeState: (state) => { events.push('write-state'); stored = structuredClone(state); },
      supervisorDeadlineMs: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS,
      startHop: async (hopAttempt) => { events.push(`start-hop ${JSON.stringify(hopAttempt)}`); return startHop(hopAttempt); },
      hopExitBudgetMs: NEVER_REACHED_DEADLINE_MS,
      killProcessTree: async (pid) => { killed.push(pid); },
      attemptLogPath: (startedAt) => `/logs/auto-update-${startedAt}.log`,
      ...overrides,
    };
    return { deps, stored: () => stored, events, killed };
  }

  it('records the attempt in flight before it starts the hop, and returns once the hop exits 0', async () => {
    silenceLogger();
    const harness = launchHarness(async () => fakeHop(Promise.resolve({ exitCode: 0, signal: null })));
    await launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    expect(harness.events).toEqual(['write-state', `start-hop ${JSON.stringify(attempt)}`]);
    // The deadline is recorded so the SessionStart launcher, which cannot compute it, can tell an interrupted attempt.
    expect(harness.stored().inFlightAttempt).toStrictEqual({ ...attempt, supervisorPid: null, supervisorDeadlineMs: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS });
    expect(harness.stored().lastSeenPromotedVersion).toBe(TARGET);
  });

  // Gate 9 keeps the attempt in flight whenever a process of the launch was
  // started (AutoUpdateLaunchError.processStarted): its supervisor may be running.
  const processStarted = { name: 'AutoUpdateLaunchError', processStarted: true };

  it('throws when the hop exits non-zero, naming the attempt log, as a launch that started a process', async () => {
    const harness = launchHarness(async () => fakeHop(Promise.resolve({ exitCode: 1, signal: null })));
    const launch = launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    await expect(launch).rejects.toThrow(`the auto-update hop (pid 6161) exited with code 1 before the supervisor was started; see /logs/auto-update-${STARTED_AT}.log`);
    await expect(launch).rejects.toMatchObject(processStarted);
  });

  it('passes on a hop start that never began as a launch that started no process', async () => {
    const neverBegan = new AutoUpdateLaunchError('could not start /missing/bun: spawn ENOENT', false);
    const harness = launchHarness(async () => { throw neverBegan; });
    const launch = launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    await expect(launch).rejects.toBe(neverBegan);
    await expect(launch).rejects.toMatchObject({ name: 'AutoUpdateLaunchError', processStarted: false });
  });

  it('throws on any other failure to start the hop as a launch that may have started a process', async () => {
    const harness = launchHarness(async () => { throw new Error('could not start /missing/bun: spawn ENOENT'); });
    const launch = launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    await expect(launch).rejects.toThrow('spawn ENOENT');
    await expect(launch).rejects.toMatchObject(processStarted);
  });

  it('kills a hop that outlives its budget, and throws as a launch that started a process', async () => {
    silenceLogger();
    const harness = launchHarness(async () => fakeHop(new Promise(() => {})), { hopExitBudgetMs: 1 });
    const launch = launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    await expect(launch).rejects.toThrow('did not exit within 0 s, so it was killed');
    await expect(launch).rejects.toMatchObject(processStarted);
    expect(harness.killed).toEqual([6161]);
  });

  it('reports a kill of the hop that failed as failed, never as killed, and as a launch that started a process', async () => {
    const logs = silenceLogger();
    const harness = launchHarness(async () => fakeHop(new Promise(() => {})), {
      hopExitBudgetMs: 1,
      killProcessTree: async () => { throw new Error('tree-kill failed for PID 6161: EPERM'); },
    });
    const launch = launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    await expect(launch).rejects.toThrow('did not exit within 0 s, and killing it failed (tree-kill failed for PID 6161: EPERM), so it may still be running');
    await expect(launch).rejects.not.toThrow('so it was killed');
    await expect(launch).rejects.toMatchObject(processStarted);
    expect(logs.error.mock.calls.map((call) => call[1])).toContain('Could not kill an auto-update hop that outlived its budget');
  });

  it('starts the hop through the production launcher\'s own effects: the worker\'s script with --detached-hop, output in the attempt log', async () => {
    // A stand-in worker script that prints its arguments; the real one would refuse under the tripwire anyway.
    const scriptPath = path.join(runDirectory, 'print-argv.cjs');
    writeFileSync(scriptPath, "console.log('argv=' + JSON.stringify(process.argv.slice(2)));\n");
    const deps = autoUpdateLaunchDeps({ scriptPath });

    const hop = await deps.startHop(attempt);

    expect(await hop.exited).toEqual({ exitCode: 0, signal: null });
    expect(deps.attemptLogPath(STARTED_AT)).toBe(autoUpdateAttemptLogPath(STARTED_AT, paths.logsDir()));
    expect(readFileSync(deps.attemptLogPath(STARTED_AT), 'utf-8')).toContain(`argv=${JSON.stringify(autoUpdateApplyArgv(scriptPath, attempt, { detachedHop: true }).slice(1))}`);
    rmSync(deps.attemptLogPath(STARTED_AT), { force: true });
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('records the supervisor deadline gate 3 uses, as this worker computes it', () => {
    expect(autoUpdateLaunchDeps({ scriptPath: '/never/run/worker-service.cjs' }).supervisorDeadlineMs).toBe(AUTO_UPDATE_SUPERVISOR_DEADLINE_MS);
  });
});

describe('runAutoUpdateApplyCommand', () => {
  const hopArgs = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: true }).slice(2);
  const supervisorArgs = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: false }).slice(2);

  function commandHarness(overrides: Partial<AutoUpdateApplyCommandDeps> = {}) {
    const calls: string[] = [];
    let unrefs = 0;
    const deps: AutoUpdateApplyCommandDeps = {
      startSupervisor: async (supervisorAttempt) => {
        calls.push(`start-supervisor ${JSON.stringify(supervisorAttempt)}`);
        return { child: { unref: () => { unrefs++; } } as never, pid: 7171, exited: new Promise(() => {}) };
      },
      buildApplyDeps: () => { calls.push('build-apply-deps'); throw new Error('not expected'); },
      flushTelemetry: async () => { calls.push('flush-telemetry'); },
      ...overrides,
    };
    return { deps, calls, unrefs: () => unrefs };
  }

  it('as the hop: starts the supervisor, lets it go, exits 0, and runs no supervisor code itself', async () => {
    silenceLogger();
    const harness = commandHarness();
    expect(await runAutoUpdateApplyCommand(hopArgs, harness.deps)).toBe(0);
    expect(harness.calls).toEqual([`start-supervisor ${JSON.stringify(attempt)}`]);
    expect(harness.unrefs()).toBe(1);
  });

  it('as the hop: exits 1 when the supervisor cannot be started', async () => {
    const logs = silenceLogger();
    const harness = commandHarness({ startSupervisor: async () => { throw new Error('could not start bun: spawn ENOENT'); } });
    expect(await runAutoUpdateApplyCommand(hopArgs, harness.deps)).toBe(1);
    expect(logs.error.mock.calls.map((call) => call[1])).toContain('Auto-update hop could not start the supervisor');
  });

  it('exits 1 on arguments it cannot use, before it starts anything', async () => {
    silenceLogger();
    const harness = commandHarness();
    expect(await runAutoUpdateApplyCommand(['--target-version', 'latest'], harness.deps)).toBe(1);
    expect(harness.calls).toEqual([]);
  });

  it('as the supervisor: runs applyAutoUpdate with its effects and flushes telemetry, exiting 1 when the attempt is not its own', async () => {
    silenceLogger();
    const notClaimedDeps = { readState: () => defaultAutoUpdateState() } as unknown as AutoUpdateApplyDeps;
    const harness = commandHarness({ buildApplyDeps: (supervisorAttempt) => { harness.calls.push(`build-apply-deps ${supervisorAttempt.startedAt}`); return notClaimedDeps; } });
    expect(await runAutoUpdateApplyCommand(supervisorArgs, harness.deps)).toBe(1);
    expect(harness.calls).toEqual([`build-apply-deps ${STARTED_AT}`, 'flush-telemetry']);
  });

  it('as the supervisor: exits 1, still flushing telemetry, when the outcome cannot be recorded', async () => {
    silenceLogger();
    const unreadableState = { readState: () => { throw new Error('EACCES'); } } as unknown as AutoUpdateApplyDeps;
    const harness = commandHarness({ buildApplyDeps: () => unreadableState });
    expect(await runAutoUpdateApplyCommand(supervisorArgs, harness.deps)).toBe(1);
    expect(harness.calls).toEqual(['flush-telemetry']);
  });
});

describe('autoUpdateAttemptLogPath', () => {
  it('is one file per attempt in the logs dir', () => {
    expect(autoUpdateAttemptLogPath(STARTED_AT, '/data/logs')).toBe(path.join('/data/logs', `auto-update-${STARTED_AT}.log`));
  });
});

// What the supervisor reads before each proof, to start a worker only when none runs.
describe('readRunningWorker', () => {
  /** Any port number: both readers are injected, so nothing is dialed or bound. */
  const PORT = 37777;
  const pidFileWorker = (pid: number, port?: number) => ({ pid, port, startedAt: '2026-11-08T10:00:00.000Z' }) as PidInfo;

  it('a worker answering on the port runs, with the pid it reports, read with the pid read\'s own budget', async () => {
    const reads: Array<[number, number | undefined]> = [];
    const read = await readRunningWorker(PORT, {
      getCurrentWorkerPid: async (port, timeoutMs) => { reads.push([port, timeoutMs]); return 4100; },
      readOwnedWorker: () => { throw new Error('the PID file is read only when nothing answers'); },
    });
    expect(read).toEqual({ kind: 'answering', pid: 4100 });
    expect(reads).toEqual([[PORT, WORKER_PID_CAPTURE_TIMEOUT_MS]]);
  });

  it('a live claude-mem worker in the PID file runs even when it answers nothing (a migration holds its event loop)', async () => {
    for (const port of [PORT, undefined]) {
      const read = await readRunningWorker(PORT, { getCurrentWorkerPid: async () => null, readOwnedWorker: () => pidFileWorker(4200, port) });
      expect(read).toEqual({ kind: 'alive-not-answering', pid: 4200 });
    }
  });

  it('none runs when nothing answers and the PID file names no live worker, or a worker meant for another port', async () => {
    expect(await readRunningWorker(PORT, { getCurrentWorkerPid: async () => null, readOwnedWorker: () => null })).toEqual({ kind: 'none' });
    expect(await readRunningWorker(PORT, { getCurrentWorkerPid: async () => null, readOwnedWorker: () => pidFileWorker(4300, PORT + 1) })).toEqual({ kind: 'none' });
  });
});

// The supervisor's real proof (productionAutoUpdateApplyDeps.proveWorkerOnVersion)
// against the worker's real GET /api/ready, driven by a real InitPhaseTracker.
// A worker that only answers with its pid and version, as one whose startup
// failed or hangs still does on /api/health, must never count.
describe('autoUpdateWorkerProof (the supervisor\'s proof)', () => {
  /** Several reads of the stream fit in it; the production ceiling is 6 min (auto-update-deadlines.ts). */
  const TEST_CEILING_MS = 1500;
  let servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      // Under Bun, close() after closeAllConnections() can report ERR_SERVER_NOT_RUNNING (tests/server/ready-stream.test.ts).
      await server.close().catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
      });
    }
  });

  async function startWorker(tracker: InitPhaseTracker): Promise<{ port: number; version: string }> {
    const options: ServerOptions = {
      getInitializationComplete: () => tracker.getInitPhase().phase === 'ready',
      initPhaseSource: tracker,
      // The real server pings every 2 s; this keeps a quiet stream alive in a short test.
      readyStreamPingIntervalMs: 40,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
    };
    const server = new Server(options);
    servers.push(server);
    const port = await listenOnEphemeralPort(server);
    const version = (await (await fetch(`http://127.0.0.1:${port}/api/version`)).json() as { version: string }).version;
    return { port, version };
  }

  it('does not prove a worker that reports its pid and version but has not finished starting', async () => {
    silenceLogger();
    const tracker = new InitPhaseTracker();
    tracker.setInitPhase('routes_ready');
    const { port, version } = await startWorker(tracker);
    // /api/health already reports this worker's pid and version.
    expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toMatchObject({ pid: process.pid, version, initialized: false });

    const proof = await autoUpdateWorkerProof(port, 200)(null, version);

    expect(proof).toEqual({ ok: false, startupFailed: false, detail: expect.stringContaining('"phase":"routes_ready"') });
  });

  it('proves it once it reports ready, and stops at once on a failed startup', async () => {
    silenceLogger();
    const startingThenReady = new InitPhaseTracker();
    const ready = await startWorker(startingThenReady);
    setTimeout(() => startingThenReady.setInitPhase('ready'), 200);
    expect(await autoUpdateWorkerProof(ready.port, TEST_CEILING_MS)(null, ready.version)).toEqual({ ok: true, pid: process.pid });

    const startingThenFailed = new InitPhaseTracker();
    const failed = await startWorker(startingThenFailed);
    setTimeout(() => startingThenFailed.setInitPhase('failed', 'SchemaNewerThanBinaryError: SQLite database has schema v75'), 200);
    expect(await autoUpdateWorkerProof(failed.port, 60_000)(null, failed.version)).toEqual({
      ok: false,
      startupFailed: true,
      detail: `pid ${process.pid}: SchemaNewerThanBinaryError: SQLite database has schema v75`,
    });
  });
});
