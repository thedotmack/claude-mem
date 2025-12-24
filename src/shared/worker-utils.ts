import path from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { ProcessManager } from "../services/process/ProcessManager.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { getWorkerRestartInstructions } from "../utils/error-messages.js";

const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);

// Cache to avoid repeated settings file reads
let cachedPort: number | null = null;
let cachedHost: string | null = null;

/**
 * Get the worker port number from settings
 * Uses CLAUDE_MEM_WORKER_PORT from settings file or default (37777)
 * Caches the port value to avoid repeated file reads
 */
export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

/**
 * Get the worker host address
 * Uses CLAUDE_MEM_WORKER_HOST from settings file or default (127.0.0.1)
 * Caches the host value to avoid repeated file reads
 */
export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.CLAUDE_MEM_WORKER_HOST;
  return cachedHost;
}

/**
 * Clear the cached port and host values
 * Call this when settings are updated to force re-reading from file
 */
export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
}

/**
 * Check if worker is responsive and fully initialized by trying the readiness endpoint
 * Changed from /health to /api/readiness to ensure MCP initialization is complete
 */
async function isWorkerHealthy(): Promise<boolean> {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, {
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
  });
  return response.ok;
}

/**
 * Get the current plugin version from package.json
 */
function getPluginVersion(): string {
  const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return packageJson.version;
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string> {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

/**
 * Check if worker version matches plugin version
 * If mismatch detected, restart the worker automatically
 */
async function ensureWorkerVersionMatches(): Promise<void> {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();

  if (pluginVersion !== workerVersion) {
    logger.info('SYSTEM', 'Worker version mismatch detected - restarting worker', {
      pluginVersion,
      workerVersion
    });

    // Give files time to sync before restart
    await new Promise(resolve => setTimeout(resolve, getTimeout(HOOK_TIMEOUTS.PRE_RESTART_SETTLE_DELAY)));

    // Restart the worker
    await ProcessManager.restart(getWorkerPort());

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify it's healthy
    if (!await isWorkerHealthy()) {
      throw new Error(`Worker failed to restart after version mismatch. Expected ${pluginVersion}, was running ${workerVersion}`);
    }
  }
}

/**
 * Start the worker service using ProcessManager
 * Handles both Unix (Bun) and Windows (compiled exe) platforms
 */
async function startWorker(): Promise<boolean> {
  // Clean up legacy PM2 (one-time migration)
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  const pm2MigratedMarker = path.join(dataDir, '.pm2-migrated');

  // Ensure data directory exists (may not exist on fresh install)
  mkdirSync(dataDir, { recursive: true });

  if (!existsSync(pm2MigratedMarker)) {
    spawnSync('pm2', ['delete', 'claude-mem-worker'], { stdio: 'ignore' });
    // Mark migration as complete
    writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
    logger.debug('SYSTEM', 'PM2 cleanup completed and marked');
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
 * Also ensures worker version matches plugin version
 */
export async function ensureWorkerRunning(): Promise<void> {
  // Check if already healthy (will throw on fetch errors)
  let healthy = false;
  try {
    healthy = await isWorkerHealthy();
  } catch (error) {
    // Worker not running or unreachable - continue to start it
    healthy = false;
  }

  if (healthy) {
    // Worker is healthy, but check if version matches
    await ensureWorkerVersionMatches();
    return;
  }

  // Try to start the worker
  const started = await startWorker();

  if (!started) {
    const port = getWorkerPort();
    throw new Error(
      getWorkerRestartInstructions({
        port,
        customPrefix: `Worker service failed to start on port ${port}.`
      })
    );
  }

  // Wait for worker to become responsive after starting
  // Try up to 5 times with 500ms delays (2.5 seconds total)
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      if (await isWorkerHealthy()) {
        await ensureWorkerVersionMatches();
        return;
      }
    } catch (error) {
      // Continue trying
    }
  }

  // Worker started but isn't responding
  const port = getWorkerPort();
  logger.error('SYSTEM', 'Worker started but not responding to health checks');
  throw new Error(
    getWorkerRestartInstructions({
      port,
      customPrefix: `Worker service started but is not responding on port ${port}.`
    })
  );
}
