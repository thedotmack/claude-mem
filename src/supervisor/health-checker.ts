/**
 * Health Checker - Periodic background cleanup of dead processes and stale sockets
 *
 * Runs every 30 seconds to:
 * 1. Prune dead processes from the supervisor registry
 * 2. Remove stale socket files from ~/.claude-mem/sockets/
 *
 * The interval is unref'd so it does not keep the process alive.
 */

import { existsSync, readdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';
import { getProcessRegistry, isPidAlive } from './process-registry.js';

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const SOCKETS_DIR = path.join(homedir(), '.claude-mem', 'sockets');

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function runHealthCheck(): void {
  const registry = getProcessRegistry();

  // Phase 1: Prune dead processes from registry
  const removedProcessCount = registry.pruneDeadEntries();
  if (removedProcessCount > 0) {
    logger.info('SYSTEM', `Health check: pruned ${removedProcessCount} dead process(es) from registry`);
  }

  // Phase 2: Clean stale socket files
  cleanStaleSocketFilesFromHealthCheck();
}

function cleanStaleSocketFilesFromHealthCheck(): void {
  if (!existsSync(SOCKETS_DIR)) return;

  const registry = getProcessRegistry();
  const allRecords = registry.getAll();
  const aliveSocketPaths = new Set(
    allRecords
      .filter(record => record.socketPath && isPidAlive(record.pid))
      .map(record => record.socketPath!)
  );

  try {
    const entries = readdirSync(SOCKETS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith('.sock')) continue;
      if (entry.startsWith('.probe')) continue;

      const socketPath = path.join(SOCKETS_DIR, entry);
      if (aliveSocketPaths.has(socketPath)) continue;

      try {
        unlinkSync(socketPath);
        logger.info('SYSTEM', 'Health check: removed stale socket file', { socketPath });
      } catch (error) {
        logger.debug('SYSTEM', 'Health check: failed to remove stale socket file', { socketPath }, error as Error);
      }
    }
  } catch (error) {
    logger.debug('SYSTEM', 'Health check: failed to enumerate sockets directory', {}, error as Error);
  }
}

export function startHealthChecker(): void {
  if (healthCheckInterval !== null) return;

  healthCheckInterval = setInterval(runHealthCheck, HEALTH_CHECK_INTERVAL_MS);
  healthCheckInterval.unref();

  logger.debug('SYSTEM', 'Health checker started', { intervalMs: HEALTH_CHECK_INTERVAL_MS });
}

export function stopHealthChecker(): void {
  if (healthCheckInterval === null) return;

  clearInterval(healthCheckInterval);
  healthCheckInterval = null;

  logger.debug('SYSTEM', 'Health checker stopped');
}
