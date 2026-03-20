/**
 * registry-reader.ts — side-effect-free module for reading supervisor.json from hook processes.
 *
 * This module is intentionally dependency-light: it uses only Node.js built-ins so it
 * can be imported in hook processes (which are short-lived OS processes, not the worker).
 * Do NOT import logger or any singleton from this module.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { isPidAlive, type ManagedProcessRecord } from './process-registry.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const DEFAULT_REGISTRY_PATH = path.join(DATA_DIR, 'supervisor.json');

/** Maximum age (ms) for a registry entry before we skip it to avoid PID-reuse kills. */
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PersistedRegistry {
  processes: Record<string, { pid: number; type: string; subsystem?: string; startedAt: string; sessionId?: string | number }>;
}

/**
 * Read supervisor.json synchronously. Returns an empty array on any error.
 * Safe to call from hook processes that have no logger or singleton access.
 */
export function readRegistryRaw(registryPath: string = DEFAULT_REGISTRY_PATH): ManagedProcessRecord[] {
  if (!existsSync(registryPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as PersistedRegistry;
    const processes = raw.processes ?? {};
    return Object.entries(processes).map(([id, info]) => ({ id, ...info }));
  } catch {
    return [];
  }
}

/**
 * Find the first live PID registered under the given subsystem label.
 * Returns null if no matching alive entry is found.
 */
export function getRegisteredPidBySubsystem(subsystem: string, registryPath: string = DEFAULT_REGISTRY_PATH): number | null {
  const entries = readRegistryRaw(registryPath);
  for (const entry of entries) {
    if (entry.subsystem === subsystem && isPidAlive(entry.pid)) {
      return entry.pid;
    }
  }
  return null;
}

/**
 * Kill processes in supervisor.json that match the given subsystem names.
 *
 * Safety checks applied before killing:
 * - PID must be a positive integer.
 * - PID must not be the current process or PID 0.
 * - Entry must not be older than MAX_ENTRY_AGE_MS (guards against PID reuse after reboot).
 * - PID must currently be alive.
 *
 * On Windows: uses `taskkill /F /T /PID` to kill the process tree.
 * On Unix: sends SIGTERM then SIGKILL.
 *
 * Returns lists of killed and failed PIDs. Also removes successfully killed entries
 * from the registry file.
 */
export function killRegisteredProcesses(
  subsystems?: string[],
  registryPath: string = DEFAULT_REGISTRY_PATH
): { killed: number[]; failed: number[] } {
  const entries = readRegistryRaw(registryPath);
  const now = Date.now();
  const killed: number[] = [];
  const failed: number[] = [];

  const targets = subsystems
    ? entries.filter(e => e.subsystem && subsystems.includes(e.subsystem))
    : entries;

  for (const entry of targets) {
    const pid = entry.pid;

    // Safety: valid positive integer, not self, not PID 0
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;

    // Age gate: skip entries older than 24h to avoid hitting PID-reused processes
    const entryAge = now - Date.parse(entry.startedAt);
    if (!isNaN(entryAge) && entryAge > MAX_ENTRY_AGE_MS) continue;

    if (!isPidAlive(pid)) continue;

    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // If SIGTERM fails (e.g. EPERM), fall through to SIGKILL attempt
        }
        // Brief pause then SIGKILL if still alive
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && isPidAlive(pid)) {
          // Spin-wait (synchronous context — no async available in hook processes)
          const end = Date.now() + 100;
          while (Date.now() < end) { /* busy-wait */ }
        }
        if (isPidAlive(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      killed.push(pid);
    } catch {
      failed.push(pid);
    }
  }

  // Remove killed entries from the file
  if (killed.length > 0) {
    removeRegistryEntries(killed, registryPath);
  }

  return { killed, failed };
}

/**
 * Remove specific PIDs from supervisor.json.
 * Silently does nothing if the file is missing or malformed.
 */
export function removeRegistryEntries(pids: number[], registryPath: string = DEFAULT_REGISTRY_PATH): void {
  if (!existsSync(registryPath)) return;

  try {
    const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as PersistedRegistry;
    const processes = raw.processes ?? {};
    const pidSet = new Set(pids);

    for (const [id, info] of Object.entries(processes)) {
      if (pidSet.has(info.pid)) {
        delete processes[id];
      }
    }

    writeFileSync(registryPath, JSON.stringify({ processes }, null, 2));
  } catch {
    // Best-effort: if we can't clean up the file, next startup's pruneDeadEntries will handle it
  }
}
