/**
 * ProcessRegistry: Track spawned Claude subprocesses
 *
 * Fixes Issue #737: Claude haiku subprocesses don't terminate properly,
 * causing zombie process accumulation (user reported 155 processes / 51GB RAM).
 *
 * Root causes:
 * 1. SDK's SpawnedProcess interface hides subprocess PIDs
 * 2. deleteSession() doesn't verify subprocess exit before cleanup
 * 3. abort() is fire-and-forget with no confirmation
 *
 * Solution:
 * - Use SDK's spawnClaudeCodeProcess option to capture PIDs
 * - Track all spawned processes with session association
 * - Verify exit on session deletion with timeout + SIGKILL escalation
 * - Safety net orphan reaper runs every 5 minutes
 */

import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

interface TrackedProcess {
  pid: number;
  sessionDbId: number;
  spawnedAt: number;
  process: ChildProcess;
}

// PID Registry - tracks spawned Claude subprocesses
const processRegistry = new Map<number, TrackedProcess>();

/**
 * Register a spawned process in the registry
 */
export function registerProcess(pid: number, sessionDbId: number, process: ChildProcess): void {
  processRegistry.set(pid, { pid, sessionDbId, spawnedAt: Date.now(), process });
  logger.info('PROCESS', `Registered PID ${pid} for session ${sessionDbId}`, { pid, sessionDbId });
}

/**
 * Unregister a process from the registry
 */
export function unregisterProcess(pid: number): void {
  processRegistry.delete(pid);
  logger.debug('PROCESS', `Unregistered PID ${pid}`, { pid });
}

/**
 * Get process info by session ID
 * Warns if multiple processes found (indicates race condition)
 */
export function getProcessBySession(sessionDbId: number): TrackedProcess | undefined {
  const matches: TrackedProcess[] = [];
  for (const [, info] of processRegistry) {
    if (info.sessionDbId === sessionDbId) matches.push(info);
  }
  if (matches.length > 1) {
    logger.warn('PROCESS', `Multiple processes found for session ${sessionDbId}`, {
      count: matches.length,
      pids: matches.map(m => m.pid)
    });
  }
  return matches[0];
}

/**
 * Get all active PIDs (for debugging)
 */
export function getActiveProcesses(): Array<{ pid: number; sessionDbId: number; ageMs: number }> {
  const now = Date.now();
  return Array.from(processRegistry.values()).map(info => ({
    pid: info.pid,
    sessionDbId: info.sessionDbId,
    ageMs: now - info.spawnedAt
  }));
}

/**
 * Wait for a process to exit with timeout, escalating to SIGKILL if needed
 * Uses event-based waiting instead of polling to avoid CPU overhead
 */
export async function ensureProcessExit(tracked: TrackedProcess, timeoutMs: number = 5000): Promise<void> {
  const { pid, process: proc } = tracked;

  // Already exited?
  if (proc.killed || proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Wait for graceful exit with timeout using event-based approach
  const exitPromise = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  // Check if exited gracefully
  if (proc.killed || proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Timeout: escalate to SIGKILL
  logger.warn('PROCESS', `PID ${pid} did not exit after ${timeoutMs}ms, sending SIGKILL`, { pid, timeoutMs });
  try {
    proc.kill('SIGKILL');
  } catch {
    // Already dead
  }

  // Brief wait for SIGKILL to take effect
  await new Promise(resolve => setTimeout(resolve, 200));
  unregisterProcess(pid);
}

/**
 * Kill idle daemon children (claude processes spawned by worker-service)
 *
 * These are SDK-spawned claude processes that completed their work but
 * didn't terminate properly. They remain as children of the worker-service
 * daemon, consuming memory without doing useful work.
 *
 * Criteria for cleanup:
 * - Process name is "claude"
 * - Parent PID is the worker-service daemon (this process)
 * - Process has 0% CPU (idle)
 * - Process has been running for more than 2 minutes
 */
async function killIdleDaemonChildren(): Promise<number> {
  if (process.platform === 'win32') {
    // Windows: Different process model, skip for now
    return 0;
  }

  const daemonPid = process.pid;
  let killed = 0;

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,%cpu,etime,comm 2>/dev/null | grep "claude$" || true'
    );

    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const [pidStr, ppidStr, cpuStr, etime] = parts;
      const pid = parseInt(pidStr, 10);
      const ppid = parseInt(ppidStr, 10);
      const cpu = parseFloat(cpuStr);

      // Skip if not a child of this daemon
      if (ppid !== daemonPid) continue;

      // Skip if actively using CPU
      if (cpu > 0) continue;

      // Parse elapsed time to minutes
      // Formats: MM:SS, HH:MM:SS, D-HH:MM:SS
      let minutes = 0;
      const dayMatch = etime.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
      const hourMatch = etime.match(/^(\d+):(\d+):(\d+)$/);
      const minMatch = etime.match(/^(\d+):(\d+)$/);

      if (dayMatch) {
        minutes = parseInt(dayMatch[1], 10) * 24 * 60 +
                  parseInt(dayMatch[2], 10) * 60 +
                  parseInt(dayMatch[3], 10);
      } else if (hourMatch) {
        minutes = parseInt(hourMatch[1], 10) * 60 +
                  parseInt(hourMatch[2], 10);
      } else if (minMatch) {
        minutes = parseInt(minMatch[1], 10);
      }

      // Kill if idle for more than 2 minutes
      if (minutes >= 2) {
        logger.info('PROCESS', `Killing idle daemon child PID ${pid} (idle ${minutes}m)`, { pid, minutes });
        try {
          process.kill(pid, 'SIGKILL');
          killed++;
        } catch {
          // Already dead or permission denied
        }
      }
    }
  } catch {
    // No matches or command error
  }

  return killed;
}

/**
 * Kill system-level orphans (ppid=1 on Unix)
 * These are Claude processes whose parent died unexpectedly
 */
async function killSystemOrphans(): Promise<number> {
  if (process.platform === 'win32') {
    return 0; // Windows doesn't have ppid=1 orphan concept
  }

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,args 2>/dev/null | grep -E "claude.*haiku|claude.*output-format" | grep -v grep'
    );

    let killed = 0;
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const match = line.trim().match(/^(\d+)\s+(\d+)/);
      if (match && parseInt(match[2]) === 1) { // ppid=1 = orphan
        const orphanPid = parseInt(match[1]);
        logger.warn('PROCESS', `Killing system orphan PID ${orphanPid}`, { pid: orphanPid });
        try {
          process.kill(orphanPid, 'SIGKILL');
          killed++;
        } catch {
          // Already dead or permission denied
        }
      }
    }
    return killed;
  } catch {
    return 0; // No matches or error
  }
}

/**
 * Reap orphaned processes - both registry-tracked and system-level
 */
export async function reapOrphanedProcesses(activeSessionIds: Set<number>): Promise<number> {
  let killed = 0;

  // Registry-based: kill processes for dead sessions
  for (const [pid, info] of processRegistry) {
    if (activeSessionIds.has(info.sessionDbId)) continue; // Active = safe

    logger.warn('PROCESS', `Killing orphan PID ${pid} (session ${info.sessionDbId} gone)`, { pid, sessionDbId: info.sessionDbId });
    try {
      info.process.kill('SIGKILL');
      killed++;
    } catch {
      // Already dead
    }
    unregisterProcess(pid);
  }

  // System-level: find ppid=1 orphans
  killed += await killSystemOrphans();

  // Daemon children: find idle SDK processes that didn't terminate
  killed += await killIdleDaemonChildren();

  return killed;
}

/**
 * Create a custom spawn function for SDK that captures PIDs
 *
 * The SDK's spawnClaudeCodeProcess option allows us to intercept subprocess
 * creation and capture the PID before the SDK hides it.
 *
 * NOTE: Session isolation is handled via the `cwd` option in SDKAgent.ts,
 * NOT via CLAUDE_CONFIG_DIR (which breaks authentication).
 */
export function createPidCapturingSpawn(sessionDbId: number) {
  return (spawnOptions: {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }) => {
    const child = spawn(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: spawnOptions.signal, // CRITICAL: Pass signal for AbortController integration
      windowsHide: true
    });

    // Register PID
    if (child.pid) {
      registerProcess(child.pid, sessionDbId, child);

      // Auto-unregister on exit
      child.on('exit', () => {
        if (child.pid) {
          unregisterProcess(child.pid);
        }
      });
    }

    // Return SDK-compatible interface
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: child.kill.bind(child),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child)
    };
  };
}

/**
 * Start the orphan reaper interval
 * Returns cleanup function to stop the interval
 */
export function startOrphanReaper(getActiveSessionIds: () => Set<number>, intervalMs: number = 5 * 60 * 1000): () => void {
  const interval = setInterval(async () => {
    try {
      const activeIds = getActiveSessionIds();
      const killed = await reapOrphanedProcesses(activeIds);
      if (killed > 0) {
        logger.info('PROCESS', `Reaper cleaned up ${killed} orphaned processes`, { killed });
      }
    } catch (error) {
      logger.error('PROCESS', 'Reaper error', {}, error as Error);
    }
  }, intervalMs);

  // Return cleanup function
  return () => clearInterval(interval);
}
