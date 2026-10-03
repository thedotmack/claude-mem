/**
 * Puts the `claude-mem` hook launcher on PATH (plan-17 #3605, Phase 3).
 *
 * ONE ensure flow — protocol check → compile → place → PATH setup — shared by
 * the npx installer (`install` / `update`) and the plugin's SessionStart
 * self-heal (plugin/scripts/ensure-launcher.cjs). It must bundle into a script
 * that runs under plain `node`, so it imports only node builtins,
 * src/shared/spawn.ts, the dependency-free env sanitizer and the protocol constant.
 *
 * Bin dir: POSIX `~/.local/bin`; Windows `%LOCALAPPDATA%\claude-mem\bin`,
 * appended to the USER Path inside one PowerShell process
 * (WINDOWS_USER_PATH_APPEND_SCRIPT; `setx` truncates at 1024 characters and is
 * never used). No `/opt/homebrew/bin` or
 * `/usr/local/bin` symlink (SPIKE Decision 2).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { posix as posixPath, win32 as windowsPath } from 'path';
import { buildSpawnSyncInvocation } from '../shared/spawn.js';
import { sanitizeEnv } from '../supervisor/env-sanitizer.js';
import { LAUNCHER_PROTOCOL } from './launcher-protocol.js';

const LAUNCHER_VERSION_PROBE_TIMEOUT_MS = 10_000;
const LAUNCHER_COMPILE_TIMEOUT_MS = 120_000;
const POWERSHELL_TIMEOUT_MS = 30_000;
const LAUNCHER_DIRECTORY_ENVIRONMENT_VARIABLE = 'CLAUDE_MEM_LAUNCHER_DIRECTORY';

export interface LauncherHostEnvironment {
  homeDirectory: string;
  platform: NodeJS.Platform;
  /** Mutated in place when PATH setup succeeds, like the original rc appender did. */
  environmentVariables: NodeJS.ProcessEnv;
}

export function currentLauncherHostEnvironment(): LauncherHostEnvironment {
  return { homeDirectory: homedir(), platform: process.platform, environmentVariables: process.env };
}

export interface LauncherInstallLogger {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
}

function pathModuleFor(platform: NodeJS.Platform): typeof posixPath {
  return platform === 'win32' ? windowsPath : posixPath;
}

export function resolveLauncherBinDirectory(host: LauncherHostEnvironment): string {
  const platformPath = pathModuleFor(host.platform);
  if (host.platform === 'win32') {
    const localAppData = host.environmentVariables.LOCALAPPDATA
      || platformPath.join(host.homeDirectory, 'AppData', 'Local');
    return platformPath.join(localAppData, 'claude-mem', 'bin');
  }
  return platformPath.join(host.homeDirectory, '.local', 'bin');
}

export function launcherBinaryFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'claude-mem.exe' : 'claude-mem';
}

export function resolveLauncherBinaryPath(host: LauncherHostEnvironment): string {
  return pathModuleFor(host.platform).join(resolveLauncherBinDirectory(host), launcherBinaryFileName(host.platform));
}

/**
 * Hooks run in the user's project directory, and a compiled Bun binary
 * autoloads `.env` (SPIKE item 6) and `bunfig.toml` from the cwd by default;
 * a project bunfig `preload` would run project code inside the launcher.
 * Both autoloads are turned off.
 */
export function buildLauncherCompileArguments(launcherBundlePath: string, outfilePath: string): string[] {
  return [
    'build',
    '--compile',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    launcherBundlePath,
    '--outfile',
    outfilePath,
  ];
}

/** The protocol a placed launcher prints for `--version`, or null when it is missing or is not our launcher. */
export function readLauncherProtocol(binaryPath: string): number | null {
  if (!existsSync(binaryPath)) return null;
  const versionProbe = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: LAUNCHER_VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (versionProbe.status !== 0 || typeof versionProbe.stdout !== 'string') return null;
  const printedVersion = versionProbe.stdout.trim();
  return /^\d+$/.test(printedVersion) ? Number(printedVersion) : null;
}

/** First `<dir>/<name>` on a PATH value, no spawn (`.exe` appended on Windows). */
export function findExecutableOnPath(
  executableName: string,
  pathValue: string,
  platform: NodeJS.Platform,
): string | null {
  const platformPath = pathModuleFor(platform);
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const fileName = platform === 'win32' ? `${executableName}.exe` : executableName;
  for (const pathEntry of pathValue.split(pathDelimiter)) {
    const directory = pathEntry.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    const candidatePath = platformPath.join(directory, fileName);
    if (existsSync(candidatePath)) return candidatePath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// POSIX: shell rc appender (moved from install.ts applyClaudeCodePathSetupIfNeeded,
// generalized so it runs whenever ~/.local/bin is not on PATH).
// ---------------------------------------------------------------------------

export function detectShellConfigFile(
  homeDirectory: string,
  shellEnvironmentValue: string,
  platform: NodeJS.Platform,
): { path: string; shell: 'zsh' | 'bash' | 'fish' } {
  if (shellEnvironmentValue.includes('fish')) {
    return { path: posixPath.join(homeDirectory, '.config', 'fish', 'config.fish'), shell: 'fish' };
  }
  if (shellEnvironmentValue.includes('zsh')) {
    return { path: posixPath.join(homeDirectory, '.zshrc'), shell: 'zsh' };
  }
  if (platform === 'darwin') {
    const bashProfile = posixPath.join(homeDirectory, '.bash_profile');
    if (existsSync(bashProfile)) return { path: bashProfile, shell: 'bash' };
  }
  return { path: posixPath.join(homeDirectory, '.bashrc'), shell: 'bash' };
}

export function shellPathSetupMarkerComment(purposeLabel: string): string {
  return `# Added by claude-mem installer for ${purposeLabel}`;
}

export type ShellPathSetupOutcome =
  | 'already-on-path'
  | 'rc-file-already-configured'
  | 'rc-file-updated'
  | 'rc-file-update-failed';

/**
 * Appends `export PATH="$HOME/.local/bin:$PATH"` to the user's shell rc when
 * `~/.local/bin` is not on PATH and the rc does not already mention it, then
 * prepends it to this process's PATH. Never rewrites existing rc content.
 */
export function ensureLocalBinOnShellPath(options: {
  purposeLabel: string;
  logger: LauncherInstallLogger;
  host?: LauncherHostEnvironment;
}): ShellPathSetupOutcome {
  const { purposeLabel, logger } = options;
  const host = options.host ?? currentLauncherHostEnvironment();
  const localBinDirectory = posixPath.join(host.homeDirectory, '.local', 'bin');

  const currentPath = host.environmentVariables.PATH ?? '';
  if (currentPath.split(':').includes(localBinDirectory)) return 'already-on-path';

  const { path: configFile, shell } = detectShellConfigFile(
    host.homeDirectory,
    host.environmentVariables.SHELL ?? '',
    host.platform,
  );
  const binPathLiteral = '$HOME/.local/bin';
  const exportLine = shell === 'fish'
    ? `set -gx PATH ${localBinDirectory} $PATH`
    : `export PATH="${binPathLiteral}:$PATH"`;

  let existingContent = '';
  if (existsSync(configFile)) {
    try {
      existingContent = readFileSync(configFile, 'utf-8');
    } catch (error: unknown) {
      // [ANTI-PATTERN IGNORED]: surfaced through the caller's logger; the append below still runs.
      logger.warn(`Could not read ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      mkdirSync(posixPath.dirname(configFile), { recursive: true });
    } catch (error: unknown) {
      // [ANTI-PATTERN IGNORED]: surfaced through the caller's logger; the write below reports the real failure.
      logger.warn(`Could not create ${posixPath.dirname(configFile)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let outcome: ShellPathSetupOutcome;
  if (existingContent.includes(localBinDirectory) || existingContent.includes(binPathLiteral)) {
    logger.info(`${purposeLabel} PATH already configured in ${configFile}`);
    outcome = 'rc-file-already-configured';
  } else {
    try {
      const trailingNewline = existingContent.length === 0 || existingContent.endsWith('\n') ? '' : '\n';
      const appendedBlock = `${trailingNewline}\n${shellPathSetupMarkerComment(purposeLabel)}\n${exportLine}\n`;
      writeFileSync(configFile, existingContent + appendedBlock, 'utf-8');
      logger.success(`Added ${purposeLabel} to PATH in ${configFile}`);
      outcome = 'rc-file-updated';
    } catch (error: unknown) {
      // [ANTI-PATTERN IGNORED]: surfaced through the caller's logger together with the manual remediation command.
      logger.warn(`Could not update ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
      logger.info(`Run manually: echo '${exportLine}' >> ${configFile}`);
      return 'rc-file-update-failed';
    }
  }

  host.environmentVariables.PATH = `${localBinDirectory}:${currentPath}`;
  return outcome;
}

// ---------------------------------------------------------------------------
// Windows: user Path append.
// ---------------------------------------------------------------------------

function normalizeWindowsPathEntry(pathEntry: string): string {
  return pathEntry.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Pure: a PATH value with `directory` appended, unless an entry already names
 * it (case-insensitive, trailing separators and quotes ignored). Used for this
 * process's PATH; the persistent user Path is edited inside PowerShell. The
 * result always starts with the existing value, so it can never truncate.
 */
export function appendDirectoryToWindowsPathValue(
  existingPathValue: string,
  directory: string,
): { alreadyPresent: boolean; updatedPathValue: string } {
  const normalizedDirectory = normalizeWindowsPathEntry(directory);
  const alreadyPresent = existingPathValue
    .split(';')
    .some((pathEntry) => normalizeWindowsPathEntry(pathEntry) === normalizedDirectory);
  if (alreadyPresent) return { alreadyPresent: true, updatedPathValue: existingPathValue };
  if (existingPathValue.trim() === '') return { alreadyPresent: false, updatedPathValue: directory };
  const separator = existingPathValue.endsWith(';') ? '' : ';';
  return { alreadyPresent: false, updatedPathValue: `${existingPathValue}${separator}${directory}` };
}

export interface PowerShellRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure or timeout (spawnSync's `error`), so "exit null" never hides the cause. */
  spawnErrorMessage: string | null;
}

export type PowerShellRunner = (script: string, extraEnvironment: Record<string, string>) => PowerShellRunResult;

/** Full path first: a project directory on PATH could otherwise shadow powershell.exe. */
function resolveWindowsPowerShellExecutablePath(): string {
  const systemRoot = process.env.SystemRoot;
  return systemRoot
    ? windowsPath.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

const runPowerShellHidden: PowerShellRunner = (script, extraEnvironment) => {
  const powerShellResult = spawnSync(
    resolveWindowsPowerShellExecutablePath(),
    // -EncodedCommand (base64 UTF-16LE) sidesteps powershell.exe's own
    // command-line quote parsing for the script's embedded quotes.
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
      env: { ...sanitizeEnv(process.env), ...extraEnvironment },
    },
  );
  return {
    status: powerShellResult.status,
    stdout: powerShellResult.stdout ?? '',
    stderr: powerShellResult.stderr ?? '',
    spawnErrorMessage: powerShellResult.error ? powerShellResult.error.message : null,
  };
};

/**
 * Read-check-append-write of the USER Path in one PowerShell process; the Path
 * value never round-trips through Node. Only the directory goes in (by env
 * var, never interpolated) and only an ASCII status word comes out.
 * - `GetValue(..., 'DoNotExpandEnvironmentNames')` (RegistryValueOptions)
 *   returns the raw value, and `SetValue(..., $kind)` writes back the original
 *   kind (REG_EXPAND_SZ), so `%USERPROFILE%`-style entries survive.
 *   `[Environment]::GetEnvironmentVariable('Path','User')` would expand them
 *   and a write-back would freeze them as REG_SZ literals.
 * - Raw registry writes do not notify Explorer; setting and clearing a dummy
 *   variable through `SetEnvironmentVariable(..., 'User')` broadcasts
 *   WM_SETTINGCHANGE so new terminals pick up the change.
 * - `setx` is never used: it truncates at 1024 characters.
 */
export const WINDOWS_USER_PATH_APPEND_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$existingUserPath = [string]$environmentKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
  "$pathValueKind = if ($environmentKey.GetValueNames() -contains 'Path') { $environmentKey.GetValueKind('Path') } else { 'ExpandString' }",
  `$launcherDirectory = $env:${LAUNCHER_DIRECTORY_ENVIRONMENT_VARIABLE}`,
  "$normalizePathEntry = { param($pathEntry) [Environment]::ExpandEnvironmentVariables($pathEntry).Trim().Trim('\"').TrimEnd('\\') }",
  "if ($existingUserPath -split ';' | Where-Object { $_ -and ((& $normalizePathEntry $_) -ieq (& $normalizePathEntry $launcherDirectory)) }) { 'present'; exit 0 }",
  "$updatedUserPath = if ($existingUserPath -eq '') { $launcherDirectory } elseif ($existingUserPath.EndsWith(';')) { $existingUserPath + $launcherDirectory } else { \"$existingUserPath;$launcherDirectory\" }",
  "$environmentKey.SetValue('Path', $updatedUserPath, $pathValueKind)",
  "[Environment]::SetEnvironmentVariable('CLAUDE_MEM_PATH_BROADCAST', '1', 'User')",
  "[Environment]::SetEnvironmentVariable('CLAUDE_MEM_PATH_BROADCAST', $null, 'User')",
  "'added'",
].join('\n');

export type WindowsPathSetupOutcome = 'already-on-user-path' | 'user-path-updated' | 'user-path-update-failed';

/**
 * Appends `directory` to the persistent USER Path when absent (one hidden
 * PowerShell spawn, WINDOWS_USER_PATH_APPEND_SCRIPT), then to this process's PATH.
 */
export function ensureDirectoryOnWindowsUserPath(options: {
  directory: string;
  logger: LauncherInstallLogger;
  host?: LauncherHostEnvironment;
  runPowerShell?: PowerShellRunner;
}): WindowsPathSetupOutcome {
  const { directory, logger } = options;
  const host = options.host ?? currentLauncherHostEnvironment();
  const runPowerShell = options.runPowerShell ?? runPowerShellHidden;

  const powerShellResult = runPowerShell(WINDOWS_USER_PATH_APPEND_SCRIPT, {
    [LAUNCHER_DIRECTORY_ENVIRONMENT_VARIABLE]: directory,
  });
  const printedStatusWord = powerShellResult.stdout.trim();
  let outcome: WindowsPathSetupOutcome;
  if (powerShellResult.status === 0 && printedStatusWord === 'present') {
    outcome = 'already-on-user-path';
  } else if (powerShellResult.status === 0 && printedStatusWord === 'added') {
    logger.success(`Added ${directory} to your user Path (open a new terminal to pick it up)`);
    outcome = 'user-path-updated';
  } else {
    const failureDetail = powerShellResult.spawnErrorMessage
      ?? (powerShellResult.stderr.trim()
        || `exit ${powerShellResult.status}${printedStatusWord ? `, printed "${printedStatusWord}"` : ''}`);
    logger.warn(`Could not update the user Path: ${failureDetail}`);
    logger.info(`Add ${directory} to your user Path (Settings → System → About → Advanced system settings → Environment Variables).`);
    return 'user-path-update-failed';
  }
  const currentProcessPath = host.environmentVariables.PATH ?? '';
  host.environmentVariables.PATH = appendDirectoryToWindowsPathValue(currentProcessPath, directory).updatedPathValue;
  return outcome;
}

// ---------------------------------------------------------------------------
// The ensure flow.
// ---------------------------------------------------------------------------

export type LauncherCompileRunner = (bunPath: string, compileArguments: string[], workingDirectory: string) => {
  status: number | null;
  stderr: string;
};

const runBunCompile: LauncherCompileRunner = (bunPath, compileArguments, workingDirectory) => {
  const invocation = buildSpawnSyncInvocation(bunPath, compileArguments, {
    encoding: 'utf-8',
    // stdout is piped, never inherited: in a SessionStart hook it would be
    // injected into Claude's context.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: LAUNCHER_COMPILE_TIMEOUT_MS,
    cwd: workingDirectory,
  });
  const compileResult = spawnSync(invocation.command, invocation.args, invocation.options);
  return {
    status: compileResult.status,
    stderr: compileResult.stderr || (compileResult.error ? compileResult.error.message : ''),
  };
};

/**
 * Who runs the ensure flow. The SessionStart self-heal never downgrades (an
 * installed protocol >= ours is current) and skips the Windows registry
 * check (a PowerShell spawn) when nothing was placed, to keep session start
 * cheap. The npx installer wants an exact protocol match, warns on a newer
 * one, and always re-checks the user Path.
 */
export type LauncherEnsureInvocationContext = 'npx-installer' | 'session-start-self-heal';

export type LauncherEnsureStatus =
  | 'already-current'
  | 'newer-protocol-kept'
  | 'installed'
  | 'bun-not-found'
  | 'foreign-binary-kept';

export interface LauncherEnsureResult {
  status: LauncherEnsureStatus;
  binaryPath: string;
  pathSetupOutcome: ShellPathSetupOutcome | WindowsPathSetupOutcome | null;
}

type ExistingLauncherBinary =
  | { kind: 'absent' }
  | { kind: 'dangling-symlink' }
  | { kind: 'foreign' }
  | { kind: 'launcher'; protocol: number };

/**
 * What sits at the launcher path. A symlink, or anything whose `--version` is
 * not a bare integer, is someone else's `claude-mem` (e.g. the npm CLI) and is
 * never overwritten. A dangling symlink (an old plugin-cache link whose target
 * is gone) is dead weight and may be replaced.
 */
function inspectExistingLauncherBinary(binaryPath: string): ExistingLauncherBinary {
  const linkStats = lstatSync(binaryPath, { throwIfNoEntry: false });
  if (!linkStats) return { kind: 'absent' };
  if (linkStats.isSymbolicLink()) {
    return existsSync(binaryPath) ? { kind: 'foreign' } : { kind: 'dangling-symlink' };
  }
  const printedProtocol = readLauncherProtocol(binaryPath);
  return printedProtocol === null ? { kind: 'foreign' } : { kind: 'launcher', protocol: printedProtocol };
}

const TEMPORARY_OUTFILE_PATTERN = /^\.claude-mem-.*\.tmp/;
const RENAMED_ASIDE_WINDOWS_BINARY_PATTERN = /^claude-mem\.old-.*\.exe$/;

/**
 * Best-effort removal of leftovers from earlier placements: Windows binaries
 * renamed aside while a hook was still running them, and temp outfiles from a
 * crashed compile. A temp file younger than the compile timeout may belong to
 * a concurrent session still compiling, so it is left alone.
 */
function removeStalePlacementLeftovers(binDirectory: string, platformPath: typeof posixPath): void {
  const now = Date.now();
  for (const entryName of readdirSync(binDirectory)) {
    const isRenamedAside = RENAMED_ASIDE_WINDOWS_BINARY_PATTERN.test(entryName);
    const isTemporaryOutfile = TEMPORARY_OUTFILE_PATTERN.test(entryName);
    if (!isRenamedAside && !isTemporaryOutfile) continue;
    const entryPath = platformPath.join(binDirectory, entryName);
    try {
      if (isTemporaryOutfile && now - statSync(entryPath).mtimeMs < LAUNCHER_COMPILE_TIMEOUT_MS) continue;
      rmSync(entryPath, { force: true });
    } catch (error: unknown) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      // [ANTI-PATTERN IGNORED]: a renamed-aside claude-mem.old-*.exe that a
      // running hook still holds open cannot be deleted on Windows (EBUSY /
      // EPERM); it is retried on the next placement. Anything else is real.
      if (errorCode === 'EBUSY' || errorCode === 'EPERM' || errorCode === 'ENOENT') continue;
      throw error;
    }
  }
}

/**
 * Moves the compiled temp file onto the launcher path. POSIX rename replaces
 * the target atomically and a hook already running the old binary keeps its
 * inode. Windows cannot replace an .exe that is running, but can rename it,
 * so the old one is moved aside first (and restored if the move-in fails).
 */
function moveCompiledLauncherIntoPlace(
  temporaryOutfilePath: string,
  binaryPath: string,
  binDirectory: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'win32' || !existsSync(binaryPath)) {
    renameSync(temporaryOutfilePath, binaryPath);
    return;
  }
  const renamedAsidePath = windowsPath.join(binDirectory, `claude-mem.old-${process.pid}.exe`);
  renameSync(binaryPath, renamedAsidePath);
  try {
    renameSync(temporaryOutfilePath, binaryPath);
  } catch (moveInError: unknown) {
    renameSync(renamedAsidePath, binaryPath);
    throw moveInError;
  }
}

/**
 * Compiles `<pluginRoot>/scripts/claude-mem-launcher.cjs` into the bin dir and
 * puts that dir on PATH. When the placed binary is already current (see
 * LauncherEnsureInvocationContext) nothing is compiled, but the cheap PATH
 * step still runs. `resolveBunPath` runs only when a compile is needed.
 * A foreign `claude-mem` at the launcher path is never replaced.
 * Throws on a missing bundle, a failed compile or an unusable result.
 */
export function ensureLauncherOnPath(options: {
  pluginRoot: string;
  resolveBunPath: () => string | null;
  logger: LauncherInstallLogger;
  invocationContext: LauncherEnsureInvocationContext;
  host?: LauncherHostEnvironment;
  runCompile?: LauncherCompileRunner;
  runPowerShell?: PowerShellRunner;
}): LauncherEnsureResult {
  const { logger, invocationContext } = options;
  const host = options.host ?? currentLauncherHostEnvironment();
  const platformPath = pathModuleFor(host.platform);
  const binDirectory = resolveLauncherBinDirectory(host);
  const binaryPath = resolveLauncherBinaryPath(host);

  const runPathSetup = (binaryWasJustPlaced: boolean) => {
    if (host.platform !== 'win32') return ensureLocalBinOnShellPath({ purposeLabel: 'claude-mem', logger, host });
    if (!binaryWasJustPlaced && invocationContext === 'session-start-self-heal') return null;
    return ensureDirectoryOnWindowsUserPath({ directory: binDirectory, logger, host, runPowerShell: options.runPowerShell });
  };

  const existingBinary = inspectExistingLauncherBinary(binaryPath);
  if (existingBinary.kind === 'foreign') {
    logger.warn(`${binaryPath} exists and is not the claude-mem hook launcher; not replacing`);
    return { status: 'foreign-binary-kept', binaryPath, pathSetupOutcome: null };
  }
  if (existingBinary.kind === 'launcher') {
    if (existingBinary.protocol === LAUNCHER_PROTOCOL
      || (existingBinary.protocol > LAUNCHER_PROTOCOL && invocationContext === 'session-start-self-heal')) {
      return { status: 'already-current', binaryPath, pathSetupOutcome: runPathSetup(false) };
    }
    if (existingBinary.protocol > LAUNCHER_PROTOCOL) {
      logger.warn(`${binaryPath} speaks launcher protocol ${existingBinary.protocol}, newer than this installer's ${LAUNCHER_PROTOCOL}; leaving it in place`);
      return { status: 'newer-protocol-kept', binaryPath, pathSetupOutcome: runPathSetup(false) };
    }
  }

  const launcherBundlePath = platformPath.join(options.pluginRoot, 'scripts', 'claude-mem-launcher.cjs');
  if (!existsSync(launcherBundlePath)) {
    throw new Error(`launcher bundle missing at ${launcherBundlePath}`);
  }

  const bunPath = options.resolveBunPath();
  if (!bunPath) {
    return { status: 'bun-not-found', binaryPath, pathSetupOutcome: null };
  }

  mkdirSync(binDirectory, { recursive: true });
  removeStalePlacementLeftovers(binDirectory, platformPath);
  // Compile beside the target, then rename over it, so two concurrent
  // sessions each move a complete file into place.
  const executableSuffix = host.platform === 'win32' ? '.exe' : '';
  const temporaryOutfilePath = platformPath.join(binDirectory, `.claude-mem-${process.pid}.tmp${executableSuffix}`);
  const runCompile = options.runCompile ?? runBunCompile;
  try {
    const compileResult = runCompile(
      bunPath,
      buildLauncherCompileArguments(launcherBundlePath, temporaryOutfilePath),
      binDirectory,
    );
    if (compileResult.status !== 0 || !existsSync(temporaryOutfilePath)) {
      throw new Error(`bun build --compile failed (exit ${compileResult.status}): ${compileResult.stderr.trim().split('\n').pop() ?? ''}`);
    }
    if (host.platform !== 'win32') chmodSync(temporaryOutfilePath, 0o755);
    // Verified before the move: after it, a concurrent session may already
    // have renamed its own build over the target.
    const compiledProtocol = readLauncherProtocol(temporaryOutfilePath);
    if (compiledProtocol !== LAUNCHER_PROTOCOL) {
      throw new Error(`compiled launcher printed protocol ${compiledProtocol}, expected ${LAUNCHER_PROTOCOL}`);
    }
    moveCompiledLauncherIntoPlace(temporaryOutfilePath, binaryPath, binDirectory, host.platform);
  } finally {
    rmSync(temporaryOutfilePath, { force: true });
  }
  logger.success(`claude-mem launcher installed at ${binaryPath} (protocol ${LAUNCHER_PROTOCOL})`);

  return { status: 'installed', binaryPath, pathSetupOutcome: runPathSetup(true) };
}

// ---------------------------------------------------------------------------
// Uninstall.
// ---------------------------------------------------------------------------

export interface LauncherRemovalResult {
  removedBinaryPath: string | null;
  /** The PATH line uninstall leaves in place, for the user to remove by hand. */
  pathCleanupHint: string | null;
}

/**
 * Removes the launcher binary this module placed (identified by printing a
 * protocol number; any other `claude-mem` there is left alone). Shell rc
 * files and the Windows user Path are never edited; the hint says what to remove.
 */
export function removeInstalledLauncher(host: LauncherHostEnvironment = currentLauncherHostEnvironment()): LauncherRemovalResult {
  const binaryPath = resolveLauncherBinaryPath(host);
  let removedBinaryPath: string | null = null;
  if (readLauncherProtocol(binaryPath) !== null) {
    rmSync(binaryPath, { force: true });
    removedBinaryPath = binaryPath;
  }

  let pathCleanupHint: string | null = null;
  if (host.platform === 'win32') {
    const binDirectory = resolveLauncherBinDirectory(host);
    if (removedBinaryPath) {
      pathCleanupHint = `${binDirectory} is still on your user Path; remove it in Environment Variables if you no longer need it.`;
    }
  } else {
    const { path: configFile } = detectShellConfigFile(
      host.homeDirectory,
      host.environmentVariables.SHELL ?? '',
      host.platform,
    );
    const markerComment = shellPathSetupMarkerComment('claude-mem');
    if (existsSync(configFile) && readFileSync(configFile, 'utf-8').includes(markerComment)) {
      pathCleanupHint = `${configFile} still has the "${markerComment}" PATH line (export PATH="$HOME/.local/bin:$PATH"); remove it if nothing else in ~/.local/bin needs it.`;
    }
  }
  return { removedBinaryPath, pathCleanupHint };
}
