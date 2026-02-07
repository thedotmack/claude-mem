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
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
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
 * Get platform-adjusted timeout (Windows socket cleanup is slower)
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
    // PowerShell Get-Process instead of WMIC (deprecated in Windows 11)
    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty Id"`;
    const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
    // PowerShell outputs just numbers (one per line), simpler than WMIC's "ProcessId=1234" format
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
      await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
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
      // Windows: Use PowerShell Get-CimInstance with JSON output for age filtering
      const patternConditions = ORPHAN_PROCESS_PATTERNS
        .map(p => `$_.CommandLine -like '*${p}*'`)
        .join(' -or ');

      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { (${patternConditions}) -and $_.ProcessId -ne ${currentPid} } | Select-Object ProcessId, CreationDate | ConvertTo-Json"`;
      const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });

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
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, stdio: 'ignore' });
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
    const execPath = process.execPath;
    const script = scriptPath;
    const psCommand = `Start-Process -FilePath '${execPath}' -ArgumentList '${script}','--daemon' -WindowStyle Hidden`;

    try {
      execSync(`powershell -NoProfile -Command "${psCommand}"`, {
        stdio: 'ignore',
        windowsHide: true,
        env
      });
      return 0;
    } catch {
      return undefined;
    }
  }

  // Unix: standard detached spawn
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
