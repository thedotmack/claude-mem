/**
 * ProcessManager - PID files, signal handlers, and child process lifecycle management
 *
 * Extracted from worker-service.ts monolith to provide centralized process management.
 * Handles:
 * - PID file management for daemon coordination
 * - Signal handler registration for graceful shutdown
 * - Child process enumeration and cleanup (especially for Windows zombie port fix)
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, rmSync, statSync, utimesSync, copyFileSync } from 'fs';
import { exec, execSync, spawn, spawnSync } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor, validateWorkerPidFile, type ValidateWorkerPidStatus } from '../../supervisor/index.js';

const execAsync = promisify(exec);

// Standard paths for PID file management
const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

// Orphaned process cleanup patterns and thresholds
// These are claude-mem processes that can accumulate if not properly terminated
const ORPHAN_PROCESS_PATTERNS = [
  'mcp-server.cjs',    // Main MCP server process
  'worker-service.cjs', // Background worker daemon
  'chroma-mcp'          // ChromaDB MCP subprocess
];

// Only kill processes older than this to avoid killing the current session.
// Per-pattern overrides apply when a row matches the listed substring; otherwise
// the default applies. chroma-mcp lifetime is bounded by its worker — when the
// worker is gone, the python child can sit forever consuming RAM/CPU (#2184, #2195).
const ORPHAN_MAX_AGE_MINUTES = 30;
// chroma-mcp is intentionally absent from the age-based reap path:
// healthy chroma-mcp instances naturally outlive any sensible age
// threshold (a long Claude session can keep one alive for hours).
// chroma-mcp is reaped only by orphan-specific signals (Unix ppid==1,
// Windows dead immediate parent). Other patterns use the default.
const ORPHAN_AGE_OVERRIDES_MINUTES: Record<string, number> = {};

// Periodic reaper interval — runs `cleanupOrphanedProcesses()` to catch orphans
// from worker crashes / SIGKILL where the in-process exit handlers can't fire.
const ORPHAN_REAPER_INTERVAL_MS = 120_000;
let orphanReaperTimer: NodeJS.Timeout | null = null;

interface RuntimeResolverOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  pathExists?: (candidatePath: string) => boolean;
  lookupInPath?: (binaryName: string, platform: NodeJS.Platform) => string | null;
}

function isBunExecutablePath(executablePath: string | undefined | null): boolean {
  if (!executablePath) return false;

  return /(^|[\\/])bun(\.exe)?$/i.test(executablePath.trim());
}

function lookupBinaryInPath(binaryName: string, platform: NodeJS.Platform): string | null {
  const command = platform === 'win32' ? `where ${binaryName}` : `which ${binaryName}`;

  let output: string;
  try {
    output = execSync(command, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', `Binary lookup failed for ${binaryName}`, { command }, error);
    } else {
      logger.debug('SYSTEM', `Binary lookup failed for ${binaryName}`, { command }, new Error(String(error)));
    }
    return null;
  }

  const firstMatch = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);

  return firstMatch || null;
}

// Memoize the resolved runtime path for the no-options call site (which is
// what spawnDaemon uses). Caches successful resolutions so repeated spawn
// attempts (crash loops, health thrashing) don't repeatedly hit `statSync`
// on the candidate paths.
//
// IMPORTANT: only success is cached. A `null` result (Bun not found) is
// never cached so that a long-running MCP server can recover if the user
// installs Bun in another terminal between the first failed lookup and a
// subsequent retry. Caching `null` would permanently break the process
// until restart. Per PR #1645 round-10 review.
//
// `undefined` means "not yet resolved"; tests that pass options bypass the
// cache entirely.
let cachedWorkerRuntimePath: string | undefined = undefined;

/**
 * Reset the memoized runtime path. Exported for test isolation only —
 * production code never needs to call this.
 */
export function resetWorkerRuntimePathCache(): void {
  cachedWorkerRuntimePath = undefined;
}

/**
 * Resolve the runtime executable for spawning the worker daemon.
 *
 * worker-service.cjs imports `bun:sqlite`, so it MUST run under Bun on every
 * platform — not just Windows. When the caller is already running under Bun
 * (e.g. the worker self-spawning from a hook), we reuse process.execPath to
 * avoid an extra PATH lookup. Otherwise (notably when the MCP server running
 * under Node spawns the worker for the first time) we locate the Bun binary
 * via env vars, well-known install locations, and finally the system PATH.
 */
export function resolveWorkerRuntimePath(options: RuntimeResolverOptions = {}): string | null {
  // Memoization fast path — only when called with no injected options. Tests
  // that pass options always run the full resolution (and never populate or
  // read the cache) to keep the existing test cases deterministic.
  const isMemoizable = Object.keys(options).length === 0;
  if (isMemoizable && cachedWorkerRuntimePath !== undefined) {
    return cachedWorkerRuntimePath;
  }

  const result = resolveWorkerRuntimePathUncached(options);

  // Only cache successful resolutions. See the comment on
  // `cachedWorkerRuntimePath` above for the rationale.
  if (isMemoizable && result !== null) {
    cachedWorkerRuntimePath = result;
  }
  return result;
}

function resolveWorkerRuntimePathUncached(options: RuntimeResolverOptions): string | null {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;

  // If already running under Bun, reuse it directly.
  if (isBunExecutablePath(execPath)) {
    return execPath;
  }

  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathExists = options.pathExists ?? existsSync;
  const lookupInPath = options.lookupInPath ?? lookupBinaryInPath;

  const candidatePaths: (string | undefined)[] = platform === 'win32'
    ? [
        env.BUN,
        env.BUN_PATH,
        path.join(homeDirectory, '.bun', 'bin', 'bun.exe'),
        path.join(homeDirectory, '.bun', 'bin', 'bun'),
        env.USERPROFILE ? path.join(env.USERPROFILE, '.bun', 'bin', 'bun.exe') : undefined,
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'bun', 'bun.exe') : undefined,
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'bun', 'bin', 'bun.exe') : undefined,
      ]
    : [
        env.BUN,
        env.BUN_PATH,
        path.join(homeDirectory, '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun',
        '/usr/bin/bun', // Debian/Ubuntu apt install path
        '/snap/bin/bun', // Ubuntu Snap install path
      ];

  for (const candidate of candidatePaths) {
    const normalized = candidate?.trim();
    if (!normalized) continue;

    if (isBunExecutablePath(normalized) && pathExists(normalized)) {
      return normalized;
    }

    // Allow command-style values from env (e.g. BUN=bun). The previous branch
    // would also match this candidate via isBunExecutablePath('bun') === true,
    // but pathExists('bun') is false because it's a relative name — so this
    // branch is what actually fires for the bare-command case. We return the
    // bare name unchanged so child_process.spawn() resolves it via PATH.
    if (normalized.toLowerCase() === 'bun') {
      return normalized;
    }
  }

  return lookupInPath('bun', platform);
}

import {
  captureProcessStartToken,
  verifyPidFileOwnership,
  type PidInfo
} from '../../supervisor/process-registry.js';
export { captureProcessStartToken, verifyPidFileOwnership, type PidInfo };

/**
 * Write PID info to the standard PID file location.
 *
 * Automatically captures a process-start token for `info.pid` if the caller
 * didn't supply one. The token lets future readers detect PID reuse across
 * reboots/container restarts — see captureProcessStartToken in
 * supervisor/process-registry.ts.
 */
export function writePidFile(info: PidInfo): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const resolvedToken = info.startToken ?? captureProcessStartToken(info.pid);
  const payload: PidInfo = resolvedToken ? { ...info, startToken: resolvedToken } : info;
  writeFileSync(PID_FILE, JSON.stringify(payload, null, 2));
}

/**
 * Read PID info from the standard PID file location
 * Returns null if file doesn't exist or is corrupted
 */
export function readPidFile(): PidInfo | null {
  if (!existsSync(PID_FILE)) return null;

  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'));
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.warn('SYSTEM', 'Failed to parse PID file', { path: PID_FILE }, error);
    } else {
      logger.warn('SYSTEM', 'Failed to parse PID file', { path: PID_FILE }, new Error(String(error)));
    }
    return null;
  }
}

/**
 * Remove the PID file (called during shutdown)
 */
export function removePidFile(): void {
  if (!existsSync(PID_FILE)) return;

  try {
    unlinkSync(PID_FILE);
  } catch (error: unknown) {
    // [ANTI-PATTERN IGNORED]: Cleanup function - PID file removal failure is non-critical
    if (error instanceof Error) {
      logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE }, error);
    } else {
      logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE }, new Error(String(error)));
    }
  }
}

/**
 * Get platform-adjusted timeout for worker-side socket operations (2.0x on Windows).
 *
 * Note: Two platform multiplier functions exist intentionally:
 * - getTimeout() in hook-constants.ts uses 1.5x for hook-side operations (fast path)
 * - getPlatformTimeout() here uses 2.0x for worker-side socket operations (slower path)
 */
export function getPlatformTimeout(baseMs: number): number {
  const WINDOWS_MULTIPLIER = 2.0;
  return process.platform === 'win32' ? Math.round(baseMs * WINDOWS_MULTIPLIER) : baseMs;
}

/**
 * Get all child process PIDs (Windows-specific)
 * Used for cleanup to prevent zombie ports when parent exits
 */
export async function getChildProcesses(parentPid: number): Promise<number[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  // SECURITY: Validate PID is a positive integer to prevent command injection
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    logger.warn('SYSTEM', 'Invalid parent PID for child process enumeration', { parentPid });
    return [];
  }

  try {
    // Use WQL -Filter to avoid $_ pipeline syntax that breaks in Git Bash (#1062, #1024).
    // Get-CimInstance with server-side filtering is also more efficient than piping through Where-Object.
    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -ExpandProperty ProcessId"`;
    const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, windowsHide: true });
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && /^\d+$/.test(line))
      .map(line => parseInt(line, 10))
      .filter(pid => pid > 0);
  } catch (error: unknown) {
    // Shutdown cleanup - failure is non-critical, continue without child process cleanup
    if (error instanceof Error) {
      logger.error('SYSTEM', 'Failed to enumerate child processes', { parentPid }, error);
    } else {
      logger.error('SYSTEM', 'Failed to enumerate child processes', { parentPid }, new Error(String(error)));
    }
    return [];
  }
}

/**
 * Force kill a process by PID
 * Windows: uses taskkill /F /T to kill process tree
 * Unix: uses SIGKILL
 */
export async function forceKillProcess(pid: number): Promise<void> {
  // SECURITY: Validate PID is a positive integer to prevent command injection
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.warn('SYSTEM', 'Invalid PID for force kill', { pid });
    return;
  }

  try {
    if (process.platform === 'win32') {
      // /T kills entire process tree, /F forces termination
      await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    logger.info('SYSTEM', 'Killed process', { pid });
  } catch (error: unknown) {
    // [ANTI-PATTERN IGNORED]: Shutdown cleanup - process already exited, continue
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'Process already exited during force kill', { pid }, error);
    } else {
      logger.debug('SYSTEM', 'Process already exited during force kill', { pid }, new Error(String(error)));
    }
  }
}

/**
 * Wait for processes to fully exit
 */
export async function waitForProcessesExit(pids: number[], timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const stillAlive = pids.filter(pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // process.kill(pid, 0) throws when PID doesn't exist — expected during cleanup
        // [ANTI-PATTERN IGNORED]: Tight loop checking 100s of PIDs every 100ms during cleanup
        return false;
      }
    });

    if (stillAlive.length === 0) {
      logger.info('SYSTEM', 'All child processes exited');
      return;
    }

    logger.debug('SYSTEM', 'Waiting for processes to exit', { stillAlive });
    await new Promise(r => setTimeout(r, 100));
  }

  logger.warn('SYSTEM', 'Timeout waiting for child processes to exit');
}

/**
 * Parse process elapsed time from ps etime format: [[DD-]HH:]MM:SS
 * Returns age in minutes, or -1 if parsing fails
 */
export function parseElapsedTime(etime: string): number {
  if (!etime || etime.trim() === '') return -1;

  const cleaned = etime.trim();
  let totalMinutes = 0;

  // DD-HH:MM:SS format
  const dayMatch = cleaned.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    totalMinutes = parseInt(dayMatch[1], 10) * 24 * 60 +
                   parseInt(dayMatch[2], 10) * 60 +
                   parseInt(dayMatch[3], 10);
    return totalMinutes;
  }

  // HH:MM:SS format
  const hourMatch = cleaned.match(/^(\d+):(\d+):(\d+)$/);
  if (hourMatch) {
    totalMinutes = parseInt(hourMatch[1], 10) * 60 + parseInt(hourMatch[2], 10);
    return totalMinutes;
  }

  // MM:SS format
  const minMatch = cleaned.match(/^(\d+):(\d+)$/);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }

  return -1;
}

/** Pick the most-specific age threshold for a row matching a known pattern. */
function ageThresholdForCommand(commandText: string): number {
  for (const [needle, minutes] of Object.entries(ORPHAN_AGE_OVERRIDES_MINUTES)) {
    if (commandText.includes(needle)) return minutes;
  }
  return ORPHAN_MAX_AGE_MINUTES;
}

/** Read the live worker.pid contents (without throwing on missing/garbage). */
function readLiveWorkerPid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const raw = readFileSync(PID_FILE, 'utf8').trim();
    // PID file may be JSON or plain int
    const parsed = raw.startsWith('{') ? JSON.parse(raw) : { pid: parseInt(raw, 10) };
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch { return null; }
    return pid;
  } catch {
    return null;
  }
}

/**
 * Enumerate orphaned claude-mem processes matching ORPHAN_PROCESS_PATTERNS.
 *
 * A process is orphaned if any of:
 *   - its parent process is init (Unix ppid==1) — re-parented because its
 *     spawning worker died (#2184)
 *   - its parent is not the live worker recorded in worker.pid (Windows analog)
 *   - it is older than the per-pattern age threshold and not the current process
 *
 * Per-pattern thresholds: chroma-mcp has a 5-minute floor; default 30 min.
 */
async function enumerateOrphanedProcesses(isWindows: boolean, currentPid: number): Promise<number[]> {
  const pidsToKill: number[] = [];
  const liveWorkerPid = readLiveWorkerPid();

  if (isWindows) {
    // Windows: Use WQL -Filter for server-side filtering (no $_ pipeline syntax).
    // Avoids Git Bash $_ interpretation (#1062) and PowerShell syntax errors (#1024).
    const wqlPatternConditions = ORPHAN_PROCESS_PATTERNS
      .map(p => `CommandLine LIKE '%${p}%'`)
      .join(' OR ');

    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter '(${wqlPatternConditions}) AND ProcessId != ${currentPid}' | Select-Object ProcessId, ParentProcessId, CommandLine, CreationDate | ConvertTo-Json"`;
    const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, windowsHide: true });

    if (!stdout.trim() || stdout.trim() === 'null') {
      logger.debug('SYSTEM', 'No orphaned claude-mem processes found (Windows)');
      return [];
    }

    const processes = JSON.parse(stdout);
    const processList = Array.isArray(processes) ? processes : [processes];
    const now = Date.now();

    for (const proc of processList) {
      const pid = proc.ProcessId;
      // SECURITY: Validate PID is positive integer and not current process
      if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;

      const ppid = Number.isInteger(proc.ParentProcessId) ? proc.ParentProcessId : 0;
      const commandText = String(proc.CommandLine ?? '');
      const isChromaMcp = commandText.includes('chroma-mcp');

      // chroma-mcp orphan only when its immediate parent process is dead.
      // On Windows the spawn chain is `worker → cmd.exe → uvx → chroma-mcp`
      // so the parent is intentionally NOT the worker even on a healthy
      // chain — the dead-parent check below correctly leaves those alone.
      // We deliberately do NOT gate on `liveWorkerPid !== null`: when the
      // worker has crashed, `worker.pid` is gone and readLiveWorkerPid()
      // returns null, but that's exactly when chroma-mcp orphans need
      // reaping (#2195). The dead-parent guard alone is sufficient and
      // correct in both states.
      if (
        isChromaMcp &&
        pid !== currentPid &&
        (ppid <= 0 || !isProcessAlive(ppid))
      ) {
        pidsToKill.push(pid);
        logger.debug('SYSTEM', 'Found orphaned chroma-mcp (parent process is dead)', { pid, ppid, liveWorkerPid });
        continue;
      }

      // chroma-mcp is exempt from age-based reaping (healthy instances
      // naturally outlive any sensible threshold). The dead-parent guard
      // above is its only reap criterion.
      if (isChromaMcp) continue;

      // Parse Windows WMI date format: /Date(1234567890123)/
      const creationMatch = String(proc.CreationDate ?? '').match(/\/Date\((\d+)\)\//);
      if (creationMatch) {
        const creationTime = parseInt(creationMatch[1], 10);
        const ageMinutes = (now - creationTime) / (1000 * 60);
        const threshold = ageThresholdForCommand(commandText);

        if (ageMinutes >= threshold) {
          pidsToKill.push(pid);
          logger.debug('SYSTEM', 'Found orphaned process', { pid, ageMinutes: Math.round(ageMinutes), threshold });
        }
      }
    }
  } else {
    // Unix: ps -o pid,ppid,etime,command. PPID is critical for chroma-mcp because
    // re-parented orphans (ppid==1) are the dominant failure pattern (#2184).
    const patternRegex = ORPHAN_PROCESS_PATTERNS.join('|');
    const { stdout } = await execAsync(
      `ps -eo pid,ppid,etime,command | grep -E "${patternRegex}" | grep -v grep || true`
    );

    if (!stdout.trim()) {
      logger.debug('SYSTEM', 'No orphaned claude-mem processes found (Unix)');
      return [];
    }

    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      // Parse: "  1234   5678   01:23:45 /path/to/process arg arg"
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const etime = match[3];
      const commandText = match[4];

      // SECURITY: Validate PID is positive integer and not current process
      if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;

      const isChromaMcp = commandText.includes('chroma-mcp');

      // Re-parented orphan (Unix ppid==1) is unconditional for chroma-mcp.
      // The python child has lost its worker and will sit forever otherwise.
      if (isChromaMcp && ppid === 1) {
        pidsToKill.push(pid);
        logger.debug('SYSTEM', 'Found re-parented orphan chroma-mcp (ppid==1)', { pid });
        continue;
      }

      // chroma-mcp is exempt from age-based reaping (healthy instances
      // naturally outlive any sensible threshold). ppid==1 above is its
      // only reap criterion.
      if (isChromaMcp) continue;

      const ageMinutes = parseElapsedTime(etime);
      const threshold = ageThresholdForCommand(commandText);
      if (ageMinutes >= threshold) {
        pidsToKill.push(pid);
        logger.debug('SYSTEM', 'Found orphaned process', { pid, ppid, ageMinutes, threshold, command: commandText.substring(0, 80) });
      }
    }
  }

  return pidsToKill;
}

/**
 * Clean up orphaned claude-mem processes from previous worker sessions.
 *
 * Targets mcp-server.cjs, worker-service.cjs, and chroma-mcp processes
 * that survived a previous daemon crash or SIGKILL. Reap criteria differ
 * by pattern:
 *
 * - chroma-mcp is reaped only when clearly orphaned: Unix ppid==1
 *   (re-parented to init), Windows immediate parent unreachable. Healthy
 *   chroma-mcp can run for hours during a long Claude session, so the
 *   age-threshold path is intentionally skipped for this pattern.
 * - Other patterns (mcp-server.cjs, worker-service.cjs) are reaped via
 *   the default 30-minute age threshold.
 *
 * Run once at worker bootstrap and on every ORPHAN_REAPER_INTERVAL_MS tick
 * (see startOrphanReaperInterval()). PR #1175 documented a periodic reaper
 * but the interval wiring was missing — issues #2184 and #2195 trace orphan
 * accumulation directly to that gap.
 */
export async function cleanupOrphanedProcesses(): Promise<void> {
  const isWindows = process.platform === 'win32';
  const currentPid = process.pid;
  let pidsToKill: number[];

  try {
    pidsToKill = await enumerateOrphanedProcesses(isWindows, currentPid);
  } catch (error: unknown) {
    // Orphan cleanup is non-critical - log and continue
    if (error instanceof Error) {
      logger.error('SYSTEM', 'Failed to enumerate orphaned processes', {}, error);
    } else {
      logger.error('SYSTEM', 'Failed to enumerate orphaned processes', {}, new Error(String(error)));
    }
    return;
  }

  if (pidsToKill.length === 0) {
    return;
  }

  logger.info('SYSTEM', 'Cleaning up orphaned claude-mem processes', {
    platform: isWindows ? 'Windows' : 'Unix',
    count: pidsToKill.length,
    pids: pidsToKill,
    maxAgeMinutes: ORPHAN_MAX_AGE_MINUTES
  });

  // Kill all found processes
  if (isWindows) {
    for (const pid of pidsToKill) {
      // SECURITY: Double-check PID validation before using in taskkill command
      if (!Number.isInteger(pid) || pid <= 0) {
        logger.warn('SYSTEM', 'Skipping invalid PID', { pid });
        continue;
      }
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, stdio: 'ignore', windowsHide: true });
      } catch (error: unknown) {
        // [ANTI-PATTERN IGNORED]: Cleanup loop - process may have exited, continue to next PID
        if (error instanceof Error) {
          logger.debug('SYSTEM', 'Failed to kill process, may have already exited', { pid }, error);
        } else {
          logger.debug('SYSTEM', 'Failed to kill process, may have already exited', { pid }, new Error(String(error)));
        }
      }
    }
  } else {
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error: unknown) {
        // [ANTI-PATTERN IGNORED]: Cleanup loop - process may have exited, continue to next PID
        if (error instanceof Error) {
          logger.debug('SYSTEM', 'Process already exited', { pid }, error);
        } else {
          logger.debug('SYSTEM', 'Process already exited', { pid }, new Error(String(error)));
        }
      }
    }
  }

  logger.info('SYSTEM', 'Orphaned processes cleaned up', { count: pidsToKill.length });
}

/**
 * Start the periodic orphan reaper. Idempotent — calling twice does not
 * stack timers. The first run fires immediately so startup-orphans (from a
 * previous crashed worker) are reaped before any new chroma-mcp is spawned.
 */
export function startOrphanReaperInterval(): void {
  if (orphanReaperTimer) return;

  void cleanupOrphanedProcesses().catch(error => {
    if (error instanceof Error) {
      logger.error('SYSTEM', 'Initial orphan reap failed', {}, error);
    }
  });

  orphanReaperTimer = setInterval(() => {
    void cleanupOrphanedProcesses().catch(error => {
      if (error instanceof Error) {
        logger.error('SYSTEM', 'Periodic orphan reap failed', {}, error);
      }
    });
  }, ORPHAN_REAPER_INTERVAL_MS);
  // Don't keep the worker process alive solely on the reaper timer.
  if (typeof orphanReaperTimer.unref === 'function') {
    orphanReaperTimer.unref();
  }
  logger.info('SYSTEM', 'Orphan reaper started', { intervalMs: ORPHAN_REAPER_INTERVAL_MS });
}

/** Stop the periodic orphan reaper. Safe to call when not running. */
export function stopOrphanReaperInterval(): void {
  if (orphanReaperTimer) {
    clearInterval(orphanReaperTimer);
    orphanReaperTimer = null;
    logger.info('SYSTEM', 'Orphan reaper stopped');
  }
}

const CHROMA_MIGRATION_MARKER_FILENAME = '.chroma-cleaned-v10.3';

/**
 * One-time chroma data wipe for users upgrading from versions with duplicate
 * worker bugs that could corrupt chroma data. Since chroma is always rebuildable
 * from SQLite (via backfillAllProjects), this is safe.
 *
 * Checks for a marker file. If absent, wipes ~/.claude-mem/chroma/ and writes
 * the marker. If present, skips. Idempotent.
 *
 * @param dataDirectory - Override for DATA_DIR (used in tests)
 */
export function runOneTimeChromaMigration(dataDirectory?: string): void {
  const effectiveDataDir = dataDirectory ?? DATA_DIR;
  const markerPath = path.join(effectiveDataDir, CHROMA_MIGRATION_MARKER_FILENAME);
  const chromaDir = path.join(effectiveDataDir, 'chroma');

  if (existsSync(markerPath)) {
    logger.debug('SYSTEM', 'Chroma migration marker exists, skipping wipe');
    return;
  }

  logger.warn('SYSTEM', 'Running one-time chroma data wipe (upgrade from pre-v10.3)', { chromaDir });

  if (existsSync(chromaDir)) {
    rmSync(chromaDir, { recursive: true, force: true });
    logger.info('SYSTEM', 'Chroma data directory removed', { chromaDir });
  }

  // Write marker file to prevent future wipes
  mkdirSync(effectiveDataDir, { recursive: true });
  writeFileSync(markerPath, new Date().toISOString());
  logger.info('SYSTEM', 'Chroma migration marker written', { markerPath });
}

const CWD_REMAP_MARKER_FILENAME = '.cwd-remap-applied-v1';

type CwdClassification =
  | { kind: 'main'; project: string }
  | { kind: 'worktree'; project: string }
  | { kind: 'skip' };

function gitQuery(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 5000
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? '').trim();
}

function classifyCwdForRemap(cwd: string): CwdClassification {
  if (!existsSync(cwd)) return { kind: 'skip' };

  const gitDir = gitQuery(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return { kind: 'skip' };

  const commonDir = gitQuery(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return { kind: 'skip' };

  const toplevel = gitQuery(cwd, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return { kind: 'skip' };
  const leaf = path.basename(toplevel);

  if (gitDir === commonDir) {
    return { kind: 'main', project: leaf };
  }

  const parentRepoDir = commonDir.endsWith('/.git')
    ? path.dirname(commonDir)
    : commonDir.replace(/\.git$/, '');
  const parent = path.basename(parentRepoDir);
  return { kind: 'worktree', project: `${parent}/${leaf}` };
}

/**
 * One-time remap of sdk_sessions.project (+ observations.project,
 * session_summaries.project) using the cwd captured in pending_messages.cwd
 * as the source of truth. Required because pre-worktree builds stored bare
 * project names that collide across parent/worktree checkouts.
 *
 * Backs up the DB before writes. Idempotent via marker file. Skips silently
 * if the DB or pending_messages table doesn't exist yet (fresh install).
 *
 * @param dataDirectory - Override for DATA_DIR (used in tests)
 */
export function runOneTimeCwdRemap(dataDirectory?: string): void {
  const effectiveDataDir = dataDirectory ?? DATA_DIR;
  const markerPath = path.join(effectiveDataDir, CWD_REMAP_MARKER_FILENAME);
  const dbPath = path.join(effectiveDataDir, 'claude-mem.db');

  if (existsSync(markerPath)) {
    logger.debug('SYSTEM', 'cwd-remap marker exists, skipping');
    return;
  }

  if (!existsSync(dbPath)) {
    mkdirSync(effectiveDataDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString());
    logger.debug('SYSTEM', 'No DB present, cwd-remap marker written without work', { dbPath });
    return;
  }

  logger.warn('SYSTEM', 'Running one-time cwd-based project remap', { dbPath });

  try {
    executeCwdRemap(dbPath, effectiveDataDir, markerPath);
  } catch (err: unknown) {
    if (err instanceof Error) {
      logger.error('SYSTEM', 'cwd-remap failed, marker not written (will retry on next startup)', {}, err);
    } else {
      logger.error('SYSTEM', 'cwd-remap failed, marker not written (will retry on next startup)', {}, new Error(String(err)));
    }
  }
}

/**
 * Execute the cwd-remap DB migration. Extracted to keep the try block small.
 * Opens, queries, and updates the DB, then writes the marker file on success.
 */
function executeCwdRemap(dbPath: string, effectiveDataDir: string, markerPath: string): void {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');

  const probe = new Database(dbPath, { readonly: true });
  const hasPending = probe.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
  ).get() as { name: string } | undefined;
  probe.close();

  if (!hasPending) {
    mkdirSync(effectiveDataDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString());
    logger.info('SYSTEM', 'pending_messages table not present, cwd-remap skipped');
    return;
  }

  const backup = `${dbPath}.bak-cwd-remap-${Date.now()}`;
  copyFileSync(dbPath, backup);
  logger.info('SYSTEM', 'DB backed up before cwd-remap', { backup });

  const db = new Database(dbPath);
  try {
    const cwdRows = db.prepare(`
      SELECT cwd FROM pending_messages
      WHERE cwd IS NOT NULL AND cwd != ''
      GROUP BY cwd
    `).all() as Array<{ cwd: string }>;

    const byCwd = new Map<string, CwdClassification>();
    for (const { cwd } of cwdRows) byCwd.set(cwd, classifyCwdForRemap(cwd));

    const sessionRows = db.prepare(`
      SELECT s.id AS session_id, s.memory_session_id, s.project AS old_project, p.cwd
      FROM sdk_sessions s
      JOIN pending_messages p ON p.content_session_id = s.content_session_id
      WHERE p.cwd IS NOT NULL AND p.cwd != ''
        AND p.id = (
          SELECT MIN(p2.id) FROM pending_messages p2
          WHERE p2.content_session_id = s.content_session_id
            AND p2.cwd IS NOT NULL AND p2.cwd != ''
        )
    `).all() as Array<{ session_id: number; memory_session_id: string | null; old_project: string; cwd: string }>;

    type Target = { sessionId: number; memorySessionId: string | null; newProject: string };
    const targets: Target[] = [];
    for (const r of sessionRows) {
      const c = byCwd.get(r.cwd);
      if (!c || c.kind === 'skip') continue;
      if (r.old_project === c.project) continue;
      targets.push({ sessionId: r.session_id, memorySessionId: r.memory_session_id, newProject: c.project });
    }

    if (targets.length === 0) {
      logger.info('SYSTEM', 'cwd-remap: no sessions need updating');
    } else {
      const updSession = db.prepare('UPDATE sdk_sessions      SET project = ? WHERE id = ?');
      const updObs     = db.prepare('UPDATE observations      SET project = ? WHERE memory_session_id = ?');
      const updSum     = db.prepare('UPDATE session_summaries SET project = ? WHERE memory_session_id = ?');

      let sessionN = 0, obsN = 0, sumN = 0;
      const tx = db.transaction(() => {
        for (const t of targets) {
          sessionN += updSession.run(t.newProject, t.sessionId).changes;
          if (t.memorySessionId) {
            obsN += updObs.run(t.newProject, t.memorySessionId).changes;
            sumN += updSum.run(t.newProject, t.memorySessionId).changes;
          }
        }
      });
      tx();

      logger.info('SYSTEM', 'cwd-remap applied', { sessions: sessionN, observations: obsN, summaries: sumN, backup });
    }

    mkdirSync(effectiveDataDir, { recursive: true });
    writeFileSync(markerPath, new Date().toISOString());
    logger.info('SYSTEM', 'cwd-remap marker written', { markerPath });
  } finally {
    db.close();
  }
}

/**
 * Spawn a detached daemon process.
 *
 * Uses Node's child_process.spawn with the arg-array form on every platform.
 * The arg-array form bypasses the shell entirely on Windows, so no quoting
 * heuristics or PowerShell wrappers are needed (handles paths with spaces
 * like `C:\Users\Alex Newman\...` natively).
 *
 * On Unix, prefer setsid to detach from the controlling terminal so SIGHUP
 * can't reach the daemon even if the in-process handler fails. The
 * `detached: true` option already creates a new process group on POSIX;
 * setsid is the belt-and-suspenders extra.
 *
 * Bun.spawn is intentionally NOT used here: it does not support detached
 * spawning (see comment in process-registry.ts:633-639).
 *
 * PID file is written by the worker itself after listen() succeeds,
 * not by the spawner (race-free, works on all platforms).
 */
export function spawnDaemon(
  scriptPath: string,
  port: number,
  extraEnv: Record<string, string> = {}
): number | undefined {
  getSupervisor().assertCanSpawn('worker daemon');

  const env = sanitizeEnv({
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
    ...extraEnv
  });

  // worker-service.cjs imports `bun:sqlite`, so the spawned runtime MUST be
  // Bun on every platform — never the current process.execPath, which may be
  // Node when the caller is the MCP server.
  const runtimePath = resolveWorkerRuntimePath();
  if (!runtimePath) {
    logger.error(
      'SYSTEM',
      'Bun runtime not found — install from https://bun.sh and ensure it is on PATH or set BUN env var. The worker daemon requires Bun because it uses bun:sqlite.'
    );
    return undefined;
  }

  // On Unix, prefer setsid to fully detach from the controlling terminal.
  // On Windows or systems without setsid, spawn the runtime directly.
  const setsidPath = '/usr/bin/setsid';
  const useSetsid = process.platform !== 'win32' && existsSync(setsidPath);

  const execPath = useSetsid ? setsidPath : runtimePath;
  const args = useSetsid
    ? [runtimePath, scriptPath, '--daemon']
    : [scriptPath, '--daemon'];

  const child = spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  });

  if (child.pid === undefined) {
    return undefined;
  }

  child.unref();
  return child.pid;
}

/**
 * Check if a process with the given PID is alive.
 *
 * Uses the process.kill(pid, 0) idiom: signal 0 doesn't send a signal,
 * it just checks if the process exists and is reachable.
 *
 * EPERM is treated as "alive" because it means the process exists but
 * belongs to a different user/session (common in multi-user setups).
 * PID 0 (Windows sentinel for unknown PID) is treated as alive.
 */
export function isProcessAlive(pid: number): boolean {
  // PID 0 is the Windows sentinel value — process was spawned but PID unknown
  if (pid === 0) return true;

  // Invalid PIDs are not alive
  if (!Number.isInteger(pid) || pid < 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM = process exists but different user/session — treat as alive
      if (code === 'EPERM') return true;
      logger.debug('SYSTEM', 'Process not alive', { pid, code });
    } else {
      logger.debug('SYSTEM', 'Process not alive (non-Error thrown)', { pid }, new Error(String(error)));
    }
    // ESRCH = no such process — it's dead
    return false;
  }
}

/**
 * Check if the PID file was written recently (within thresholdMs).
 *
 * Used to coordinate restarts across concurrent sessions: if the PID file
 * was recently written, another session likely just restarted the worker.
 * Callers should poll /api/health instead of attempting their own restart.
 *
 * @param thresholdMs - Maximum age in ms to consider "recent" (default: 15000)
 * @returns true if the PID file exists and was modified within thresholdMs
 */
export function isPidFileRecent(thresholdMs: number = 15000): boolean {
  try {
    const stats = statSync(PID_FILE);
    return (Date.now() - stats.mtimeMs) < thresholdMs;
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'PID file not accessible for recency check', { path: PID_FILE }, error);
    } else {
      logger.debug('SYSTEM', 'PID file not accessible for recency check', { path: PID_FILE }, new Error(String(error)));
    }
    return false;
  }
}

/**
 * Touch the PID file to update its mtime without changing contents.
 * Used after a restart to signal other sessions that a restart just completed.
 */
export function touchPidFile(): void {
  try {
    if (!existsSync(PID_FILE)) return;
    const now = new Date();
    utimesSync(PID_FILE, now, now);
  } catch {
    // Best-effort — failure to touch doesn't affect correctness
  }
}

/**
 * Read the PID file and remove it if the recorded process is dead (stale).
 *
 * This is a cheap operation: one filesystem read + one signal-0 check.
 * Called at the top of ensureWorkerStarted() to clean up after WSL2
 * hibernate, OOM kills, or other ungraceful worker deaths.
 */
export function cleanStalePidFile(): ValidateWorkerPidStatus {
  return validateWorkerPidFile({ logAlive: false });
}

/**
 * Create signal handler factory for graceful shutdown
 * Returns a handler function that can be passed to process.on('SIGTERM') etc.
 */
export function createSignalHandler(
  shutdownFn: () => Promise<void>,
  isShuttingDownRef: { value: boolean }
): (signal: string) => Promise<void> {
  return async (signal: string) => {
    if (isShuttingDownRef.value) {
      logger.warn('SYSTEM', `Received ${signal} but shutdown already in progress`);
      return;
    }
    isShuttingDownRef.value = true;

    logger.info('SYSTEM', `Received ${signal}, shutting down...`);
    try {
      await shutdownFn();
      process.exit(0);
    } catch (error: unknown) {
      // Top-level signal handler - log any shutdown error and exit
      if (error instanceof Error) {
        logger.error('SYSTEM', 'Error during shutdown', {}, error);
      } else {
        logger.error('SYSTEM', 'Error during shutdown', {}, new Error(String(error)));
      }
      // Exit gracefully: Windows Terminal won't keep tab open on exit 0
      // Even on shutdown errors, exit cleanly to prevent tab accumulation
      process.exit(0);
    }
  };
}
