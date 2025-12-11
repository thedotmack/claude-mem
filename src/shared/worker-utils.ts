import path from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { ProcessManager } from "../services/process/ProcessManager.js";

const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);

// MIGRATION: Hardcoded port to avoid conflicts with PM2 worker on 37777
// TODO: Switch to settings-based port after PM2 is fully removed
const MIGRATION_PORT = 38888;

/**
 * Get the worker port number
 * Currently hardcoded for migration; will use settings after PM2 removal
 */
export function getWorkerPort(): number {
  return MIGRATION_PORT;
}

/**
 * Check if worker is responsive by trying the health endpoint
 */
async function isWorkerHealthy(): Promise<boolean> {
  try {
    const port = getWorkerPort();
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    });
    return response.ok;
  } catch (error) {
    logger.debug('SYSTEM', 'Worker health check failed', {
      error: error instanceof Error ? error.message : String(error),
      errorType: error?.constructor?.name
    });
    return false;
  }
}

/**
 * Start the worker service using ProcessManager
 * Handles both Unix (Bun) and Windows (compiled exe) platforms
 */
async function startWorker(): Promise<boolean> {
  // Clean up legacy PM2 (one-time migration)
  if (process.platform !== 'win32') {
    try {
      spawnSync('pm2', ['delete', 'claude-mem-worker'], { stdio: 'ignore' });
    } catch {
      // PM2 not installed or process doesn't exist - ignore
    }
  }

  const port = getWorkerPort();
  const result = await ProcessManager.start(port);

  if (!result.success) {
    logger.error('SYSTEM', 'Failed to start worker', {
      platform: process.platform,
      port,
      error: result.error,
      marketplaceRoot: MARKETPLACE_ROOT
    });
  }

  return result.success;
}

/**
 * Ensure worker service is running
 * Checks health and auto-starts if not running
 */
export async function ensureWorkerRunning(): Promise<void> {
  // Check if already healthy
  if (await isWorkerHealthy()) {
    return;
  }

  // Try to start the worker
  const started = await startWorker();

  // Final health check before throwing error
  // Worker might be already running but was temporarily unresponsive
  if (!started && await isWorkerHealthy()) {
    return;
  }

  if (!started) {
    const port = getWorkerPort();
    throw new Error(
      `Worker service failed to start on port ${port}.\n\n` +
      `To start manually, run: npm run worker:start\n` +
      `If already running, try: npm run worker:restart`
    );
  }
}
