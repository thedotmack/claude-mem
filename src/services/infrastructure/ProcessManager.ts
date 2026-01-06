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
    const cmd = `wmic process where "parentprocessid=${parentPid}" get processid /format:list`;
    const { stdout } = await execAsync(cmd, { timeout: 60000 });
    return stdout
      .trim()
      .split('\n')
      .map(line => {
        const match = line.match(/ProcessId=(\d+)/i);
        return match ? parseInt(match[1], 10) : NaN;
      })
      .filter(n => !isNaN(n) && Number.isInteger(n) && n > 0);
  } catch (error) {
    // Shutdown cleanup - failure is non-critical, continue without child process cleanup
    logger.warn('SYSTEM', 'Failed to enumerate child processes', { parentPid }, error as Error);
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
      await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: 60000 });
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
      // Windows: Use WMIC to find chroma-mcp processes (avoids PowerShell $_ issues in Git Bash/WSL)
      const cmd = `wmic process where "name like '%python%' and commandline like '%chroma-mcp%'" get processid /format:list`;
      const { stdout } = await execAsync(cmd, { timeout: 60000 });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found (Windows)');
        return;
      }

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const match = line.match(/ProcessId=(\d+)/i);
        if (match) {
          const pid = parseInt(match[1], 10);
          // SECURITY: Validate PID is positive integer before adding to list
          if (!isNaN(pid) && Number.isInteger(pid) && pid > 0) {
            pids.push(pid);
          }
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
    logger.warn('SYSTEM', 'Failed to enumerate orphaned processes', {}, error as Error);
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
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: 60000, stdio: 'ignore' });
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
 * Detected SDK process info
 */
export interface SDKProcessInfo {
  pid: number;
  memorySessionId: string | null;
  commandLine: string;
}

/**
 * Detect orphaned Claude SDK processes spawned by claude-mem
 *
 * Claude-mem's memory agents have a unique signature: --disallowedTools flag
 * This flag is never used by the user's Claude Code session, only by memory agents.
 *
 * Orphan classification:
 * - Has --resume <id> AND id NOT in activeMemorySessionIds → ORPHAN
 * - Has --resume <id> AND id in activeMemorySessionIds → ACTIVE (skip)
 * - No --resume flag → STARTING (grace period, skip)
 *
 * @param activeMemorySessionIds - Set of currently active memory session IDs
 * @returns Array of PIDs that are orphaned (resuming dead sessions)
 */
export async function detectOrphanedSDKProcesses(
  activeMemorySessionIds: Set<string>
): Promise<number[]> {
  const isWindows = process.platform === 'win32';
  const processes: SDKProcessInfo[] = [];

  try {
    if (isWindows) {
      // Windows: Get both PID and command line to extract session ID
      const cmd = `wmic process where "commandline like '%claude%--disallowedTools%'" get processid,commandline /format:list`;
      const { stdout } = await execAsync(cmd, { timeout: 60000 });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No SDK processes found (Windows)');
        return [];
      }

      // Parse WMIC output: CommandLine=... and ProcessId=... on separate lines
      const entries = stdout.split(/\r?\n\r?\n/).filter(e => e.trim());
      for (const entry of entries) {
        const pidMatch = entry.match(/ProcessId=(\d+)/i);
        const cmdMatch = entry.match(/CommandLine=(.+)/i);
        if (pidMatch) {
          const pid = parseInt(pidMatch[1], 10);
          const commandLine = cmdMatch ? cmdMatch[1].trim() : '';
          if (Number.isInteger(pid) && pid > 0) {
            const sessionId = extractResumeSessionId(commandLine);
            processes.push({ pid, memorySessionId: sessionId, commandLine });
          }
        }
      }
    } else {
      // Unix: Use ps with full command line
      const { stdout } = await execAsync('ps aux | grep "claude.*--disallowedTools" | grep -v grep || true');

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No SDK processes found (Unix)');
        return [];
      }

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 1) {
          const pid = parseInt(parts[1], 10);
          // Command line is everything after the first 10 columns (USER PID %CPU %MEM VSZ RSS TTY STAT START TIME)
          const commandLine = parts.slice(10).join(' ');
          if (Number.isInteger(pid) && pid > 0) {
            const sessionId = extractResumeSessionId(commandLine);
            processes.push({ pid, memorySessionId: sessionId, commandLine });
          }
        }
      }
    }
  } catch (error) {
    // Detection failure is non-critical - log and return empty
    logger.warn('SYSTEM', 'Failed to detect SDK processes', {}, error as Error);
    return [];
  }

  if (processes.length === 0) {
    return [];
  }

  // Filter to orphans only
  const orphanedPids: number[] = [];
  for (const proc of processes) {
    if (proc.memorySessionId === null) {
      // No --resume flag = still starting up, grace period
      logger.debug('SYSTEM', 'SDK process in grace period (no --resume)', { pid: proc.pid });
      continue;
    }

    if (activeMemorySessionIds.has(proc.memorySessionId)) {
      // Active session, not an orphan
      logger.debug('SYSTEM', 'SDK process is active', { pid: proc.pid, sessionId: proc.memorySessionId });
      continue;
    }

    // Orphan: resuming a session that's not in our active set
    logger.debug('SYSTEM', 'Detected orphaned SDK process', {
      pid: proc.pid,
      sessionId: proc.memorySessionId
    });
    orphanedPids.push(proc.pid);
  }

  return orphanedPids;
}

/**
 * Extract --resume session ID from command line
 * Returns null if no --resume flag found
 */
function extractResumeSessionId(commandLine: string): string | null {
  // Match --resume followed by a UUID-like session ID
  const match = commandLine.match(/--resume\s+([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

/**
 * Clean up orphaned SDK processes by PID
 * Separated from detection for testability and reuse
 */
export async function cleanupOrphanedSDKProcesses(pids: number[]): Promise<void> {
  if (pids.length === 0) {
    return;
  }

  const isWindows = process.platform === 'win32';

  logger.info('SYSTEM', 'Cleaning up orphaned SDK processes', {
    platform: isWindows ? 'Windows' : 'Unix',
    count: pids.length,
    pids
  });

  for (const pid of pids) {
    // SECURITY: Validate PID before killing
    if (!Number.isInteger(pid) || pid <= 0) {
      logger.warn('SYSTEM', 'Skipping invalid PID', { pid });
      continue;
    }

    try {
      if (isWindows) {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: 60000, stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      logger.info('SYSTEM', 'Killed orphaned SDK process', { pid });
    } catch (error) {
      // Process may have already exited - non-critical
      logger.debug('SYSTEM', 'SDK process already exited', { pid }, error as Error);
    }
  }

  logger.info('SYSTEM', 'Orphaned SDK cleanup complete', { count: pids.length });
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
      process.exit(1);
    }
  };
}
