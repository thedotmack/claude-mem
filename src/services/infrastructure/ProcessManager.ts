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
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, rmSync, statSync, utimesSync } from 'fs';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';

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

  try {
    const output = execSync(command, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true
    });

    const firstMatch = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.length > 0);

    return firstMatch || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the runtime executable for spawning the worker daemon.
 *
 * Windows must prefer Bun because worker-service.cjs imports bun:sqlite,
 * which is unavailable in Node.js.
 */
export function resolveWorkerRuntimePath(options: RuntimeResolverOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;

  // Non-Windows currently relies on the runtime that launched worker-service.
  if (platform !== 'win32') {
    return execPath;
  }

  // If already running under Bun, reuse it directly.
  if (isBunExecutablePath(execPath)) {
    return execPath;
  }

  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const pathExists = options.pathExists ?? existsSync;
  const lookupInPath = options.lookupInPath ?? lookupBinaryInPath;

  const candidatePaths = [
    env.BUN,
    env.BUN_PATH,
    path.join(homeDirectory, '.bun', 'bin', 'bun.exe'),
    path.join(homeDirectory, '.bun', 'bin', 'bun'),
    env.USERPROFILE ? path.join(env.USERPROFILE, '.bun', 'bin', 'bun.exe') : undefined,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'bun', 'bun.exe') : undefined,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'bun', 'bin', 'bun.exe') : undefined,
  ];

  for (const candidate of candidatePaths) {
    const normalized = candidate?.trim();
    if (!normalized) continue;

    if (isBunExecutablePath(normalized) && pathExists(normalized)) {
      return normalized;
    }

    // Allow command-style values from env (e.g. BUN=bun)
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
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to parse PID file', { path: PID_FILE }, error as Error);
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
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Cleanup function - PID file removal failure is non-critical
    logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE }, error as Error);
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
  } catch (error) {
    // Shutdown cleanup - failure is non-critical, continue without child process cleanup
    logger.error('SYSTEM', 'Failed to enumerate child processes', { parentPid }, error as Error);
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
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Shutdown cleanup - process already exited, continue
    logger.debug('SYSTEM', 'Process already exited during force kill', { pid }, error as Error);
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
      } catch (error) {
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
  const pidsToKill: number[] = [];

  try {
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
        return;
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
        return;
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
  } catch (error) {
    // Orphan cleanup is non-critical - log and continue
    logger.error('SYSTEM', 'Failed to enumerate orphaned processes', {}, error as Error);
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
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Cleanup loop - process may have exited, continue to next PID
        logger.debug('SYSTEM', 'Failed to kill process, may have already exited', { pid }, error as Error);
      }
    }
  } else {
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Cleanup loop - process may have exited, continue to next PID
        logger.debug('SYSTEM', 'Process already exited', { pid }, error as Error);
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
  const pidsToKill: number[] = [];
  const allPatterns = [...AGGRESSIVE_CLEANUP_PATTERNS, ...AGE_GATED_CLEANUP_PATTERNS];

  try {
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
        return;
      }

      const processes = JSON.parse(stdout);
      const processList = Array.isArray(processes) ? processes : [processes];
      const now = Date.now();

      for (const proc of processList) {
        const pid = proc.ProcessId;
        if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;

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
        return;
      }

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) continue;

        const pid = parseInt(match[1], 10);
        const etime = match[2];
        const command = match[3];

        if (!Number.isInteger(pid) || pid <= 0 || pid === currentPid) continue;

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
  } catch (error) {
    logger.error('SYSTEM', 'Failed to enumerate orphaned processes during aggressive cleanup', {}, error as Error);
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
      } catch (error) {
        logger.debug('SYSTEM', 'Failed to kill process, may have already exited', { pid }, error as Error);
      }
    }
  } else {
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        logger.debug('SYSTEM', 'Process already exited', { pid }, error as Error);
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
  const env = {
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
    ...extraEnv
  };

  if (isWindows) {
    // Use PowerShell Start-Process to spawn a hidden, independent process
    // Unlike WMIC, PowerShell inherits environment variables from parent
    // -WindowStyle Hidden prevents console popup
    const runtimePath = resolveWorkerRuntimePath();

    if (!runtimePath) {
      logger.error('SYSTEM', 'Failed to locate Bun runtime for Windows worker spawn');
      return undefined;
    }

    const escapedRuntimePath = runtimePath.replace(/'/g, "''");
    const escapedScriptPath = scriptPath.replace(/'/g, "''");
    const psCommand = `Start-Process -FilePath '${escapedRuntimePath}' -ArgumentList '${escapedScriptPath}','--daemon' -WindowStyle Hidden`;

    try {
      execSync(`powershell -NoProfile -Command "${psCommand}"`, {
        stdio: 'ignore',
        windowsHide: true,
        env
      });
      return 0;
    } catch (error) {
      logger.error('SYSTEM', 'Failed to spawn worker daemon on Windows', { runtimePath }, error as Error);
      return undefined;
    }
  }

  // Unix: Use setsid to create a new session, fully detaching from the
  // controlling terminal. This prevents SIGHUP from reaching the daemon
  // even if the in-process SIGHUP handler somehow fails (belt-and-suspenders).
  // Fall back to standard detached spawn if setsid is not available.
  const setsidPath = '/usr/bin/setsid';
  if (existsSync(setsidPath)) {
    const child = spawn(setsidPath, [process.execPath, scriptPath, '--daemon'], {
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
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
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
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM = process exists but different user/session — treat as alive
    if (code === 'EPERM') return true;
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
  } catch {
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
export function cleanStalePidFile(): void {
  const pidInfo = readPidFile();
  if (!pidInfo) return;

  if (!isProcessAlive(pidInfo.pid)) {
    logger.info('SYSTEM', 'Removing stale PID file (worker process is dead)', {
      pid: pidInfo.pid,
      port: pidInfo.port,
      startedAt: pidInfo.startedAt
    });
    removePidFile();
  }
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
    } catch (error) {
      // Top-level signal handler - log any shutdown error and exit
      logger.error('SYSTEM', 'Error during shutdown', {}, error as Error);
      // Exit gracefully: Windows Terminal won't keep tab open on exit 0
      // Even on shutdown errors, exit cleanly to prevent tab accumulation
      process.exit(0);
    }
  };
}
