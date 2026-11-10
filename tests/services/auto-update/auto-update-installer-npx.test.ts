import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import path from 'path';
import {
  autoUpdateInstallerEnv,
  autoUpdateInstallerRunFolderName,
  claudeMemUpdateInvocation,
  makeAutoUpdateInstallerRunFolder,
  type ClaudeMemUpdateInvocation,
} from '../../../src/services/auto-update/auto-update-launch.js';
import { NPM_PUBLIC_REGISTRY_URL } from '../../../src/services/auto-update/auto-update-check.js';
import { resolveWorkerRuntimePath } from '../../../src/services/infrastructure/ProcessManager.js';
import { INSTALL_RUN_BY_AUTO_UPDATE_ENV, withoutNpmSettingsFromAutoUpdateNpxFlags } from '../../../src/shared/auto-update-install-run.js';
import type { CommandInvocation } from '../../../src/shared/spawn.js';

const TARGET = '15.13.0';
const STARTED_AT = Date.UTC(2026, 10, 8, 10, 0, 0);
const RUN_FOLDER_NAME = autoUpdateInstallerRunFolderName(STARTED_AT, TARGET);
const REAL_PROCESS_TEST_TIMEOUT_MS = 30_000;
const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
let runDirectory: string;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  runDirectory = mkdtempSync(path.join(scratchRoot, 'auto-update-npx-'));
});

afterAll(() => {
  rmSync(runDirectory, { recursive: true, force: true });
});

function readyInvocation(result: ClaudeMemUpdateInvocation): CommandInvocation {
  if (result.kind !== 'ready') throw new Error(`expected an invocation, got ${JSON.stringify(result)}`);
  return result.invocation;
}

describe('the installer run folder with real npx (#5500)', () => {
  // npx itself, run from a run folder with the installer's flags, below what a parent folder can hold. Offline, with
  // an empty scratch cache, so the registry is its only way to the version: it reports the request it could not
  // make and downloads nothing. Its logs, cache, global prefix (PREFIX, npm's own default for it) and update check
  // stay out of the real home folder, and its PATH holds only node, npx and the system folders, so nothing installed
  // on this machine (a claude-mem launcher in ~/.local/bin) can answer for the planted copy. npx is a .cmd shim on
  // Windows, which this spawn cannot start.
  const npxOnPath = Bun.which('npx');
  const nodeOnPath = Bun.which('node');
  const npmOnPath = Bun.which('npm');
  const plantedCopyMarker = 'planted-claude-mem-ran';
  /** The flags before #5500, which the supervisor ran from the data dir: npx took the first parent with a package.json or node_modules as its project. */
  const flagsBefore5500 = ['--yes', `claude-mem@${TARGET}`, 'update'];
  const installerFlags = (): string[] => readyInvocation(claudeMemUpdateInvocation(TARGET, process.platform, () => null)).args;
  it.skipIf(process.platform === 'win32' || npxOnPath === null || nodeOnPath === null).each([
    {
      plant: 'node_modules/claude-mem at the promoted version (bin linked)',
      plantInto: (parent: string) => {
        const plantedPackage = path.join(parent, 'node_modules', 'claude-mem');
        mkdirSync(plantedPackage, { recursive: true });
        mkdirSync(path.join(parent, 'node_modules', '.bin'));
        writeFileSync(path.join(plantedPackage, 'package.json'), JSON.stringify({ name: 'claude-mem', version: TARGET, bin: { 'claude-mem': 'cli.sh' } }));
        writeFileSync(path.join(plantedPackage, 'cli.sh'), `#!/bin/sh\necho ${plantedCopyMarker}\n`, { mode: 0o755 });
        symlinkSync(path.join('..', 'claude-mem', 'cli.sh'), path.join(parent, 'node_modules', '.bin', 'claude-mem'));
      },
      // With the flags before #5500 the copy runs, and npx downloads nothing.
      liveFlags: flagsBefore5500,
      liveFromRunFolder: false,
      used: new RegExp(plantedCopyMarker),
      liveExitCode: 0,
      liveAsksTheRegistry: false,
    },
    {
      plant: 'a claude-mem checkout\'s package.json at the promoted version',
      plantInto: (parent: string) => {
        writeFileSync(path.join(parent, 'package.json'), JSON.stringify({ name: 'claude-mem', version: TARGET, bin: { 'claude-mem': './dist/npx-cli/index.js' } }));
      },
      // With the flags before #5500, the sandbox run's exit 127: the checkout links no bin for its own package. The
      // shell's words differ (dash: `claude-mem: not found`, bash: `claude-mem: command not found`); 127 does not.
      liveFlags: flagsBefore5500,
      liveFromRunFolder: false,
      used: /claude-mem: (?:command )?not found/,
      liveExitCode: 127,
      liveAsksTheRegistry: false,
    },
    {
      plant: 'a node_modules/.bin file named claude-mem@<version>',
      plantInto: (parent: string) => {
        mkdirSync(path.join(parent, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(path.join(parent, 'node_modules', '.bin', `claude-mem@${TARGET}`), `#!/bin/sh\necho ${plantedCopyMarker}\n`, { mode: 0o755 });
      },
      // With the package as the command, npx looks for a .bin file named like it in every folder up to the root
      // (libnpmexec localFileExists).
      liveFlags: flagsBefore5500,
      liveFromRunFolder: false,
      used: new RegExp(plantedCopyMarker),
      liveExitCode: 0,
      liveAsksTheRegistry: false,
    },
    {
      plant: 'a workspace root listing the run folder, with an .npmrc',
      plantInto: (parent: string) => {
        writeFileSync(path.join(parent, 'package.json'), JSON.stringify({ name: 'planted-workspace-root', private: true, workspaces: ['claude-mem-data/auto-update-installer/*'] }));
        // A script-shell set here would run the command; offline nothing gets that far, so verbose logging shows the file was read.
        writeFileSync(path.join(parent, '.npmrc'), 'loglevel=verbose\n');
      },
      // Without --no-workspaces npm reads every package.json above the run folder and takes this root as the project
      // (@npmcli/config loadLocalPrefix), its .npmrc included.
      liveFlags: installerFlags().filter((flag) => flag !== '--no-workspaces'),
      liveFromRunFolder: true,
      used: /npm verbose|found workspace root/,
      liveExitCode: undefined,
      liveAsksTheRegistry: true,
    },
  ])('with real npx, nothing in a parent of the run folder is used: $plant there is not, and npx asks the registry', ({ plantInto, liveFlags, liveFromRunFolder, used, liveExitCode, liveAsksTheRegistry }) => {
    const parent = mkdtempSync(path.join(runDirectory, 'planted-parent-'));
    plantInto(parent);
    const dataDir = path.join(parent, 'claude-mem-data');
    const made = makeAutoUpdateInstallerRunFolder(RUN_FOLDER_NAME, dataDir);
    if (made.kind !== 'made') throw new Error(made.message);
    const npmScratch = mkdtempSync(path.join(runDirectory, 'npx-scratch-'));
    const binDirectory = path.join(npmScratch, 'bin');
    mkdirSync(binDirectory);
    symlinkSync(nodeOnPath!, path.join(binDirectory, 'node'));
    symlinkSync(npxOnPath!, path.join(binDirectory, 'npx'));
    const env = autoUpdateInstallerEnv({
      ...process.env,
      PATH: [binDirectory, '/usr/bin', '/bin'].join(path.delimiter),
      HOME: npmScratch,
      PREFIX: path.join(npmScratch, 'global-prefix'),
      npm_config_userconfig: path.join(npmScratch, 'user.npmrc'),
      npm_config_cache: path.join(npmScratch, 'cache'),
      npm_config_offline: 'true',
      npm_config_logs_max: '0',
      npm_config_update_notifier: 'false',
    });
    // spawnSync holds the event loop, so bun's per-test limit cannot stop a hung npx: each run gets that limit itself.
    const runNpx = (args: string[], cwd: string) => {
      const run = spawnSync(path.join(binDirectory, 'npx'), args, { cwd, env, encoding: 'utf-8', timeout: REAL_PROCESS_TEST_TIMEOUT_MS });
      return { status: run.status, output: `${run.stdout}${run.stderr}` };
    };
    const registryRequest = `request to ${NPM_PUBLIC_REGISTRY_URL}claude-mem failed`;

    // The plant is live: with these flags, from the data dir or the run folder, npx uses it.
    const live = runNpx(liveFlags, liveFromRunFolder ? made.path : dataDir);
    expect(live.output).toMatch(used);
    if (liveExitCode !== undefined) expect(live.status).toBe(liveExitCode);
    expect(live.output.includes(registryRequest)).toBe(liveAsksTheRegistry);

    const withTheInstallerFlags = runNpx(installerFlags(), made.path);
    expect(withTheInstallerFlags.output).not.toMatch(used);
    expect(withTheInstallerFlags.output).toContain(registryRequest);
    expect(withTheInstallerFlags.status).not.toBe(0);
    // npx left nothing else in the run folder.
    expect(readdirSync(made.path)).toEqual(['package.json']);
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  // What the installer gets from npx under the installer's flags, the package aside: a local folder stands in for
  // claude-mem@<version>, so nothing is downloaded (offline). The environment holds only what this test sets, so no
  // npm setting of the machine running it counts; its scratch global prefix is npm's own default one (PREFIX), with
  // a global npmrc that sets a proxy and a Bun installed under it the way `npm install -g bun` would.
  it.skipIf(process.platform === 'win32' || npxOnPath === null || nodeOnPath === null || npmOnPath === null)('with real npx, the installer gets the machine\'s own npm prefix and global npmrc, a proxy set there included, and the worker then drops only what the installer\'s flags added', () => {
    const npmScratch = mkdtempSync(path.join(runDirectory, 'npx-passes-on-'));
    const globalPrefix = path.join(npmScratch, 'global-prefix');
    const globalNpmrc = path.join(globalPrefix, 'etc', 'npmrc');
    mkdirSync(path.dirname(globalNpmrc), { recursive: true });
    mkdirSync(path.join(globalPrefix, 'bin'));
    writeFileSync(path.join(globalPrefix, 'bin', 'bun'), '#!/bin/sh\n', { mode: 0o755 });
    const binDirectory = path.join(npmScratch, 'bin');
    mkdirSync(binDirectory);
    for (const [name, target] of [['node', nodeOnPath!], ['npx', npxOnPath!], ['npm', npmOnPath!]] as const) symlinkSync(target, path.join(binDirectory, name));
    // Named and versioned like the release; its one bin prints the npm settings it was started with.
    const standIn = path.join(npmScratch, 'stand-in');
    mkdirSync(standIn);
    writeFileSync(path.join(standIn, 'package.json'), JSON.stringify({ name: 'claude-mem', version: TARGET, bin: { 'claude-mem': 'cli.sh' } }));
    writeFileSync(path.join(standIn, 'cli.sh'), '#!/bin/sh\n/usr/bin/env | /usr/bin/grep -i "^npm_config_"\n', { mode: 0o755 });
    const made = makeAutoUpdateInstallerRunFolder(RUN_FOLDER_NAME, path.join(npmScratch, 'claude-mem-data'));
    if (made.kind !== 'made') throw new Error(made.message);
    const env = autoUpdateInstallerEnv({
      PATH: [binDirectory, '/usr/bin', '/bin'].join(path.delimiter),
      HOME: npmScratch,
      PREFIX: globalPrefix,
      npm_config_cache: path.join(npmScratch, 'cache'),
      npm_config_offline: 'true',
      npm_config_logs_max: '0',
      npm_config_update_notifier: 'false',
    });
    const npm = (args: string[]): string => execFileSync(path.join(binDirectory, 'npm'), args, { cwd: made.path, env, encoding: 'utf-8' }).trim();
    // Written only once npm shows it reads its global npmrc from the scratch prefix.
    expect(npm(['config', 'get', 'globalconfig'])).toBe(globalNpmrc);
    const proxyFromGlobalNpmrc = 'http://proxy.from-global-npmrc.example:3128/';
    writeFileSync(globalNpmrc, `proxy=${proxyFromGlobalNpmrc}\n`);

    const args = installerFlags().map((flag) => (flag === `--package=claude-mem@${TARGET}` ? `--package=${standIn}` : flag));
    const run = spawnSync(path.join(binDirectory, 'npx'), args, { cwd: made.path, env, encoding: 'utf-8', timeout: REAL_PROCESS_TEST_TIMEOUT_MS });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    const installerEnv: NodeJS.ProcessEnv = Object.fromEntries(run.stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

    // The machine's own npm prefix and global npmrc, as npm itself resolves them, never the run folder.
    expect(installerEnv.npm_config_prefix).toBe(npm(['prefix', '-g']));
    expect(installerEnv.npm_config_prefix).toBe(globalPrefix);
    expect(installerEnv.npm_config_global_prefix).toBe(globalPrefix);
    expect(installerEnv.npm_config_globalconfig).toBe(globalNpmrc);
    expect(installerEnv.npm_config_proxy).toBe(proxyFromGlobalNpmrc);
    expect(installerEnv.npm_config_local_prefix).toBe(realpathSync(made.path));
    // What the installer's flags added; --no-workspaces adds nothing.
    expect(installerEnv.npm_config_package).toBe(standIn);
    expect(installerEnv.npm_config_yes).toBe('true');
    expect(Object.keys(installerEnv).filter((name) => /workspaces/i.test(name))).toEqual([]);

    // The worker the installer starts keeps all of it but those two.
    const workerEnv = withoutNpmSettingsFromAutoUpdateNpxFlags({ ...installerEnv, [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: '1' });
    expect(Object.keys(workerEnv).filter((name) => name !== INSTALL_RUN_BY_AUTO_UPDATE_ENV).sort())
      .toEqual(Object.keys(installerEnv).filter((name) => !/^npm_config_(?:package|yes)$/i.test(name)).sort());
    // So a Bun found only under npm's global prefix is found by the installer's Bun lookup and the worker's alike.
    const onlyInThisTest = (candidate: string): boolean => candidate.startsWith(npmScratch) && existsSync(candidate);
    for (const environment of [installerEnv, workerEnv]) {
      expect(resolveWorkerRuntimePath({ platform: process.platform, execPath: nodeOnPath!, env: environment, homeDirectory: npmScratch, pathExists: onlyInThisTest, lookupInPath: () => null }))
        .toBe(path.join(globalPrefix, 'bin', 'bun'));
    }
  }, REAL_PROCESS_TEST_TIMEOUT_MS);
});
