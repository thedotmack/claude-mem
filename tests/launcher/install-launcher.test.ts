import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  appendDirectoryToWindowsPathValue,
  buildLauncherCompileArguments,
  ensureDirectoryOnWindowsUserPath,
  ensureLauncherOnPath,
  ensureLocalBinOnShellPath,
  findExecutableOnPath,
  removeInstalledLauncher,
  resolveLauncherBinaryPath,
  shellPathSetupMarkerComment,
  type LauncherCompileRunner,
  type LauncherHostEnvironment,
  type LauncherInstallLogger,
  type PowerShellRunner,
  WINDOWS_USER_PATH_APPEND_SCRIPT,
} from '../../src/launcher/install-launcher.js';
import { LAUNCHER_PROTOCOL } from '../../src/launcher/launcher-protocol.js';
import { bunCommonPaths } from '../../src/npx-cli/install/tool-path.js';
import { hookLauncherCheck } from '../../src/npx-cli/commands/doctor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const pluginRoot = path.join(projectRoot, 'plugin');
const ensureLauncherScriptPath = path.join(pluginRoot, 'scripts', 'ensure-launcher.cjs');
// Scratch HOMEs live inside the worktree, never the system temp dir or the real HOME.
const scratchParentDirectory = path.join(projectRoot, '.scratch', 'install-launcher-tests');
const isPosixHost = process.platform !== 'win32';

function makeScratchHome(): string {
  return mkdtempSync(path.join(scratchParentDirectory, 'home-'));
}

function posixHost(homeDirectory: string, environmentVariables: NodeJS.ProcessEnv = {}): LauncherHostEnvironment {
  return {
    homeDirectory,
    platform: 'darwin',
    environmentVariables: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ...environmentVariables },
  };
}

function recordingLogger(): LauncherInstallLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (line) => lines.push(`info: ${line}`),
    success: (line) => lines.push(`success: ${line}`),
    warn: (line) => lines.push(`warn: ${line}`),
  };
}

/** A shell script standing in for a compiled launcher: prints `printedVersion` for --version. */
function writeFakeLauncher(binaryPath: string, printedVersion: string): void {
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  writeFileSync(binaryPath, `#!/bin/sh\necho ${printedVersion}\n`);
  chmodSync(binaryPath, 0o755);
}

/** Records the compile invocation and writes a fake launcher at --outfile. */
function fakeCompile(printedVersion = String(LAUNCHER_PROTOCOL)): LauncherCompileRunner & { calls: Array<{ bunPath: string; compileArguments: string[]; workingDirectory: string }> } {
  const calls: Array<{ bunPath: string; compileArguments: string[]; workingDirectory: string }> = [];
  const runner = ((bunPath: string, compileArguments: string[], workingDirectory: string) => {
    calls.push({ bunPath, compileArguments, workingDirectory });
    writeFakeLauncher(compileArguments[compileArguments.indexOf('--outfile') + 1], printedVersion);
    return { status: 0, stderr: '' };
  }) as LauncherCompileRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

const compileMustNotRun: LauncherCompileRunner = () => {
  throw new Error('compile must not run when the launcher is current');
};

beforeAll(() => {
  mkdirSync(scratchParentDirectory, { recursive: true });
});

afterAll(() => {
  rmSync(scratchParentDirectory, { recursive: true, force: true });
});

describe('launcher bin dir and compile arguments per platform', () => {
  it('places claude-mem in ~/.local/bin on POSIX', () => {
    expect(resolveLauncherBinaryPath(posixHost('/home/alex'))).toBe('/home/alex/.local/bin/claude-mem');
  });

  it('places claude-mem.exe in %LOCALAPPDATA%\\claude-mem\\bin on Windows', () => {
    const windowsHost: LauncherHostEnvironment = {
      homeDirectory: 'C:\\Users\\alex',
      platform: 'win32',
      environmentVariables: { LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' },
    };
    expect(resolveLauncherBinaryPath(windowsHost)).toBe('C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin\\claude-mem.exe');
    expect(resolveLauncherBinaryPath({ ...windowsHost, environmentVariables: {} }))
      .toBe('C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin\\claude-mem.exe');
  });

  it('compiles with .env and bunfig autoload disabled', () => {
    expect(buildLauncherCompileArguments('/p/scripts/claude-mem-launcher.cjs', '/h/.local/bin/x')).toEqual([
      'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
      '/p/scripts/claude-mem-launcher.cjs', '--outfile', '/h/.local/bin/x',
    ]);
  });
});

describe.skipIf(!isPosixHost)('ensureLauncherOnPath', () => {
  it('compiles into ~/.local/bin, renames into place and adds ~/.local/bin to the zsh rc', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const compile = fakeCompile();
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compile, invocationContext: 'npx-installer',
    });

    const binDirectory = path.join(scratchHome, '.local', 'bin');
    expect(ensureResult).toEqual({
      status: 'installed',
      binaryPath: path.join(binDirectory, 'claude-mem'),
      pathSetupOutcome: 'rc-file-updated',
    });
    expect(compile.calls).toHaveLength(1);
    const [{ bunPath, compileArguments, workingDirectory }] = compile.calls;
    expect(bunPath).toBe('/fake/bun');
    expect(workingDirectory).toBe(binDirectory);
    expect(compileArguments.slice(0, 4)).toEqual(['build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig']);
    expect(compileArguments[4]).toBe(path.join(pluginRoot, 'scripts', 'claude-mem-launcher.cjs'));
    expect(path.dirname(compileArguments[6])).toBe(binDirectory);
    // The temp outfile was renamed over the target; nothing else is left behind.
    expect(readdirSync(binDirectory)).toEqual(['claude-mem']);

    const zshrc = readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8');
    expect(zshrc).toContain(shellPathSetupMarkerComment('claude-mem'));
    expect(zshrc).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(host.environmentVariables.PATH).toBe(`${binDirectory}:/usr/bin:/bin`);
  });

  it('skips the compile when the placed launcher is current, but still runs the rc check', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    writeFakeLauncher(resolveLauncherBinaryPath(host), String(LAUNCHER_PROTOCOL));
    let bunLookups = 0;

    const ensureResult = ensureLauncherOnPath({
      pluginRoot,
      resolveBunPath: () => { bunLookups++; return '/fake/bun'; },
      logger: recordingLogger(),
      host,
      runCompile: compileMustNotRun,
      invocationContext: 'session-start-self-heal',
    });

    expect(ensureResult).toMatchObject({ status: 'already-current', pathSetupOutcome: 'rc-file-updated' });
    expect(bunLookups).toBe(0);
    expect(readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8')).toContain(shellPathSetupMarkerComment('claude-mem'));
  });

  it('self-heal treats a newer installed protocol as current (never downgrades)', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, String(LAUNCHER_PROTOCOL + 1));
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compileMustNotRun, invocationContext: 'session-start-self-heal',
    });

    expect(ensureResult.status).toBe('already-current');
    expect(readFileSync(binaryPath, 'utf-8')).toContain(String(LAUNCHER_PROTOCOL + 1));
    expect(logger.lines.filter((line) => line.startsWith('warn:'))).toEqual([]);
  });

  it('the installer keeps a newer installed protocol and warns', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    writeFakeLauncher(resolveLauncherBinaryPath(host), String(LAUNCHER_PROTOCOL + 1));
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });

    expect(ensureResult).toMatchObject({ status: 'newer-protocol-kept', pathSetupOutcome: 'rc-file-updated' });
    expect(logger.lines.some((line) => line.startsWith('warn:') && line.includes('newer than this installer'))).toBe(true);
  });

  it('never replaces a claude-mem whose --version is not a bare integer', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, '13.28.0');
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });

    expect(ensureResult).toEqual({ status: 'foreign-binary-kept', binaryPath, pathSetupOutcome: null });
    expect(logger.lines).toEqual([`warn: ${binaryPath} exists and is not the claude-mem hook launcher; not replacing`]);
    expect(readFileSync(binaryPath, 'utf-8')).toContain('13.28.0');
  });

  it('never replaces a symlink, even one pointing at a launcher', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    const linkTargetPath = path.join(scratchHome, 'elsewhere', 'claude-mem');
    writeFakeLauncher(linkTargetPath, String(LAUNCHER_PROTOCOL - 1));
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    symlinkSync(linkTargetPath, binaryPath);

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('foreign-binary-kept');
    expect(lstatSync(binaryPath).isSymbolicLink()).toBe(true);
  });

  it('replaces a dangling symlink (e.g. into a deleted plugin cache)', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    symlinkSync(path.join(scratchHome, 'plugins', 'cache', '12.0.0', 'bin', 'claude-mem'), binaryPath);

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: fakeCompile(), invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('installed');
    expect(lstatSync(binaryPath).isSymbolicLink()).toBe(false);
    expect(spawnSync(binaryPath, ['--version'], { encoding: 'utf-8' }).stdout.trim()).toBe(String(LAUNCHER_PROTOCOL));
  });

  it('recompiles a launcher that prints an older protocol', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome, { PATH: `${path.join(scratchHome, '.local', 'bin')}:/usr/bin` });
    writeFakeLauncher(resolveLauncherBinaryPath(host), String(LAUNCHER_PROTOCOL - 1));
    const compile = fakeCompile();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: compile, invocationContext: 'npx-installer',
    });

    expect(compile.calls).toHaveLength(1);
    expect(ensureResult).toMatchObject({ status: 'installed', pathSetupOutcome: 'already-on-path' });
  });

  it('reports bun-not-found without compiling', () => {
    const host = posixHost(makeScratchHome());
    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => null, logger: recordingLogger(), host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });
    expect(ensureResult.status).toBe('bun-not-found');
  });

  it('throws on a failed compile and leaves no temp file', () => {
    const scratchHome = makeScratchHome();
    const failingCompile: LauncherCompileRunner = () => ({ status: 1, stderr: 'error: boom\n' });
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host: posixHost(scratchHome), runCompile: failingCompile, invocationContext: 'npx-installer',
    })).toThrow('bun build --compile failed (exit 1): error: boom');
    expect(readdirSync(path.join(scratchHome, '.local', 'bin'))).toEqual([]);
  });

  it('leaves no temp file when the compile succeeds but the rename fails', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    const compileThenBlockTarget: LauncherCompileRunner = (_bunPath, compileArguments) => {
      writeFakeLauncher(compileArguments[compileArguments.indexOf('--outfile') + 1], String(LAUNCHER_PROTOCOL));
      // A non-empty directory at the target makes rename(2) fail.
      mkdirSync(path.join(binaryPath, 'occupied'), { recursive: true });
      return { status: 0, stderr: '' };
    };
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: compileThenBlockTarget, invocationContext: 'npx-installer',
    })).toThrow();
    expect(readdirSync(path.join(scratchHome, '.local', 'bin'))).toEqual(['claude-mem']);
  });

  it('throws before placing when the compiled binary prints the wrong protocol, leaving no temp file', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: fakeCompile('garbage'), invocationContext: 'npx-installer',
    })).toThrow(`compiled launcher printed protocol null, expected ${LAUNCHER_PROTOCOL}`);
    expect(readdirSync(path.join(scratchHome, '.local', 'bin'))).toEqual([]);
  });

  it('cleans stale placement leftovers but keeps a temp file a concurrent compile may own', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    mkdirSync(binDirectory, { recursive: true });
    const staleTemporaryPath = path.join(binDirectory, '.claude-mem-111.tmp');
    const freshTemporaryPath = path.join(binDirectory, '.claude-mem-222.tmp');
    const renamedAsidePath = path.join(binDirectory, 'claude-mem.old-333.exe');
    for (const leftoverPath of [staleTemporaryPath, freshTemporaryPath, renamedAsidePath]) writeFileSync(leftoverPath, '');
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staleTemporaryPath, anHourAgo, anHourAgo);

    ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: fakeCompile(), invocationContext: 'npx-installer',
    });

    expect(readdirSync(binDirectory).sort()).toEqual(['.claude-mem-222.tmp', 'claude-mem']);
  });

  it('throws when the plugin root has no launcher bundle', () => {
    expect(() => ensureLauncherOnPath({
      pluginRoot: path.join(scratchParentDirectory, 'no-such-plugin'),
      resolveBunPath: () => '/fake/bun',
      logger: recordingLogger(),
      host: posixHost(makeScratchHome()),
      runCompile: compileMustNotRun,
      invocationContext: 'npx-installer',
    })).toThrow('launcher bundle missing');
  });
});

describe.skipIf(!isPosixHost)('ensureLocalBinOnShellPath keeps the Claude Code appender behavior', () => {
  it('is a no-op when ~/.local/bin is already on PATH', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome, { PATH: `/usr/bin:${path.join(scratchHome, '.local', 'bin')}` });
    expect(ensureLocalBinOnShellPath({ purposeLabel: 'Claude Code', logger: recordingLogger(), host })).toBe('already-on-path');
    expect(existsSync(path.join(scratchHome, '.zshrc'))).toBe(false);
  });

  it('leaves an rc that already exports ~/.local/bin untouched', () => {
    const scratchHome = makeScratchHome();
    const zshrcPath = path.join(scratchHome, '.zshrc');
    writeFileSync(zshrcPath, 'export PATH="$HOME/.local/bin:$PATH"\n');
    const logger = recordingLogger();
    expect(ensureLocalBinOnShellPath({ purposeLabel: 'Claude Code', logger, host: posixHost(scratchHome) })).toBe('rc-file-already-configured');
    expect(readFileSync(zshrcPath, 'utf-8')).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
    expect(logger.lines).toEqual([`info: Claude Code PATH already configured in ${zshrcPath}`]);
  });

  it('appends the Claude Code block after existing content, keeping it intact', () => {
    const scratchHome = makeScratchHome();
    const zshrcPath = path.join(scratchHome, '.zshrc');
    writeFileSync(zshrcPath, 'alias ll="ls -l"');
    ensureLocalBinOnShellPath({ purposeLabel: 'Claude Code', logger: recordingLogger(), host: posixHost(scratchHome) });
    expect(readFileSync(zshrcPath, 'utf-8')).toBe(
      'alias ll="ls -l"\n\n# Added by claude-mem installer for Claude Code\nexport PATH="$HOME/.local/bin:$PATH"\n',
    );
  });

  it('writes fish syntax to config.fish', () => {
    const scratchHome = makeScratchHome();
    ensureLocalBinOnShellPath({
      purposeLabel: 'claude-mem', logger: recordingLogger(), host: posixHost(scratchHome, { SHELL: '/usr/bin/fish' }),
    });
    expect(readFileSync(path.join(scratchHome, '.config', 'fish', 'config.fish'), 'utf-8'))
      .toContain(`set -gx PATH ${path.join(scratchHome, '.local', 'bin')} $PATH`);
  });
});

describe('Windows user Path append (pure)', () => {
  const launcherDirectory = 'C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin';

  it('appends when absent', () => {
    expect(appendDirectoryToWindowsPathValue('C:\\a;C:\\b', launcherDirectory))
      .toEqual({ alreadyPresent: false, updatedPathValue: `C:\\a;C:\\b;${launcherDirectory}` });
  });

  it('does not double a trailing semicolon and handles an empty Path', () => {
    expect(appendDirectoryToWindowsPathValue('C:\\a;', launcherDirectory).updatedPathValue).toBe(`C:\\a;${launcherDirectory}`);
    expect(appendDirectoryToWindowsPathValue('', launcherDirectory).updatedPathValue).toBe(launcherDirectory);
  });

  it('is idempotent, ignoring case, quotes and trailing separators', () => {
    const once = appendDirectoryToWindowsPathValue('C:\\a', launcherDirectory).updatedPathValue;
    expect(appendDirectoryToWindowsPathValue(once, launcherDirectory)).toEqual({ alreadyPresent: true, updatedPathValue: once });
    for (const existingSpelling of [launcherDirectory.toUpperCase(), `${launcherDirectory}\\`, `"${launcherDirectory}"`]) {
      expect(appendDirectoryToWindowsPathValue(`C:\\a;${existingSpelling}`, launcherDirectory).alreadyPresent).toBe(true);
    }
  });

  it('never truncates, even far past setx\'s 1024-character limit', () => {
    const longPath = Array.from({ length: 120 }, (_, index) => `C:\\tools\\very-long-directory-name-${index}`).join(';');
    expect(longPath.length).toBeGreaterThan(4000);
    const { updatedPathValue } = appendDirectoryToWindowsPathValue(longPath, launcherDirectory);
    expect(updatedPathValue.startsWith(longPath)).toBe(true);
    expect(updatedPathValue.length).toBe(longPath.length + 1 + launcherDirectory.length);
  });
});

describe('ensureDirectoryOnWindowsUserPath', () => {
  const launcherDirectory = 'C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin';
  const windowsHost = (): LauncherHostEnvironment => ({
    homeDirectory: 'C:\\Users\\alex', platform: 'win32', environmentVariables: { PATH: 'C:\\Windows' },
  });

  function fakePowerShell(result: Partial<{ status: number | null; stdout: string; stderr: string; spawnErrorMessage: string | null }>): PowerShellRunner & { calls: Array<{ script: string; extraEnvironment: Record<string, string> }> } {
    const calls: Array<{ script: string; extraEnvironment: Record<string, string> }> = [];
    const runner = ((script: string, extraEnvironment: Record<string, string>) => {
      calls.push({ script, extraEnvironment });
      return { status: 0, stdout: '', stderr: '', spawnErrorMessage: null, ...result };
    }) as PowerShellRunner & { calls: typeof calls };
    runner.calls = calls;
    return runner;
  }

  it('reads, checks and writes the raw registry value in ONE PowerShell call, passing only the directory', () => {
    const runPowerShell = fakePowerShell({ stdout: 'added\r\n' });
    const host = windowsHost();
    expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger: recordingLogger(), host, runPowerShell })).toBe('user-path-updated');
    expect(runPowerShell.calls).toHaveLength(1);
    const [{ script, extraEnvironment }] = runPowerShell.calls;
    expect(script).toBe(WINDOWS_USER_PATH_APPEND_SCRIPT);
    expect(script).toContain("GetValue('Path', '', 'DoNotExpandEnvironmentNames')");
    expect(script).toContain("SetValue('Path', $updatedUserPath, $pathValueKind)");
    expect(script).toContain("SetEnvironmentVariable('CLAUDE_MEM_PATH_BROADCAST', $null, 'User')");
    expect(script).not.toContain(launcherDirectory);
    expect(script).not.toContain('setx');
    expect(extraEnvironment).toEqual({ CLAUDE_MEM_LAUNCHER_DIRECTORY: launcherDirectory });
    expect(host.environmentVariables.PATH).toBe(`C:\\Windows;${launcherDirectory}`);
  });

  it('reports already-on-user-path when PowerShell prints present', () => {
    const runPowerShell = fakePowerShell({ stdout: 'present\r\n' });
    expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger: recordingLogger(), host: windowsHost(), runPowerShell })).toBe('already-on-user-path');
    expect(runPowerShell.calls).toHaveLength(1);
  });

  it('includes the spawn error (timeout, ENOENT) instead of "exit null"', () => {
    const logger = recordingLogger();
    const runPowerShell = fakePowerShell({ status: null, spawnErrorMessage: 'spawnSync powershell.exe ETIMEDOUT' });
    expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger, host: windowsHost(), runPowerShell })).toBe('user-path-update-failed');
    expect(logger.lines[0]).toBe('warn: Could not update the user Path: spawnSync powershell.exe ETIMEDOUT');
  });

  it('fails on a non-zero exit or an unexpected status word, leaving the process PATH alone', () => {
    for (const result of [{ status: 1, stderr: 'Access denied' }, { stdout: 'something else' }]) {
      const host = windowsHost();
      const logger = recordingLogger();
      expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger, host, runPowerShell: fakePowerShell(result) })).toBe('user-path-update-failed');
      expect(logger.lines[0]).toStartWith('warn: Could not update the user Path: ');
      expect(host.environmentVariables.PATH).toBe('C:\\Windows');
    }
  });
});

describe.skipIf(!isPosixHost)('removeInstalledLauncher (uninstall)', () => {
  it('removes the placed launcher and names the rc line to remove, leaving the rc untouched', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, String(LAUNCHER_PROTOCOL));
    ensureLocalBinOnShellPath({ purposeLabel: 'claude-mem', logger: recordingLogger(), host: posixHost(scratchHome) });
    const zshrcBefore = readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8');

    const removal = removeInstalledLauncher(host);

    expect(removal.removedBinaryPath).toBe(binaryPath);
    expect(existsSync(binaryPath)).toBe(false);
    expect(removal.pathCleanupHint).toContain(path.join(scratchHome, '.zshrc'));
    expect(removal.pathCleanupHint).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8')).toBe(zshrcBefore);
  });

  it('leaves a claude-mem that is not our launcher in place', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, '13.28.0');
    expect(removeInstalledLauncher(host)).toEqual({ removedBinaryPath: null, pathCleanupHint: null });
    expect(existsSync(binaryPath)).toBe(true);
  });
});

describe.skipIf(!isPosixHost)('doctor hook launcher row', () => {
  it('warns with the hook error string and the install fix when claude-mem is not on PATH', () => {
    const row = hookLauncherCheck(posixHost(makeScratchHome()));
    expect(row).toMatchObject({ name: 'Hook launcher', status: 'warn', required: false });
    expect(row.detail).toContain('Executable not found in $PATH: "claude-mem"');
    expect(row.detail).toContain('npx claude-mem install');
  });

  it('reports where, the protocol and the --version round trip when current', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    writeFakeLauncher(path.join(binDirectory, 'claude-mem'), String(LAUNCHER_PROTOCOL));
    const row = hookLauncherCheck(posixHost(scratchHome, { PATH: `${binDirectory}:/usr/bin` }));
    expect(row.status).toBe('ok');
    expect(row.detail).toMatch(new RegExp(`^${path.join(binDirectory, 'claude-mem')} \\(protocol ${LAUNCHER_PROTOCOL}, --version \\d+ ms\\)$`));
  });

  it('flags a claude-mem on PATH that is not the launcher (e.g. the npm CLI)', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, 'npm-global', 'bin');
    writeFakeLauncher(path.join(binDirectory, 'claude-mem'), '13.28.0');
    const row = hookLauncherCheck(posixHost(scratchHome, { PATH: binDirectory }));
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('is not the claude-mem hook launcher');
  });

  it('finds the first PATH hit without spawning', () => {
    const scratchHome = makeScratchHome();
    const firstDirectory = path.join(scratchHome, 'first');
    const secondDirectory = path.join(scratchHome, 'second');
    writeFakeLauncher(path.join(secondDirectory, 'claude-mem'), '1');
    writeFakeLauncher(path.join(firstDirectory, 'claude-mem'), '1');
    expect(findExecutableOnPath('claude-mem', `/nope:${firstDirectory}:${secondDirectory}`, 'darwin')).toBe(path.join(firstDirectory, 'claude-mem'));
    expect(findExecutableOnPath('claude-mem', '/nope', 'darwin')).toBeNull();
  });
});

describe.skipIf(!isPosixHost)('plugin/scripts/ensure-launcher.cjs under plain node', () => {
  const nodeExecutablePath = Bun.which('node');
  const bunExecutablePath = Bun.which('bun');
  // Bun's well-known system locations are searched regardless of PATH, so the
  // missing-Bun case only holds on a machine without one of those.
  const systemBunPresent = bunCommonPaths({}).some((candidate) => !candidate.startsWith(process.env.HOME ?? '\0') && existsSync(candidate));

  function runEnsureLauncherScript(scratchHome: string, extraEnvironment: Record<string, string>) {
    return spawnSync(nodeExecutablePath!, [ensureLauncherScriptPath], {
      encoding: 'utf-8',
      cwd: scratchHome,
      timeout: 60_000,
      // Built from scratch: nothing from the real HOME or this session leaks in.
      env: { HOME: scratchHome, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ...extraEnvironment },
    });
  }

  it('is built', () => {
    expect(nodeExecutablePath).toBeTruthy();
    expect(existsSync(ensureLauncherScriptPath)).toBe(true);
  });

  it('exits 0 with empty stdout when CLAUDE_PLUGIN_ROOT is missing', () => {
    const scriptRun = runEnsureLauncherScript(makeScratchHome(), {});
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    expect(scriptRun.stderr).toBe('claude-mem ensure-launcher: CLAUDE_PLUGIN_ROOT is not set, skipping\n');
  });

  it('exits 0 with empty stdout when the plugin root has no launcher bundle', () => {
    const scriptRun = runEnsureLauncherScript(makeScratchHome(), { CLAUDE_PLUGIN_ROOT: path.join(scratchParentDirectory, 'no-such-plugin') });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    expect(scriptRun.stderr).toContain('launcher bundle missing');
    expect(scriptRun.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('exits 0 silently when the launcher is current', () => {
    const scratchHome = makeScratchHome();
    writeFakeLauncher(path.join(scratchHome, '.local', 'bin', 'claude-mem'), String(LAUNCHER_PROTOCOL));
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: `${path.join(scratchHome, '.local', 'bin')}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    expect(scriptRun.stderr).toBe('');
  });

  it.skipIf(systemBunPresent)('exits 0 with one stderr line when Bun is missing', () => {
    const scratchHome = makeScratchHome();
    const scriptRun = runEnsureLauncherScript(scratchHome, { CLAUDE_PLUGIN_ROOT: pluginRoot });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    expect(scriptRun.stderr).toBe('claude-mem ensure-launcher: Bun not found, cannot compile the claude-mem launcher; run `npx claude-mem install`\n');
    expect(existsSync(path.join(scratchHome, '.local', 'bin', 'claude-mem'))).toBe(false);
  });

  it.skipIf(!bunExecutablePath)('compiles a real launcher that prints the protocol, with empty stdout', () => {
    const scratchHome = makeScratchHome();
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: `${path.dirname(bunExecutablePath!)}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    const placedBinaryPath = path.join(scratchHome, '.local', 'bin', 'claude-mem');
    expect(scriptRun.stderr).toContain(`claude-mem launcher installed at ${placedBinaryPath}`);
    expect(spawnSync(placedBinaryPath, ['--version'], { encoding: 'utf-8' }).stdout.trim()).toBe(String(LAUNCHER_PROTOCOL));
    expect(readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8')).toContain(shellPathSetupMarkerComment('claude-mem'));
  });
});
