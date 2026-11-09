/**
 * `npx claude-mem doctor` — a minimal diagnostic that probes every layer an
 * operator would otherwise check by hand (#2548). Read-only: it never mutates
 * state. Exits 0 when all REQUIRED checks pass, 1 otherwise, so it is CI/script
 * friendly.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, posix as posixPath, win32 as windowsPath } from 'path';
import { styleText } from 'node:util';
import { IS_WINDOWS, installedPluginsPath, marketplaceDirectory, readPluginVersion } from '../utils/paths.js';
import { getWorkerBaseUrl, resolvePluginRoot, type PluginRootResolution } from '../../shared/worker-utils.js';
import {
  AUTO_UPDATE_OFF_DECISIONS,
  AutoUpdateCheckError,
  claudeCodeBackgroundUpdateSetting,
  describeAutoUpdateDecision,
  readAutoUpdateSwitches,
  type AutoUpdateSwitchesRead,
  type ClaudeCodePluginState,
  type ClaudeCodeSettingsEnvRead,
} from '../../services/auto-update/auto-update-check.js';
import { readClaudeMemInstallShape, type ClaudeMemInstallShape } from '../../services/auto-update/auto-update-install-shape.js';
import {
  autoUpdateBrokenInstall,
  autoUpdateFixInstruction,
  autoUpdateStatePath,
  describeAutoUpdateBrokenInstall,
  describeAutoUpdateStateFileProblem,
  readAutoUpdateStateFile,
  readInFlightAttempt,
  targetVersionOf,
  type AutoUpdateAttemptOutcome,
  type AutoUpdateInFlightAttempt,
  type AutoUpdateState,
  type AutoUpdateStateFileRead,
} from '../../services/auto-update/auto-update-state.js';
import { productionAutoUpdateSwitchReaders } from '../../services/auto-update/auto-update-switch-readers.js';
import { InvalidWorkerUrlError } from '../../shared/worker-url.js';
import { getBunVersion, getUvVersion, isInstallCurrent } from '../install/setup-runtime.js';
import { findCodexExecutablePath, isCodexOnPath } from '../install/tool-path.js';
import { getCredential } from '../../shared/EnvManager.js';
import { buildKeyPool } from '../../shared/api-key-pool.js';
import { resolveOpenAICompatPreset } from '../../shared/openai-compat-presets.js';
import { treeSitterCliBinaryPath } from '../../services/smart-file-read/tree-sitter-cli-provision.js';
import { checkTreeSitterCliLoadable, resolveTreeSitterBinPathFor, TREE_SITTER_CLI_PATH_WORKAROUND } from '../../services/smart-file-read/tree-sitter-bin-path.js';
import { resolveDataDir } from '../../shared/paths.js';
import { paths } from '../../shared/paths.js';
import { findOrphanedChromaRoots, readProcessTablePosix } from '../../supervisor/orphan-chroma-sweep.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { SNAPSHOT_FILE_PATTERN } from '../../services/backup/snapshot-files.js';
import { checkWindowsGitBash } from '../utils/windows-git-bash-preflight.js';
import {
  claudeCodeVersionTooOldWarning,
  detectClaudeCodeVersion,
  MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS,
} from '../install/claude-code-version.js';
import {
  currentLauncherHostEnvironment,
  findExecutableOnPath,
  probeLauncherVersion,
  resolveLauncherBinaryPath,
  type LauncherHostEnvironment,
} from '../../launcher/install-launcher.js';
import { LAUNCHER_PROTOCOL } from '../../launcher/launcher-protocol.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

/**
 * Row names are padded to this width, the one doctor has always used, so the
 * details start in one column; only a longer name ("Observer data directory")
 * pushes its own detail right. Continuation lines indent to the same column.
 */
const CHECK_NAME_COLUMN_WIDTH = 22;

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** When false, a 'fail' does not affect the overall exit code. */
  required: boolean;
}

/** The worker's `health.chroma` block from /api/admin/doctor. */
interface ChromaCrashState {
  count: number;
  lastExit: {
    timestamp: string;
    code: number | null;
    signal: string | null;
  } | null;
  chromaMcpVersion: string;
  dependencyOverrides: string[];
  /** uvx prewarm circuit breaker (#4108); absent from older workers. */
  prewarm?: {
    consecutiveFailures: number;
    state: 'ok' | 'paused' | 'stopped';
  };
  /** A collection dropped as corrupt and rebuilt from SQLite (#3202); absent from older workers. */
  collectionDrop?: {
    collection: string;
    droppedAt: string;
    documentCount: number | null;
    error: string;
  } | null;
}

function probeVersion(bin: 'bun' | 'uv'): string | null {
  try {
    return bin === 'bun' ? getBunVersion() : getUvVersion();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn(`[doctor] Failed to probe \`${bin} --version\`:`, err);
    return null;
  }
}

async function probeWorkerHealth(workerUrl: string): Promise<{
  status: CheckStatus;
  detail: string;
  workerUrl: string;
}> {
  const res = await fetch(`${workerUrl}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) {
    return { status: 'ok', detail: `healthy at ${workerUrl}`, workerUrl };
  }
  return { status: 'warn', detail: `reachable but unhealthy (HTTP ${res.status}) at ${workerUrl}`, workerUrl };
}

function isChromaCrashState(value: unknown): value is ChromaCrashState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<ChromaCrashState>;
  return typeof state.count === 'number' && Number.isInteger(state.count) && state.count >= 0 && Array.isArray(state.dependencyOverrides)
    && typeof state.chromaMcpVersion === 'string'
    && (state.lastExit === null || (typeof state.lastExit === 'object' && state.lastExit !== null
      && typeof state.lastExit.timestamp === 'string'
      && (typeof state.lastExit.code === 'number' || state.lastExit.code === null)
      && (typeof state.lastExit.signal === 'string' || state.lastExit.signal === null)))
    && (state.prewarm === undefined || (typeof state.prewarm === 'object' && state.prewarm !== null
      && typeof state.prewarm.consecutiveFailures === 'number'
      && ['ok', 'paused', 'stopped'].includes(state.prewarm.state)))
    && (state.collectionDrop === undefined || state.collectionDrop === null
      || (typeof state.collectionDrop === 'object'
        && typeof state.collectionDrop.collection === 'string'
        && typeof state.collectionDrop.droppedAt === 'string'
        && (typeof state.collectionDrop.documentCount === 'number' || state.collectionDrop.documentCount === null)));
}

/**
 * The direct child is uvx, not python, so a crash in chroma-mcp (e.g. a
 * SIGSEGV in the engine) usually reaches the worker as uvx's exit code; a
 * signal only shows when uvx itself was killed.
 */
function describeChromaExit(lastExit: NonNullable<ChromaCrashState['lastExit']>): string {
  return lastExit.signal ? `signal ${lastExit.signal}` : `exit code ${lastExit.code ?? 'unknown'}`;
}

/**
 * Warn rows from the worker's /api/admin/doctor `health.chroma` block. These
 * are optional: any failure yields no rows and never changes the worker's
 * own status.
 */
export async function probeChromaDiagnostics(workerUrl: string): Promise<CheckResult[]> {
  try {
    const response = await fetch(`${workerUrl}/api/admin/doctor`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return [];
    }
    const diagnostics = await response.json() as { health?: { chroma?: unknown } };
    const chroma = diagnostics?.health?.chroma;
    return isChromaCrashState(chroma) ? chromaDiagnosticChecks(chroma) : [];
  } catch {
    // Diagnostics are optional and must not change worker health status.
    return [];
  }
}

/** Warn rows for the worker's Chroma child exits and prewarm breaker, if any. */
function chromaDiagnosticChecks(chroma: ChromaCrashState): CheckResult[] {
  const checks: CheckResult[] = [];
  if (chroma.count > 0 && chroma.lastExit) {
    checks.push({
      name: 'Chroma child exits',
      status: 'warn',
      detail: `${chroma.count} unexpected exit(s) since the worker started, last by ${describeChromaExit(chroma.lastExit)} at ${chroma.lastExit.timestamp}; chroma-mcp ${chroma.chromaMcpVersion}; overrides: ${chroma.dependencyOverrides.join(', ')}`,
      required: false,
    });
  }
  if (chroma.prewarm && chroma.prewarm.state !== 'ok') {
    checks.push({
      name: 'Chroma prewarm',
      status: 'warn',
      detail: chroma.prewarm.state === 'stopped'
        ? `stopped after ${chroma.prewarm.consecutiveFailures} consecutive uvx failures — fix uv or free disk space, then run \`npx claude-mem restart\``
        : `paused after ${chroma.prewarm.consecutiveFailures} consecutive uvx failures; retrying with a growing cooldown`,
      required: false,
    });
  }
  if (chroma.collectionDrop) {
    const drop = chroma.collectionDrop;
    checks.push({
      name: 'Chroma collection',
      status: 'warn',
      detail: `${drop.collection} had a corrupt HNSW segment and was dropped at ${drop.droppedAt} (${drop.documentCount ?? 'unknown'} documents); it is being rebuilt from SQLite, so semantic search results are incomplete until that finishes`,
      required: false,
    });
  }
  return checks;
}

export interface WorkerDependencyStatusPayload {
  dependency: string;
  kind: string;
  message: string;
  remediation?: string;
  recordedAtMs?: number;
}

export interface WorkerDependencyHealthPayload {
  degraded?: boolean;
  statuses?: WorkerDependencyStatusPayload[];
}

/**
 * Warn rows from the worker's /api/admin/doctor `health.dependencies` block (#5359).
 * Reports degraded observation generator dependencies (such as missing Claude CLI
 * when CLAUDE_MEM_PROVIDER is claude, or missing Codex CLI) and offers installed
 * alternatives.
 */
export async function probeWorkerDependencies(
  workerUrl: string,
  codexDetected: boolean = false,
  codexOnPath: boolean = false,
  codexPath?: string | null,
): Promise<CheckResult[]> {
  try {
    const response = await fetch(`${workerUrl}/api/admin/doctor`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return [];
    }
    const diagnostics = await response.json() as {
      health?: { dependencies?: WorkerDependencyHealthPayload };
    };
    const deps = diagnostics?.health?.dependencies;
    if (!deps?.degraded || !Array.isArray(deps.statuses)) {
      return [];
    }

    return workerDependencyChecks(deps.statuses, codexDetected, codexOnPath, codexPath);
  } catch {
    return [];
  }
}

export function workerDependencyChecks(
  statuses: WorkerDependencyStatusPayload[],
  codexDetected: boolean = false,
  codexOnPath: boolean = false,
  codexPath?: string | null,
): CheckResult[] {
  const checks: CheckResult[] = [];
  for (const status of statuses) {
    if (status.dependency === 'claude_cli' && status.kind === 'setup_required') {
      let codexHint = '';
      if (codexDetected) {
        codexHint = codexOnPath || !codexPath
          ? ' (Codex CLI is installed; you can switch by setting CLAUDE_MEM_PROVIDER to codex in ~/.claude-mem/settings.json)'
          : ` (Codex CLI is installed at ${codexPath}; you can switch by setting CLAUDE_MEM_PROVIDER to codex and CLAUDE_MEM_CODEX_PATH to "${codexPath}" in ~/.claude-mem/settings.json)`;
      }
      const detail = status.remediation
        ? `${status.message}${codexHint} — ${status.remediation}`
        : `${status.message}${codexHint}`;
      checks.push({
        name: 'Claude CLI setup',
        status: 'warn',
        detail,
        required: false,
      });
    } else if (status.dependency === 'codex_cli' && status.kind === 'setup_required') {
      const detail = status.remediation
        ? `${status.message} — ${status.remediation}`
        : status.message;
      checks.push({
        name: 'Codex CLI setup',
        status: 'warn',
        detail,
        required: false,
      });
    } else if (status.dependency === 'uvx' && status.kind === 'vector_search_unavailable') {
      const detail = status.remediation
        ? `${status.message} — ${status.remediation}`
        : status.message;
      checks.push({
        name: 'uvx (vector search)',
        status: 'warn',
        detail,
        required: false,
      });
    } else if (status.dependency === 'chroma' && status.kind === 'vector_search_unavailable') {
      const detail = status.remediation
        ? `${status.message} — ${status.remediation}`
        : status.message;
      checks.push({
        name: 'Chroma vector search',
        status: 'warn',
        detail,
        required: false,
      });
    } else if (status.dependency === 'observer_dir' && status.kind === 'setup_required') {
      const detail = status.remediation
        ? `${status.message} — ${status.remediation}`
        : status.message;
      checks.push({
        name: 'Observer data directory',
        status: 'warn',
        detail,
        required: false,
      });
    }
  }
  return checks;
}

async function probeChromaCensus(): Promise<CheckResult> {
  const name = 'Chroma processes';
  if (IS_WINDOWS) {
    return { name, status: 'ok', detail: 'not checked on Windows', required: false };
  }
  let registered = 0;
  try {
    const registryPath = paths.supervisorRegistry();
    if (existsSync(registryPath)) {
      const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as { processes?: Record<string, { type?: string }> };
      registered = Object.values(raw.processes ?? {}).filter((p) => p.type === 'chroma').length;
    }
  } catch {
    // unreadable registry: report from the process table alone
  }
  try {
    const rows = await readProcessTablePosix();
    const { roots, orphans } = findOrphanedChromaRoots(rows, { isAlive: isPidAlive, selfPid: process.pid });
    const detail = `${roots.length} live chroma-mcp tree(s), ${registered} registered, ${orphans.length} orphaned`;
    if (orphans.length > 0) {
      return {
        name,
        status: 'warn',
        detail: `${detail} — orphans are reaped at the next worker start (claude-mem worker restart)`,
        required: false,
      };
    }
    return { name, status: 'ok', detail, required: false };
  } catch (error) {
    return {
      name,
      status: 'warn',
      detail: `could not read the process table: ${error instanceof Error ? error.message : String(error)}`,
      required: false,
    };
  }
}

const MISSING_DEPENDENCIES_SHOWN = 5;

/** The "Plugin installed" row: root, version and dependency completeness. Exported for tests. */
export function pluginRootCheck(resolution: PluginRootResolution | null): CheckResult {
  const name = 'Plugin installed';
  if (!resolution) {
    return { name, status: 'fail', detail: 'run `npx claude-mem install`', required: true };
  }
  const where = resolution.version ? `${resolution.root} (v${resolution.version})` : resolution.root;
  const missing = resolution.missingDependencies;
  if (missing.length === 0) {
    return { name, status: 'ok', detail: where, required: true };
  }
  const shown = missing.slice(0, MISSING_DEPENDENCIES_SHOWN).join(', ');
  const more = missing.length > MISSING_DEPENDENCIES_SHOWN ? `, +${missing.length - MISSING_DEPENDENCIES_SHOWN} more` : '';
  return {
    name,
    status: 'fail',
    detail: `${where} — missing ${shown}${more} — run \`npx claude-mem repair\``,
    required: true,
  };
}

/**
 * The "tree-sitter CLI" row for the plugin root the worker runs from. It
 * resolves the CLI the same way the parser does, so a working tree-sitter on
 * PATH counts when the package-local one is missing or cannot run (#4858).
 * Exported for tests, which also pass searchPath.
 */
export async function treeSitterCliCheck(pluginRoot: string, searchPath: string = process.env.PATH ?? ''): Promise<CheckResult> {
  const name = 'tree-sitter CLI';
  const packageLocalBinPath = treeSitterCliBinaryPath(pluginRoot);
  const resolvedBinPath = resolveTreeSitterBinPathFor(packageLocalBinPath, searchPath);
  const check = checkTreeSitterCliLoadable(resolvedBinPath, searchPath);
  if (check.loadable) {
    return {
      name,
      status: 'ok',
      detail: isAbsolute(resolvedBinPath) ? resolvedBinPath : `${resolvedBinPath} on PATH`,
      required: false,
    };
  }
  const problem = check.present ? check.reason : `missing at ${packageLocalBinPath} and not on PATH`;
  return {
    name,
    status: 'warn',
    detail: `${problem} — smart_search/smart_outline disabled; run \`npx claude-mem repair\`, or ${TREE_SITTER_CLI_PATH_WORKAROUND}`,
    required: false,
  };
}

/** The "Marketplace manifest" row. Exported for tests. */
export function marketplaceManifestCheck(marketplaceDir: string): CheckResult {
  const manifestPath = join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  return existsSync(manifestPath)
    ? { name: 'Marketplace manifest', status: 'ok', detail: manifestPath, required: false }
    : {
        name: 'Marketplace manifest',
        status: 'warn',
        detail: 'missing — Claude Code may not find the plugin; run `npx claude-mem install`',
        required: false,
      };
}

/**
 * PATH minus the directories whose `claude-mem` resolves to the running CLI, when that CLI is npx's temporary copy
 * (`<cache>/_npx/<hash>/node_modules`). No persistent PATH points into npx's cache, so hooks never reach it. A global
 * or local install of the CLI stays: hooks do reach it, and it is not the launcher.
 */
function pathWithoutRunningCli(pathValue: string, platform: NodeJS.Platform, runningCliPath: string | undefined): string {
  const platformPath = platform === 'win32' ? windowsPath : posixPath;
  const runningCli = runningCliPath ? realPathOrNull(runningCliPath) : null;
  if (!runningCli || !runningCli.includes(`${platformPath.sep}_npx${platformPath.sep}`)) return pathValue;
  return pathValue
    .split(platformPath.delimiter)
    .filter(directory => !directoryRunsCli(directory.trim(), platform, runningCli))
    .join(platformPath.delimiter);
}

/**
 * True when `claude-mem` in `directory` is the running CLI. On POSIX, npx's `node_modules/.bin/claude-mem` is a
 * symlink to it. On Windows, npm writes `claude-mem.cmd` / `claude-mem.ps1` wrappers instead, whose script path
 * points at that same file.
 */
function directoryRunsCli(directory: string, platform: NodeJS.Platform, runningCli: string): boolean {
  if (!directory) return false;
  if (platform !== 'win32') return realPathOrNull(join(directory, 'claude-mem')) === runningCli;
  return ['claude-mem.cmd', 'claude-mem.ps1'].some((shimFileName) => {
    const shimPath = windowsPath.join(directory, shimFileName);
    let shimText: string;
    try {
      shimText = readFileSync(shimPath, 'utf-8');
    } catch {
      return false;
    }
    return windowsShimScriptPaths(shimPath, shimText).some((scriptPath) => realPathOrNull(scriptPath) === runningCli);
  });
}

/**
 * Script paths a Windows npm cmd-shim (`.cmd` / `.ps1`) launches, resolved
 * against the shim's directory. npm's wrapper and `process.argv[1]` are
 * different files: the wrapper is `claude-mem.cmd`, and argv is
 * `dist/npx-cli/index.js`. Exported for tests.
 */
export function windowsShimScriptPaths(shimPath: string, shimText: string): string[] {
  const shimDirectory = windowsPath.dirname(shimPath);
  const targets: string[] = [];
  const seen = new Set<string>();
  const add = (scriptPath: string) => {
    const trimmed = scriptPath.trim().replace(/^["']|["']$/g, '');
    if (!trimmed || !/\.js$/i.test(trimmed)) return;
    const resolved = windowsPath.isAbsolute(trimmed)
      ? windowsPath.normalize(trimmed)
      : windowsPath.normalize(windowsPath.join(shimDirectory, trimmed));
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(resolved);
  };

  // cmd-shim: `"%_prog%"  "%dp0%\..\claude-mem\dist\npx-cli\index.js" %*`
  for (const match of shimText.matchAll(/%dp0%\\+([^"%\r\n]+)/gi)) add(match[1]);
  // cmd-shim .ps1: `& "node$exe" "$basedir/../claude-mem/dist/npx-cli/index.js" $args`
  for (const match of shimText.matchAll(/\$basedir[\\/]+([^"'\s]+)/gi)) add(match[1]);
  return targets;
}

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The "Hook launcher" row: where `claude-mem` resolves on PATH, the protocol it
 * prints, and one timed `--version` round trip. Hooks call `claude-mem` in exec
 * form, so a missing launcher surfaces in Claude Code as
 * `Executable not found in $PATH: "claude-mem"` on every hook. Required: a
 * missing launcher, or a `claude-mem` on PATH that is not the launcher, fails
 * doctor. An older protocol only warns, because the SessionStart self-heal
 * (ensure-launcher.cjs) replaces it on the next startup. Exported for tests.
 *
 * `npx claude-mem doctor` runs with npx's own `node_modules/.bin` first on PATH, where `claude-mem` is this CLI.
 * Hooks run outside npx, so when this CLI (`runningCliPath`) is npx's copy, PATH directories that resolve to it
 * are skipped.
 */
export function hookLauncherCheck(
  host: LauncherHostEnvironment = currentLauncherHostEnvironment(),
  runningCliPath: string | undefined = process.argv[1],
): CheckResult {
  const name = 'Hook launcher';
  const reinstallHint = 'run `npx claude-mem install`';
  const searchPath = pathWithoutRunningCli(host.environmentVariables.PATH ?? '', host.platform, runningCliPath);
  const launcherOnPath = findExecutableOnPath('claude-mem', searchPath, host.platform);
  if (!launcherOnPath) {
    const placedBinaryPath = resolveLauncherBinaryPath(host);
    return {
      name,
      status: 'fail',
      detail: existsSync(placedBinaryPath)
        ? `installed at ${placedBinaryPath} but its directory is not on PATH — open a new terminal, or ${reinstallHint}`
        : `claude-mem not on PATH — hooks fail with 'Executable not found in $PATH: "claude-mem"'; ${reinstallHint}`,
      required: true,
    };
  }
  const probeStartedAt = performance.now();
  const { protocol: printedProtocol, failure: probeFailure } = probeLauncherVersion(launcherOnPath);
  const roundTripMilliseconds = Math.round(performance.now() - probeStartedAt);
  if (printedProtocol === null) {
    return {
      name,
      status: 'fail',
      detail: `${launcherOnPath} did not report a launcher protocol (--version ${probeFailure}); ${reinstallHint}`,
      required: true,
    };
  }
  if (printedProtocol !== LAUNCHER_PROTOCOL) {
    return {
      name,
      status: 'warn',
      detail: `${launcherOnPath} speaks protocol ${printedProtocol}, expected ${LAUNCHER_PROTOCOL}; ${reinstallHint}`,
      required: true,
    };
  }
  return {
    name,
    status: 'ok',
    detail: `${launcherOnPath} (protocol ${printedProtocol}, --version ${roundTripMilliseconds} ms)`,
    required: true,
  };
}

/** Where the "Auto-update" row reads from: autoUpdateDoctorSources in production, fixtures in tests. */
export interface AutoUpdateDoctorSources {
  now: number;
  /**
   * The worker check's gates 1 and 2 (auto-update-check.ts
   * readAutoUpdateSwitches) as doctor's own environment reads them, used only
   * while the worker has recorded no decision. Throws AutoUpdateCheckError
   * when a file they read cannot be read.
   */
  readSwitches: () => AutoUpdateSwitchesRead;
  /** Claude Code's settings files, read with the worker's reader, for the extraKnownMarketplaces declaration in force. Throws on a managed settings file Claude Code refuses to start with. */
  readClaudeCodeSettingsEnv: () => ClaudeCodeSettingsEnvRead;
  /** Claude Code's plugin records, read with the worker's reader, for known_marketplaces.json. */
  readClaudeCodePluginState: () => ClaudeCodePluginState;
  /** The version the install resolves to (worker-utils.ts resolvePluginRoot), null when nothing resolves. */
  installedVersion: string | null;
  statePath: string;
  /** auto-update-state-file.ts readAutoUpdateStateFile: reads without writing or logging; throws on a read error other than a missing file. */
  readStateFile: (statePath: string) => AutoUpdateStateFileRead;
  /** auto-update-install-shape.ts readClaudeMemInstallShape on the install, the checks the SessionStart notice makes. */
  readInstallShape: () => ClaudeMemInstallShape;
  /** process-registry.ts isPidAlive. */
  isProcessAlive: (pid: number) => boolean;
  /** How an instant is shown: toLocaleString, as the Backups row shows its last snapshot. */
  formatTime: (epochMs: number) => string;
}

/**
 * The production sources: the same readers the worker's tick uses
 * (auto-update-switch-readers.ts), with this process's environment, the plugin
 * root doctor already resolved, the state file in the data dir, and the
 * install's shape read where the installer writes it.
 */
export function autoUpdateDoctorSources(pluginRoot: PluginRootResolution | null): AutoUpdateDoctorSources {
  const readers = productionAutoUpdateSwitchReaders({ env: process.env, resolvePluginRoot: () => pluginRoot });
  return {
    now: Date.now(),
    readSwitches: () => readAutoUpdateSwitches(readers),
    readClaudeCodeSettingsEnv: readers.readClaudeCodeSettingsEnv,
    readClaudeCodePluginState: readers.readClaudeCodePluginState,
    installedVersion: pluginRoot?.version ?? null,
    statePath: autoUpdateStatePath(),
    readStateFile: readAutoUpdateStateFile,
    readInstallShape: () => readClaudeMemInstallShape({ installedPluginsPath: installedPluginsPath(), marketplaceDirectory: marketplaceDirectory() }),
    isProcessAlive: isPidAlive,
    formatTime: (epochMs) => new Date(epochMs).toLocaleString(),
  };
}

/**
 * The "Auto-update" row. Its first line is the takeaway; each line after it
 * is one fact:
 *  - on, or off and why, as the worker last decided it (the state file's
 *    lastDecision), and once the attempt its `apply` started has ended, how
 *    it ended: doctor runs in a terminal whose environment can differ from
 *    the worker's, so it works the status out itself, with the worker
 *    check's own gates 1 and 2, only while the worker has recorded none, and
 *    says so;
 *  - the installed version, the promoted version last seen, the last check;
 *  - the last attempt, with its stage, and whether a worker has since shown
 *    the install works; an attempt in flight;
 *  - Claude Code's own background update of claude-mem's marketplace as
 *    Claude Code reads it now, and what claude-mem last did with it;
 *  - with no state file, that no check has run here yet.
 * It warns only when the person needs to act: an automatic update may have
 * left the install not working (the case the SessionStart notice reports,
 * with the same fix line: auto-update-state-file.ts autoUpdateBrokenInstall),
 * or the last check failed while the updater is on. A failed attempt is
 * information, with its stage: the installed version still works. Read-only,
 * and never required: the install's own rows say whether it works. Exported
 * for tests.
 */
export function autoUpdateCheck(sources: AutoUpdateDoctorSources): CheckResult {
  const name = 'Auto-update';
  const time = sources.formatTime;
  const unreadable: string[] = [];

  let stateFile: AutoUpdateStateFileRead | null = null;
  try {
    stateFile = sources.readStateFile(sources.statePath);
    if (stateFile.problem !== null) unreadable.push(capitalizeFirst(describeAutoUpdateStateFileProblem(sources.statePath, stateFile.problem)));
  } catch (error: unknown) {
    unreadable.push(`Cannot read ${sources.statePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const state = stateFile?.state ?? null;
  const status = autoUpdateStatus(state, sources);

  const broken = state === null ? null : autoUpdateBrokenInstall(state, sources.now, sources.isProcessAlive, () => {
    const shape = sources.readInstallShape();
    if (shape.kind === 'registration-unreadable') unreadable.push(`Cannot check the install for an interrupted update: ${shape.problem}`);
    return shape;
  });
  const warnings: string[] = [];
  if (broken !== null) warnings.push(`claude-mem may not work: ${describeAutoUpdateBrokenInstall(broken)}`);
  if (status.updaterOn && state?.lastCheckError) warnings.push(`The last update check failed: ${state.lastCheckError.message}`);

  const lines = [...warnings, status.line, ...unreadable, `Installed: ${sources.installedVersion ?? 'none found'}`];
  if (stateFile !== null && !stateFile.exists) {
    lines.push('No auto-update check has run on this machine yet. An install from before the first release with auto-update needs one `npx claude-mem update` by hand.');
  } else if (state !== null) {
    lines.push(`Promoted: ${state.lastSeenPromotedVersion ?? 'not seen yet'}`);
    lines.push(`Last check: ${state.lastNetworkCheckAt === null ? 'never' : time(state.lastNetworkCheckAt)}`);
    lines.push(state.lastAttemptOutcome === null ? 'Last update: none yet' : `Last update: ${describeLastAttempt(state.lastAttemptOutcome, time)}`);
    if (state.inFlightAttempt !== null) lines.push(describeAttemptInFlight(state.inFlightAttempt, sources));
  }
  lines.push(describeClaudeCodeBackgroundUpdate(state, sources));
  if (broken !== null) lines.push(autoUpdateFixInstruction(broken.fix, targetVersionOf(broken)));

  return { name, status: warnings.length > 0 ? 'warn' : 'ok', detail: lines.join('\n'), required: false };
}

/**
 * The status line: the worker's last recorded decision, or, while there is
 * none, what gates 1 and 2 read in doctor's own environment, said to be that.
 * After an `apply` with no attempt in flight, it is how that attempt ended:
 * the worker records `apply` before it launches the attempt
 * (auto-update-check.ts gate 9) and records no other decision until its next
 * tick, while the supervisor replaces the attempt in flight with its outcome
 * (auto-update-apply.ts), so "installing" would outlast the install.
 * updaterOn is null when the status cannot be read.
 */
function autoUpdateStatus(state: AutoUpdateState | null, sources: AutoUpdateDoctorSources): { line: string; updaterOn: boolean | null } {
  const recorded = state?.lastDecision ?? null;
  if (state !== null && recorded !== null) {
    const updaterOn = !AUTO_UPDATE_OFF_DECISIONS.has(recorded.decision);
    const endedAttempt = recorded.decision === 'apply' && state.inFlightAttempt === null ? state.lastAttemptOutcome : null;
    if (endedAttempt !== null) return { updaterOn, line: `On: ${describeEndedAttempt(endedAttempt, sources.formatTime)}` };
    return { updaterOn, line: `${updaterOn ? 'On' : 'Off'}: ${recorded.reason} (the worker's decision at ${sources.formatTime(recorded.decidedAt)})` };
  }
  const workedOutHere = '(worked out by doctor, because the worker has not recorded a decision yet; its environment can differ from this terminal\'s)';
  let switches: AutoUpdateSwitchesRead;
  try {
    switches = sources.readSwitches();
  } catch (error: unknown) {
    // The worker's tick stops at the same stage every hour, so nothing updates until the file is fixed.
    const cause = error instanceof AutoUpdateCheckError && error.cause !== undefined ? error.cause : error;
    return { updaterOn: null, line: `Off until this is fixed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (switches.kind === 'off') return { updaterOn: false, line: `Off: ${describeAutoUpdateDecision(switches.decision)} ${workedOutHere}` };
  return { updaterOn: true, line: `On ${workedOutHere}` };
}

/** How the attempt the worker's `apply` started ended: updated to its target, or not completed, with its result and stage. */
function describeEndedAttempt(outcome: AutoUpdateAttemptOutcome, time: (epochMs: number) => string): string {
  if (outcome.result === 'applied') return `updated to ${outcome.targetVersion} at ${time(outcome.finishedAt)}`;
  return `the last update to ${outcome.targetVersion} did not complete (${describeAttemptEnding(outcome, time)})`;
}

/** The last attempt: its versions, result and stage, when it ended, and whether a worker has since shown the install works. */
function describeLastAttempt(outcome: AutoUpdateAttemptOutcome, time: (epochMs: number) => string): string {
  return `${outcome.previousVersion} → ${outcome.targetVersion}, ${describeAttemptEnding(outcome, time)}${describeResolution(outcome, time)}`;
}

/** An attempt's result, its stage when it failed, and when it ended: "failed at installer-exit, <time>". */
function describeAttemptEnding(outcome: AutoUpdateAttemptOutcome, time: (epochMs: number) => string): string {
  const stage = outcome.failureStage ? ` at ${outcome.failureStage}` : '';
  return `${outcome.result}${stage}, ${time(outcome.finishedAt)}`;
}

/** How a failure was resolved, when it was: a worker on a version that finished starting since. */
function describeResolution(resolved: { resolvedAt?: number; resolvedWithWorkerVersion?: string }, time: (epochMs: number) => string): string {
  if (resolved.resolvedAt === undefined) return '';
  return resolved.resolvedWithWorkerVersion === undefined
    ? `; fixed at ${time(resolved.resolvedAt)}`
    : `; fixed: a worker on ${resolved.resolvedWithWorkerVersion} finished starting at ${time(resolved.resolvedAt)}`;
}

function describeAttemptInFlight(attempt: AutoUpdateInFlightAttempt, sources: AutoUpdateDoctorSources): string {
  const versions = `${attempt.previousVersion} → ${attempt.targetVersion}, started ${sources.formatTime(attempt.startedAt)}`;
  const reading = readInFlightAttempt(attempt, sources.now, sources.isProcessAlive);
  if (reading === 'running') return `In progress: ${versions}`;
  if (reading === 'never-started') return `Never started: ${versions}; the worker records it at its next check`;
  if (reading === 'interrupted') return `Interrupted: ${versions}; the worker records how it ended at its next check`;
  return `Interrupted: ${versions}${describeResolution(attempt, sources.formatTime)}`;
}

/**
 * Claude Code's own background update of the thedotmack marketplace, as
 * Claude Code reads it now (auto-update-check.ts
 * claudeCodeBackgroundUpdateSetting, over the worker's readers), and what
 * claude-mem last did with it.
 */
function describeClaudeCodeBackgroundUpdate(state: AutoUpdateState | null, sources: AutoUpdateDoctorSources): string {
  let setting: string;
  try {
    const inForce = claudeCodeBackgroundUpdateSetting(
      sources.readClaudeCodeSettingsEnv().claudeMemMarketplaceDeclarations,
      sources.readClaudeCodePluginState().knownMarketplaces,
    );
    setting = inForce.kind === 'set'
      ? `${inForce.on ? 'on' : 'off'} (set in ${inForce.setIn})`
      : inForce.kind === 'off-by-default' ? `off (${inForce.why})` : `cannot be read (${inForce.problem})`;
  } catch (error: unknown) {
    setting = `cannot be read (${error instanceof Error ? error.message : String(error)})`;
  }
  const lastAction = state === null
    ? ''
    : state.claudeCodeBackgroundUpdateLeftOnReason !== null
      ? `; claude-mem left it on: ${state.claudeCodeBackgroundUpdateLeftOnReason}`
      : state.claudeCodeBackgroundUpdateTurnedOffAt !== null
        ? `; claude-mem turned it off at ${sources.formatTime(state.claudeCodeBackgroundUpdateTurnedOffAt)}`
        : '; claude-mem has not changed it';
  return `Claude Code's background update: ${setting}${lastAction}`;
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The "Claude Code version" row. Warns below the exec-form minimum, because an
 * older Claude Code ignores the hooks' `args` and runs bare `claude-mem`,
 * which captures nothing. Not required: a missing or unparseable version
 * passes silently. Exported for tests.
 */
export function claudeCodeVersionCheck(detectedClaudeCodeVersion: string | undefined): CheckResult {
  const name = 'Claude Code version';
  const tooOldWarning = claudeCodeVersionTooOldWarning(detectedClaudeCodeVersion);
  if (tooOldWarning) return { name, status: 'warn', detail: tooOldWarning, required: false };
  return {
    name,
    status: 'ok',
    detail: detectedClaudeCodeVersion
      ? `${detectedClaudeCodeVersion} (hooks need ${MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS}+)`
      : 'not detected (claude not on PATH)',
    required: false,
  };
}

function isLocalEndpointUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) return true;
  if (bare === '::1' || bare === '0.0.0.0' || bare === '::') return true;
  if (/^127\./.test(bare)) return true;
  if (/^10\./.test(bare)) return true;
  if (/^192\.168\./.test(bare)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true;
  return false;
}

export interface OpenAICompatCheckStatus {
  hasEndpoint: boolean;
  hasModel: boolean;
  hasKey: boolean;
  requiresKey: boolean;
  endpointUrl?: string;
  model?: string;
}

export interface ObserverProviderCheckOptions {
  provider?: string;
  claudeDetected: boolean;
  detectedClaudeVersion?: string;
  configuredClaudePath?: string;
  codexDetected: boolean;
  codexOnPath?: boolean;
  codexPath?: string | null;
  configuredCodexPath?: string;
  hasOpenRouterKey?: boolean;
  hasGeminiKey?: boolean;
  openaiCompat?: OpenAICompatCheckStatus;
}

/**
 * Validates that the configured observer provider has its required CLI executable
 * or API credentials available (#5359). When the default or configured provider
 * is `claude` but Claude CLI is missing while Codex CLI is installed, informs the
 * user that switching to `codex` is available so memory generation works.
 */
export function observerProviderCheck(options: ObserverProviderCheckOptions): CheckResult {
  const name = 'Observer provider';
  const provider = (options.provider?.trim() || 'claude').toLowerCase();

  if (provider === 'claude') {
    if (options.claudeDetected) {
      const versionInfo = options.detectedClaudeVersion ? ` (Claude Code v${options.detectedClaudeVersion})` : '';
      return {
        name,
        status: 'ok',
        detail: `claude${versionInfo}`,
        required: false,
      };
    }

    if (options.codexDetected) {
      const switchHint = options.codexOnPath || !options.codexPath
        ? 'set CLAUDE_MEM_PROVIDER to codex in ~/.claude-mem/settings.json'
        : `set CLAUDE_MEM_PROVIDER to codex and CLAUDE_MEM_CODEX_PATH to "${options.codexPath}" in ~/.claude-mem/settings.json`;
      return {
        name,
        status: 'warn',
        detail: `claude configured, but Claude CLI not found on PATH or at CLAUDE_CODE_PATH. Codex CLI is available — ${switchHint} to enable observation generation`,
        required: false,
      };
    }

    return {
      name,
      status: 'warn',
      detail: `claude configured, but Claude CLI not found on PATH or at CLAUDE_CODE_PATH; observation generation will be paused until installed`,
      required: false,
    };
  }

  if (provider === 'codex') {
    const isCustomPath = Boolean(options.configuredCodexPath && options.configuredCodexPath !== 'codex');
    if (isCustomPath) {
      if (options.codexDetected) {
        return {
          name,
          status: 'ok',
          detail: `codex (${options.codexPath || options.configuredCodexPath})`,
          required: false,
        };
      }
      return {
        name,
        status: 'warn',
        detail: options.configuredCodexPath!.startsWith('~')
          ? `codex configured, but CLAUDE_MEM_CODEX_PATH "${options.configuredCodexPath}" starts with ~, which the worker does not expand; use an absolute path`
          : `codex configured, but CLAUDE_MEM_CODEX_PATH "${options.configuredCodexPath}" is missing or not executable; observation generation will be paused until installed`,
        required: false,
      };
    }

    if (options.codexOnPath) {
      return {
        name,
        status: 'ok',
        detail: 'codex (Codex CLI available)',
        required: false,
      };
    }

    if (options.codexDetected && options.codexPath) {
      return {
        name,
        status: 'warn',
        detail: `codex configured, but codex is not on PATH. Found at ${options.codexPath} — set CLAUDE_MEM_CODEX_PATH to "${options.codexPath}" in ~/.claude-mem/settings.json`,
        required: false,
      };
    }

    return {
      name,
      status: 'warn',
      detail: `codex configured, but Codex CLI not found on PATH or at CLAUDE_MEM_CODEX_PATH; observation generation will be paused until installed`,
      required: false,
    };
  }

  if (provider === 'openrouter') {
    if (options.hasOpenRouterKey) {
      return {
        name,
        status: 'ok',
        detail: 'openrouter (API key configured)',
        required: false,
      };
    }
    return {
      name,
      status: 'warn',
      detail: 'openrouter configured, but no API key configured (set CLAUDE_MEM_OPENROUTER_API_KEY in settings.json or OPENROUTER_API_KEY in .env)',
      required: false,
    };
  }

  if (provider === 'gemini') {
    if (options.hasGeminiKey) {
      return {
        name,
        status: 'ok',
        detail: 'gemini (API key configured)',
        required: false,
      };
    }
    return {
      name,
      status: 'warn',
      detail: 'gemini configured, but no API key configured (set CLAUDE_MEM_GEMINI_API_KEY in settings.json or GEMINI_API_KEY in .env)',
      required: false,
    };
  }

  if (provider === 'openai-compatible') {
    const compat = options.openaiCompat;
    if (!compat || !compat.hasEndpoint) {
      return {
        name,
        status: 'warn',
        detail: 'openai-compatible configured, but no endpoint URL or preset is set (set CLAUDE_MEM_OPENAI_COMPAT_BASE_URL or CLAUDE_MEM_OPENAI_COMPAT_PRESET in settings.json)',
        required: false,
      };
    }
    if (!compat.hasModel) {
      return {
        name,
        status: 'warn',
        detail: 'openai-compatible configured, but no model is configured (set CLAUDE_MEM_OPENAI_COMPAT_MODEL in settings.json)',
        required: false,
      };
    }
    if (compat.requiresKey && !compat.hasKey) {
      return {
        name,
        status: 'warn',
        detail: 'openai-compatible configured, but required API key is missing (set CLAUDE_MEM_OPENAI_COMPAT_API_KEY in settings.json or OPENAI_COMPAT_API_KEY in .env)',
        required: false,
      };
    }
    return {
      name,
      status: 'ok',
      detail: `openai-compatible (${compat.model} via ${compat.endpointUrl || 'configured endpoint'})`,
      required: false,
    };
  }

  if (provider === 'host') {
    return {
      name,
      status: 'ok',
      detail: 'host',
      required: false,
    };
  }

  return {
    name,
    status: 'warn',
    detail: `Unknown provider "${provider}". Supported providers: claude, codex, openrouter, gemini, openai-compatible, host`,
    required: false,
  };
}

export async function runDoctorCommand(): Promise<void> {
  const checks: CheckResult[] = [];
  const dataDir = resolveDataDir();

  // 1. Bun (required — hooks run on Bun).
  const bunVersion = probeVersion('bun');
  checks.push({
    name: 'Bun runtime',
    status: bunVersion ? 'ok' : 'fail',
    detail: bunVersion ? `v${bunVersion.replace(/^v/, '')}` : 'not found on PATH — install: https://bun.sh',
    required: true,
  });

  // 2. uv (warn-only — only needed for vector search).
  const uvVersion = probeVersion('uv');
  checks.push({
    name: 'uv (vector search)',
    status: uvVersion ? 'ok' : 'warn',
    detail: uvVersion ? uvVersion : 'not found — vector/semantic search disabled until installed',
    required: false,
  });

  // 3. Plugin installed: the root the worker spawns from (the shared
  // resolveWorkerScript() oracle — cache, marketplace, or dev checkout), with
  // its version and dependency completeness.
  const pluginRoot = resolvePluginRoot();
  const installed = pluginRoot !== null;
  checks.push(pluginRootCheck(pluginRoot));

  // 3b. tree-sitter CLI at that root: smart_search and smart_outline shell out
  // to it, and installs suppress the script that downloads it (#2910).
  if (pluginRoot) checks.push(await treeSitterCliCheck(pluginRoot.root));

  // 3c. The on-PATH `claude-mem` hook launcher (plan-17 #3605).
  checks.push(hookLauncherCheck());

  // 3d. claude-mem's own updater: on or off, what it last did, and the fix
  // when an automatic update may have left the install not working.
  checks.push(autoUpdateCheck(autoUpdateDoctorSources(pluginRoot)));

  // 4. Marketplace runtime root materialized. The .install-version marker is
  // written only by the npx installer; installs via Claude Code's own plugin
  // marketplace flow and dev `build-and-sync` never write one, so a missing
  // marker with node_modules present is informational, not a failure (#3661).
  // Required only when the marketplace copy is the root the worker spawns
  // from; a cache install is healthy without it.
  const marketplaceDir = marketplaceDirectory();
  const marketplaceIsActiveRoot = pluginRoot?.root === join(marketplaceDir, 'plugin');
  const marketplaceNodeModules = join(marketplaceDir, 'node_modules');
  const marketplaceMarker = join(marketplaceDir, '.install-version');
  const depsPresent = existsSync(marketplaceNodeModules);
  const markerPresent = existsSync(marketplaceMarker);
  const marketplaceCurrent = installed && isInstallCurrent(marketplaceDir, readPluginVersion());
  const marketplaceDetail = marketplaceCurrent
    ? 'node_modules and install marker present'
    : !depsPresent
      ? 'node_modules missing — run `npx claude-mem repair`'
      : !markerPresent
        ? 'node_modules present; no npx install marker (normal for marketplace/dev installs)'
        : 'install marker stale — run `npx claude-mem repair`';
  const marketplaceStatus: CheckStatus = !installed
    ? 'warn'
    : marketplaceCurrent
      ? 'ok'
      : (depsPresent && !markerPresent) || !marketplaceIsActiveRoot
        ? 'warn'
        : 'fail';
  checks.push({
    name: 'Marketplace runtime',
    status: marketplaceStatus,
    detail: marketplaceDetail,
    required: marketplaceIsActiveRoot,
  });

  // 4b. Marketplace manifest. Claude Code loads the plugin through the
  // marketplace root's .claude-plugin/marketplace.json; installs made before it
  // shipped (#3424) cache-miss until reinstalled.
  checks.push(marketplaceManifestCheck(marketplaceDir));

  // 5. Worker health.
  // Where this client reaches the worker: settings.json, with env vars overriding it.
  const doctorSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true });
  const configuredClaudePath = doctorSettings.CLAUDE_CODE_PATH?.trim() || process.env.CLAUDE_CODE_PATH?.trim() || undefined;
  const detectedClaudeCode = detectClaudeCodeVersion(configuredClaudePath);

  const configuredCodexPath = doctorSettings.CLAUDE_MEM_CODEX_PATH?.trim() || process.env.CLAUDE_MEM_CODEX_PATH?.trim() || undefined;
  const codexPath = findCodexExecutablePath(configuredCodexPath);
  const codexAvailable = codexPath !== null;
  const codexOnPath = isCodexOnPath();

  let workerStatus: CheckStatus = 'fail';
  let workerDetail = '';
  let chromaChecks: CheckResult[] = [];
  let dependencyChecks: CheckResult[] = [];
  try {
    const workerUrl = getWorkerBaseUrl({ readOnly: true });
    workerDetail = `no response at ${workerUrl} — start with \`npx claude-mem start\``;
    const worker = await probeWorkerHealth(workerUrl);
    workerStatus = worker.status;
    workerDetail = worker.detail;
    chromaChecks = await probeChromaDiagnostics(worker.workerUrl);
    dependencyChecks = await probeWorkerDependencies(worker.workerUrl, codexAvailable, codexOnPath, codexPath);
  } catch (error: unknown) {
    if (error instanceof InvalidWorkerUrlError) workerDetail = error.message;
    // otherwise leave as fail
  }
  checks.push({
    name: 'Worker daemon',
    status: workerStatus,
    detail: workerDetail,
    required: false, // worker can be intentionally stopped; don't hard-fail
  });
  checks.push(...chromaChecks);
  checks.push(...dependencyChecks);

  // 5b. Observer provider and CLI reachability (#5359).
  const openRouterKeys = buildKeyPool(
    doctorSettings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '',
    doctorSettings.CLAUDE_MEM_OPENROUTER_API_KEYS || getCredential('OPENROUTER_API_KEYS') || '',
  );
  const geminiKeys = buildKeyPool(
    doctorSettings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '',
    doctorSettings.CLAUDE_MEM_GEMINI_API_KEYS || getCredential('GEMINI_API_KEYS') || '',
  );

  const compatPreset = resolveOpenAICompatPreset(doctorSettings.CLAUDE_MEM_OPENAI_COMPAT_PRESET);
  const compatConfiguredBaseUrl = (doctorSettings.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL ?? '').trim();
  const compatBaseUrl = compatConfiguredBaseUrl || compatPreset.baseUrl;
  const compatConfiguredModel = (doctorSettings.CLAUDE_MEM_OPENAI_COMPAT_MODEL ?? '').trim();
  const compatModel = compatConfiguredModel || compatPreset.defaultModel;
  const compatRequiresApiKey = compatConfiguredBaseUrl
    ? !isLocalEndpointUrl(compatConfiguredBaseUrl)
    : compatPreset.requiresApiKey;
  const compatKeys = buildKeyPool(
    doctorSettings.CLAUDE_MEM_OPENAI_COMPAT_API_KEY || getCredential('OPENAI_COMPAT_API_KEY') || '',
    doctorSettings.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS || getCredential('OPENAI_COMPAT_API_KEYS') || '',
  );

  checks.push(observerProviderCheck({
    provider: doctorSettings.CLAUDE_MEM_PROVIDER,
    claudeDetected: Boolean(detectedClaudeCode),
    detectedClaudeVersion: detectedClaudeCode,
    configuredClaudePath,
    codexDetected: codexAvailable,
    codexOnPath,
    codexPath,
    configuredCodexPath,
    hasOpenRouterKey: openRouterKeys.length > 0,
    hasGeminiKey: geminiKeys.length > 0,
    openaiCompat: {
      hasEndpoint: Boolean(compatBaseUrl),
      hasModel: Boolean(compatModel),
      hasKey: compatKeys.length > 0,
      requiresKey: compatRequiresApiKey,
      endpointUrl: compatBaseUrl,
      model: compatModel,
    },
  }));

  // 5c. Claude Code version: the exec-form hooks need `args` support.
  checks.push(claudeCodeVersionCheck(detectedClaudeCode));

  // 6. Windows Git Bash reachability. Runtime hooks run the launcher with no
  // shell; only the Setup hook (`claude --init` / `--maintenance`) still uses
  // `"shell": "bash"`, which Claude Code resolves through Git for Windows. So a
  // missing Git Bash only warns. No-op on macOS/Linux.
  if (IS_WINDOWS) {
    const gitBash = checkWindowsGitBash();
    checks.push({
      name: 'Git Bash (Windows)',
      status: gitBash.ok ? 'ok' : 'warn',
      detail: gitBash.detail,
      required: false,
    });
  }

  // 7. Last recorded install error (surface remediation if present).
  const lastErrorPath = join(dataDir, 'last-install-error.json');
  if (existsSync(lastErrorPath)) {
    let detail = `present at ${lastErrorPath}`;
    try {
      const record = JSON.parse(readFileSync(lastErrorPath, 'utf-8'));
      if (record && typeof record === 'object') {
        detail = `${record.categoryId ?? 'error'}: ${record.remediation ?? detail}`;
      }
    } catch {
      // keep generic detail
    }
    checks.push({
      name: 'Last install error',
      status: 'warn',
      detail,
      required: false,
    });
  }

  // Backups (informational). Backup settings live in settings.json, which the
  // env-only SettingsDefaultsManager.get cannot see; readOnly keeps doctor from
  // seeding or migrating the file.
  const backupSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true });
  if (backupSettings.CLAUDE_MEM_BACKUP_ENABLED !== 'true') {
    checks.push({
      name: 'Backups',
      status: 'ok',
      detail: 'disabled',
      required: false,
    });
  } else {
    const backupsDir = paths.backups();
    let newestMtime: number | null = null;
    if (existsSync(backupsDir)) {
      for (const name of readdirSync(backupsDir)) {
        if (!SNAPSHOT_FILE_PATTERN.test(name)) continue;
        // Retention can delete a snapshot between the listing and the stat;
        // skip it rather than abort the whole report.
        let mtime: number;
        try {
          mtime = statSync(join(backupsDir, name)).mtimeMs;
        } catch {
          continue;
        }
        if (newestMtime === null || mtime > newestMtime) newestMtime = mtime;
      }
    }
    const intervalHours = Number.parseFloat(backupSettings.CLAUDE_MEM_BACKUP_INTERVAL_HOURS);
    // Two missed intervals before warning: one late cycle (a worker that was
    // idle-exited when the timer would have fired) is normal, two is not.
    const staleThresholdMs = 2 * (Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 24) * 3_600_000;
    const fresh = newestMtime !== null && Date.now() - newestMtime <= staleThresholdMs;
    checks.push({
      name: 'Backups',
      status: fresh ? 'ok' : 'warn',
      detail: newestMtime === null
        ? 'enabled but no snapshots yet (the first one is taken a few minutes after the worker starts)'
        : fresh
          ? `last snapshot ${new Date(newestMtime).toLocaleString()}`
          : `last snapshot stale (${new Date(newestMtime).toLocaleString()}); is the worker running?`,
      required: false,
    });
  }

  const icon = (s: CheckStatus): string =>
    s === 'ok' ? styleText('green', '✓') : s === 'warn' ? styleText('yellow', '!') : styleText('red', '✗');

  // Chroma process census (#3905): live chroma-mcp trees against supervisor registry rows.
  // Anything other than one tree per row is the orphan leak. Read-only: the registry file is
  // parsed directly rather than through ProcessRegistry, whose initialize() prunes and persists.
  checks.push(await probeChromaCensus());

  console.log(styleText('bold', '\nclaude-mem doctor\n'));
  // A detail of several lines (the Auto-update row) continues under its first line.
  const detailContinuationIndent = ' '.repeat(`  ! ${''.padEnd(CHECK_NAME_COLUMN_WIDTH)} `.length);
  for (const c of checks) {
    const [firstDetailLine, ...moreDetailLines] = c.detail.split('\n');
    console.log(`  ${icon(c.status)} ${c.name.padEnd(CHECK_NAME_COLUMN_WIDTH)} ${styleText('dim', firstDetailLine)}`);
    for (const detailLine of moreDetailLines) console.log(`${detailContinuationIndent}${styleText('dim', detailLine)}`);
  }

  const hardFailures = checks.filter((c) => c.required && c.status === 'fail');
  console.log('');
  if (hardFailures.length === 0) {
    console.log(styleText('green', 'All required checks passed.'));
    // Windows: process.exit() while the probe fetches' sockets/abort-timers are
    // still closing trips libuv's uv_async_send assertion (nodejs/node#56645).
    // Set the exit code and return so Node drains pending handles first.
    process.exitCode = 0;
  } else {
    console.log(styleText('red', `${hardFailures.length} required check(s) failed — see remediation above.`));
    process.exitCode = 1;
  }
}
