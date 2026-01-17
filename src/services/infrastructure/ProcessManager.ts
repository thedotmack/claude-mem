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
    const cmd = `powershell -NoProfile -NonInteractive -Command "Get-Process | Where-Object { \\$_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty Id"`;
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
 * Clean up orphaned chroma-mcp processes from previous worker sessions
 * Prevents process accumulation and memory leaks
 */
export async function cleanupOrphanedProcesses(): Promise<void> {
  const isWindows = process.platform === 'win32';
  const pids: number[] = [];

  try {
    if (isWindows) {
      // Windows: Use PowerShell Get-CimInstance instead of WMIC (deprecated in Windows 11)
      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { \\$_.Name -like '*python*' -and \\$_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
      const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found (Windows)');
        return;
      }

      // PowerShell outputs just numbers (one per line), simpler than WMIC's "ProcessId=1234" format
      const lines = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^\d+$/.test(line));

      for (const line of lines) {
        const pid = parseInt(line, 10);
        // SECURITY: Validate PID is positive integer before adding to list
        if (!isNaN(pid) && Number.isInteger(pid) && pid > 0) {
          pids.push(pid);
        }
      }
    } else {
      // Unix: Use ps aux | grep
      const { stdout } = await execAsync('ps aux | grep "chroma-mcp" | grep -v grep || true');

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found (Unix)');
        return;
      }

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 1) {
          const pid = parseInt(parts[1], 10);
          // SECURITY: Validate PID is positive integer before adding to list
          if (!isNaN(pid) && Number.isInteger(pid) && pid > 0) {
            pids.push(pid);
          }
        }
      }
    }
  } catch (error) {
    // Orphan cleanup is non-critical - log and continue
    logger.error('SYSTEM', 'Failed to enumerate orphaned processes', {}, error as Error);
    return;
  }

  if (pids.length === 0) {
    return;
  }

  logger.info('SYSTEM', 'Cleaning up orphaned chroma-mcp processes', {
    platform: isWindows ? 'Windows' : 'Unix',
    count: pids.length,
    pids
  });

  // Kill all found processes
  if (isWindows) {
    for (const pid of pids) {
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
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Cleanup loop - process may have exited, continue to next PID
        logger.debug('SYSTEM', 'Process already exited', { pid }, error as Error);
      }
    }
  }

  logger.info('SYSTEM', 'Orphaned processes cleaned up', { count: pids.length });
}

/**
 * Spawn a detached daemon process
 * Returns the child PID or undefined if spawn failed
 */
export function spawnDaemon(
  scriptPath: string,
  port: number,
  extraEnv: Record<string, string> = {}
): number | undefined {
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_MEM_WORKER_PORT: String(port),
      ...extraEnv
    }
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

/**
 * Clean up orphaned Claude subprocess zombies
 *
 * The Agent SDK spawns Claude subprocesses internally without exposing PIDs.
 * When queries hang or abort, these subprocesses become zombies because
 * abortController.abort() only signals the async iterator, not the subprocess.
 *
 * This function finds and kills Claude subprocesses matching the claude-mem
 * spawning pattern that have been running longer than maxAgeMinutes.
 *
 * @param maxAgeMinutes - Only kill processes older than this (default: 30 minutes)
 * @returns Number of processes killed
 *
 * @see https://github.com/thedotmack/claude-mem/issues/737
 */
export async function cleanupOrphanedClaudeSubprocesses(maxAgeMinutes: number = 30): Promise<number> {
  const isWindows = process.platform === 'win32';
  let killed = 0;

  try {
    if (isWindows) {
      // Windows: Use PowerShell to find Claude processes spawned by claude-mem
      // Pattern: claude.exe processes with haiku model (most common zombie)
      const cmd = `powershell -NoProfile -NonInteractive -Command "
        Get-CimInstance Win32_Process |
        Where-Object {
          \\$_.CommandLine -like '*claude*' -and
          \\$_.CommandLine -like '*haiku*' -and
          \\$_.CreationDate -lt (Get-Date).AddMinutes(-${maxAgeMinutes})
        } |
        Select-Object ProcessId |
        ForEach-Object { \\$_.ProcessId }
      "`;

      const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned Claude subprocesses found (Windows)', { maxAgeMinutes });
        return 0;
      }

      const pids = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^\d+$/.test(line))
        .map(line => parseInt(line, 10))
        .filter(pid => !isNaN(pid) && Number.isInteger(pid) && pid > 0);

      logger.info('SYSTEM', 'Found orphaned Claude subprocesses', {
        count: pids.length,
        maxAgeMinutes,
        pids
      });

      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, stdio: 'ignore' });
          killed++;
          logger.info('SYSTEM', 'Killed orphaned Claude subprocess', { pid });
        } catch (error) {
          // Process may have already exited
          logger.debug('SYSTEM', 'Process already exited', { pid }, error as Error);
        }
      }
    } else {
      // Unix: Use ps with etime to find old processes
      // Pattern: claude processes with haiku model
      const { stdout } = await execAsync(
        `ps -eo pid,etime,args 2>/dev/null | grep -E "claude.*haiku" | grep -v grep || true`
      );

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned Claude subprocesses found (Unix)', { maxAgeMinutes });
        return 0;
      }

      const lines = stdout.trim().split('\n');
      const processesToKill: { pid: number; etime: string }[] = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;

        const pid = parseInt(parts[0], 10);
        const etime = parts[1];

        // Validate PID
        if (isNaN(pid) || !Number.isInteger(pid) || pid <= 0) continue;

        // Parse etime format: [[DD-]HH:]MM:SS
        const ageMinutes = parseEtimeToMinutes(etime);
        if (ageMinutes >= maxAgeMinutes) {
          processesToKill.push({ pid, etime });
        }
      }

      if (processesToKill.length === 0) {
        logger.debug('SYSTEM', 'No Claude subprocesses older than threshold', { maxAgeMinutes });
        return 0;
      }

      logger.info('SYSTEM', 'Found orphaned Claude subprocesses', {
        count: processesToKill.length,
        maxAgeMinutes,
        processes: processesToKill
      });

      for (const { pid } of processesToKill) {
        try {
          // Graceful first
          process.kill(pid, 'SIGTERM');
          killed++;
          logger.info('SYSTEM', 'Killed orphaned Claude subprocess', { pid });
        } catch (error) {
          // Process may have already exited
          logger.debug('SYSTEM', 'Process already exited', { pid }, error as Error);
        }
      }
    }
  } catch (error) {
    // Cleanup is non-critical - log and continue
    logger.error('SYSTEM', 'Failed to cleanup orphaned Claude subprocesses', { maxAgeMinutes }, error as Error);
  }

  if (killed > 0) {
    logger.info('SYSTEM', 'Orphaned Claude subprocess cleanup complete', { killed, maxAgeMinutes });
  }

  return killed;
}

/**
 * Parse Unix etime format to minutes
 * Formats: SS, MM:SS, HH:MM:SS, D-HH:MM:SS
 */
function parseEtimeToMinutes(etime: string): number {
  try {
    // Handle day format: D-HH:MM:SS
    if (etime.includes('-')) {
      const [dayPart, timePart] = etime.split('-');
      const days = parseInt(dayPart, 10);
      const timeMinutes = parseTimeToMinutes(timePart);
      return days * 24 * 60 + timeMinutes;
    }
    return parseTimeToMinutes(etime);
  } catch {
    return 0;
  }
}

/**
 * Parse HH:MM:SS or MM:SS or SS to minutes
 */
function parseTimeToMinutes(time: string): number {
  if (!time || time.trim() === '') return 0;
  const parts = time.split(':').map(p => parseInt(p, 10));
  // Check for NaN values (invalid input)
  if (parts.some(p => isNaN(p))) return 0;
  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 60 + parts[1] + parts[2] / 60;
  } else if (parts.length === 2) {
    // MM:SS
    return parts[0] + parts[1] / 60;
  } else if (parts.length === 1) {
    // SS
    return parts[0] / 60;
  }
  return 0;
}
