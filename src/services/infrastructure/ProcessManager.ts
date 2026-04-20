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

// Only kill processes older than this to avoid killing the current session
const ORPHAN_MAX_AGE_MINUTES = 30;

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

export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * Write PID info to the standard PID file location
 */
export function writePidFile(info: PidInfo): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
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

/**
 * Enumerate orphaned claude-mem processes matching ORPHAN_PROCESS_PATTERNS.
 * Returns PIDs of processes older than ORPHAN_MAX_AGE_MINUTES.
 */
async function enumerateOrphanedProcesses(isWindows: boolean, currentPid: number): Promise<number[]> {
  const pidsToKill: number[] = [];

  if (isWindows) {
    // Windows: Use WQL -Filter for server-side filtering (no $_ pipeline syntax).
    // Avoids Git Bash $_ interpretation (#1062) and PowerShell syntax errors (#1024).
    const wqlPatternConditions = ORPHAN_PROCESS_PATTERNS
      .map(p => `CommandLine LIKE '%${p}%'`)
      .join(' OR ');

    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter '(${wqlPatternConditions}) AND ProcessId != ${currentPid}' | Select-Object ProcessId, CreationDate | ConvertTo-Json"`;
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

      // Parse Windows WMI date format: /Date(1234567890123)/
      const creationMatch = proc.CreationDate?.match(/\/Date\((\d+)\)\//);
      if (creationMatch) {
        const creationTime = parseInt(creationMatch[1], 10);
        const ageMinutes = (now - creationTime) / (1000 * 60);

        if (ageMinutes >= ORPHAN_MAX_AGE_MINUTES) {
          pidsToKill.push(pid);
          logger.debug('SYSTEM', 'Found orphaned process', { pid, ageMinutes: Math.round(ageMinutes) });
        }
      }
    }
  } else {
    // Unix: Use ps with elapsed time for age-based filtering
    const patternRegex = ORPHAN_PROCESS_PATTERNS.join('|');
    const { stdout } = await execAsync(
      `ps -eo pid,etime,command | grep -E "${patternRegex}" | grep -v grep || true`
    );

    if (!stdout.trim()) {
      logger.debug('SYSTEM', 'No orphaned claude-mem processes found (Unix)');
      return [];
    }

    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      // Parse: "  1234  01:23:45 /path/to/process"
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const etime = match[2];

      // SECURITY: Validate PID is positive integer and not current process
      if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;

      const ageMinutes = parseElapsedTime(etime);
      if (ageMinutes >= ORPHAN_MAX_AGE_MINUTES) {
        pidsToKill.push(pid);
        logger.debug('SYSTEM', 'Found orphaned process', { pid, ageMinutes, command: match[3].substring(0, 80) });
      }
    }
  }

  return pidsToKill;
}

/**
 * Clean up orphaned claude-mem processes from previous worker sessions
 *
 * Targets mcp-server.cjs, worker-service.cjs, and chroma-mcp processes
 * that survived a previous daemon crash. Only kills processes older than
 * ORPHAN_MAX_AGE_MINUTES to avoid killing the current session.
 *
 * The periodic ProcessRegistry reaper handles in-session orphans;
 * this function handles cross-session orphans at startup.
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

// Patterns that should be killed immediately at startup (no age gate)
// These are child processes that should not outlive their parent worker
const AGGRESSIVE_CLEANUP_PATTERNS = ['worker-service.cjs', 'chroma-mcp'];

// Patterns that keep the age-gated threshold (may be legitimately running)
const AGE_GATED_CLEANUP_PATTERNS = ['mcp-server.cjs'];

/**
 * Enumerate processes for aggressive startup cleanup. Aggressive patterns are
 * killed immediately; age-gated patterns only if older than ORPHAN_MAX_AGE_MINUTES.
 */
async function enumerateAggressiveCleanupProcesses(
  isWindows: boolean,
  currentPid: number,
  protectedPids: Set<number>,
  allPatterns: string[]
): Promise<number[]> {
  const pidsToKill: number[] = [];

  if (isWindows) {
    // Use WQL -Filter for server-side filtering (no $_ pipeline syntax).
    // Avoids Git Bash $_ interpretation (#1062) and PowerShell syntax errors (#1024).
    const wqlPatternConditions = allPatterns
      .map(p => `CommandLine LIKE '%${p}%'`)
      .join(' OR ');

    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter '(${wqlPatternConditions}) AND ProcessId != ${currentPid}' | Select-Object ProcessId, CommandLine, CreationDate | ConvertTo-Json"`;
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
      if (!Number.isInteger(pid) || pid <= 0 || protectedPids.has(pid)) continue;

      const commandLine = proc.CommandLine || '';
      const isAggressive = AGGRESSIVE_CLEANUP_PATTERNS.some(p => commandLine.includes(p));

      if (isAggressive) {
        // Kill immediately — no age check
        pidsToKill.push(pid);
        logger.debug('SYSTEM', 'Found orphaned process (aggressive)', { pid, commandLine: commandLine.substring(0, 80) });
      } else {
        // Age-gated: only kill if older than threshold
        const creationMatch = proc.CreationDate?.match(/\/Date\((\d+)\)\//);
        if (creationMatch) {
          const creationTime = parseInt(creationMatch[1], 10);
          const ageMinutes = (now - creationTime) / (1000 * 60);
          if (ageMinutes >= ORPHAN_MAX_AGE_MINUTES) {
            pidsToKill.push(pid);
            logger.debug('SYSTEM', 'Found orphaned process (age-gated)', { pid, ageMinutes: Math.round(ageMinutes) });
          }
        }
      }
    }
  } else {
    // Unix: Use ps with elapsed time
    const patternRegex = allPatterns.join('|');
    const { stdout } = await execAsync(
      `ps -eo pid,etime,command | grep -E "${patternRegex}" | grep -v grep || true`
    );

    if (!stdout.trim()) {
      logger.debug('SYSTEM', 'No orphaned claude-mem processes found (Unix)');
      return [];
    }

    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const etime = match[2];
      const command = match[3];

      if (!Number.isInteger(pid) || pid <= 0 || protectedPids.has(pid)) continue;

      const isAggressive = AGGRESSIVE_CLEANUP_PATTERNS.some(p => command.includes(p));

      if (isAggressive) {
        // Kill immediately — no age check
        pidsToKill.push(pid);
        logger.debug('SYSTEM', 'Found orphaned process (aggressive)', { pid, command: command.substring(0, 80) });
      } else {
        // Age-gated: only kill if older than threshold
        const ageMinutes = parseElapsedTime(etime);
        if (ageMinutes >= ORPHAN_MAX_AGE_MINUTES) {
          pidsToKill.push(pid);
          logger.debug('SYSTEM', 'Found orphaned process (age-gated)', { pid, ageMinutes, command: command.substring(0, 80) });
        }
      }
    }
  }

  return pidsToKill;
}

/**
 * Aggressive startup cleanup for orphaned claude-mem processes.
 *
 * Unlike cleanupOrphanedProcesses() which age-gates everything at 30 minutes,
 * this function kills worker-service.cjs and chroma-mcp processes immediately
 * (they should not outlive their parent worker). Only mcp-server.cjs keeps
 * the age threshold since it may be legitimately running.
 *
 * Called once at daemon startup.
 */
export async function aggressiveStartupCleanup(): Promise<void> {
  const isWindows = process.platform === 'win32';
  const currentPid = process.pid;
  const allPatterns = [...AGGRESSIVE_CLEANUP_PATTERNS, ...AGE_GATED_CLEANUP_PATTERNS];

  // Protect parent process (the hook that spawned us) from being killed.
  // Without this, a new daemon kills its own parent hook process (#1426).
  //
  // Note: readPidFile() is not used here because start() writes the new PID
  // before initializeBackground() calls this function, so readPidFile() would
  // just return process.pid (already protected). If a pre-existing worker needs
  // protection, ensureWorkerStarted() handles that by returning early when a
  // healthy worker is detected — we never reach this code in that case.
  const protectedPids = new Set<number>([currentPid]);
  if (process.ppid && process.ppid > 0) {
    protectedPids.add(process.ppid);
  }

  let pidsToKill: number[];
  try {
    pidsToKill = await enumerateAggressiveCleanupProcesses(isWindows, currentPid, protectedPids, allPatterns);
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error('SYSTEM', 'Failed to enumerate orphaned processes during aggressive cleanup', {}, error);
    } else {
      logger.error('SYSTEM', 'Failed to enumerate orphaned processes during aggressive cleanup', {}, new Error(String(error)));
    }
    return;
  }

  if (pidsToKill.length === 0) {
    return;
  }

  logger.info('SYSTEM', 'Aggressive startup cleanup: killing orphaned processes', {
    platform: isWindows ? 'Windows' : 'Unix',
    count: pidsToKill.length,
    pids: pidsToKill
  });

  if (isWindows) {
    for (const pid of pidsToKill) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, stdio: 'ignore', windowsHide: true });
      } catch (error: unknown) {
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
        if (error instanceof Error) {
          logger.debug('SYSTEM', 'Process already exited', { pid }, error);
        } else {
          logger.debug('SYSTEM', 'Process already exited', { pid }, new Error(String(error)));
        }
      }
    }
  }

  logger.info('SYSTEM', 'Aggressive startup cleanup complete', { count: pidsToKill.length });
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
 * Spawn a detached daemon process
 * Returns the child PID or undefined if spawn failed
 *
 * On Windows, uses PowerShell Start-Process with -WindowStyle Hidden to spawn
 * a truly independent process without console popups. Unlike WMIC, PowerShell
 * inherits environment variables from the parent process.
 *
 * On Unix, uses standard detached spawn.
 *
 * PID file is written by the worker itself after listen() succeeds,
 * not by the spawner (race-free, works on all platforms).
 */
export function spawnDaemon(
  scriptPath: string,
  port: number,
  extraEnv: Record<string, string> = {}
): number | undefined {
  const isWindows = process.platform === 'win32';
  getSupervisor().assertCanSpawn('worker daemon');

  const env = sanitizeEnv({
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
    ...extraEnv
  });

  // worker-service.cjs imports `bun:sqlite`, so the spawned runtime MUST be
  // Bun on every platform — never the current process.execPath, which may be
  // Node when the caller is the MCP server. Resolve once before the OS branch
  // split so we don't pay for a duplicate PATH lookup if Bun isn't found at a
  // well-known path. See resolveWorkerRuntimePath() for the candidate list.
  const runtimePath = resolveWorkerRuntimePath();
  if (!runtimePath) {
    logger.error(
      'SYSTEM',
      'Bun runtime not found — install from https://bun.sh and ensure it is on PATH or set BUN env var. The worker daemon requires Bun because it uses bun:sqlite.'
    );
    return undefined;
  }

  if (isWindows) {
    // Use PowerShell Start-Process to spawn a hidden, independent process
    // Unlike WMIC, PowerShell inherits environment variables from parent
    // -WindowStyle Hidden prevents console popup

    // Use -EncodedCommand to avoid all shell quoting issues with spaces in paths
    const psScript = `Start-Process -FilePath '${runtimePath.replace(/'/g, "''")}' -ArgumentList @('${scriptPath.replace(/'/g, "''")}','--daemon') -WindowStyle Hidden`;
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

    try {
      execSync(`powershell -NoProfile -EncodedCommand ${encodedCommand}`, {
        stdio: 'ignore',
        windowsHide: true,
        env
      });
      // Windows success sentinel: PowerShell `Start-Process` does not return
      // the spawned PID, and we don't want to pay for an extra `Get-Process`
      // round-trip just to discover it. Return 0 (a conventionally invalid
      // Unix PID) so callers can distinguish "spawn dispatched" from "spawn
      // failed". Callers MUST use `pid === undefined` to detect failure —
      // never falsy checks like `if (!pid)`, which would silently treat
      // success as failure here.
      return 0;
    } catch (error: unknown) {
      // APPROVED OVERRIDE: Windows daemon spawn is best-effort; log and let callers fall back to health checks/retry flow.
      if (error instanceof Error) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon on Windows', { runtimePath }, error);
      } else {
        logger.error('SYSTEM', 'Failed to spawn worker daemon on Windows', { runtimePath }, new Error(String(error)));
      }
      return undefined;
    }
  }

  // Unix: Use setsid to create a new session, fully detaching from the
  // controlling terminal. This prevents SIGHUP from reaching the daemon
  // even if the in-process SIGHUP handler somehow fails (belt-and-suspenders).
  // Fall back to standard detached spawn if setsid is not available.
  // `runtimePath` was resolved at the top of this function (see comment there).
  const setsidPath = '/usr/bin/setsid';
  if (existsSync(setsidPath)) {
    const child = spawn(setsidPath, [runtimePath, scriptPath, '--daemon'], {
      detached: true,
      stdio: 'ignore',
      env
    });

    if (child.pid === undefined) {
      return undefined;
    }

    child.unref();
    return child.pid;
  }

  // Fallback: standard detached spawn (macOS, systems without setsid)
  const child = spawn(runtimePath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
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
