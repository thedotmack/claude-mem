/**
 * Health Checker - Periodic background cleanup of dead processes
 *
 * Runs every 30 seconds to prune dead processes from the supervisor registry.
 * The interval is unref'd so it does not keep the process alive.
 */

import { logger } from '../utils/logger.js';
import { getProcessRegistry } from './process-registry.js';

const HEALTH_CHECK_INTERVAL_MS = 30_000;

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function runHealthCheck(): void {
  const registry = getProcessRegistry();

  const removedProcessCount = registry.pruneDeadEntries();
  if (removedProcessCount > 0) {
    logger.info('SYSTEM', `Health check: pruned ${removedProcessCount} dead process(es) from registry`);
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
