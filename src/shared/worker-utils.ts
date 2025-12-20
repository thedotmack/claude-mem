import path from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS } from "./hook-constants.js";
import { ProcessManager } from "../services/process/ProcessManager.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { getWorkerRestartInstructions } from "../utils/error-messages.js";

const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

// Named constants for health checks (Windows uses 1500ms, Unix uses 1000ms)
const HEALTH_CHECK_TIMEOUT_MS = process.platform === 'win32' ? 1500 : 1000;

// Port cache to avoid repeated settings file reads
let cachedPort: number | null = null;

/**
 * Get the worker port number from settings
 * Uses CLAUDE_MEM_WORKER_PORT from settings file or default (37777)
 * Caches the port value to avoid repeated file reads
 */
export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  try {
    const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
    return cachedPort;
  } catch (error) {
    // Fallback to default if settings load fails
    logger.debug('SYSTEM', 'Failed to load port from settings, using default', { error });
    cachedPort = parseInt(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT'), 10);
    return cachedPort;
  }
}

/**
 * Clear the cached port value
 * Call this when settings are updated to force re-reading from file
 */
export function clearPortCache(): void {
  cachedPort = null;
}

/**
 * Get the worker host address
 * Priority: ~/.claude-mem/settings.json > env var > default (127.0.0.1)
 */
export function getWorkerHost(): string {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_WORKER_HOST;
}

/**
 * Check if worker is responsive and fully initialized by trying the readiness endpoint
 * Changed from /health to /api/readiness to ensure MCP initialization is complete
 */
async function isWorkerHealthy(): Promise<boolean> {
  try {
    const port = getWorkerPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    });
    return response.ok;
  } catch (error) {
    logger.debug('SYSTEM', 'Worker readiness check failed', {
      error: error instanceof Error ? error.message : String(error),
      errorType: error?.constructor?.name
    });
    return false;
  }
}

/**
 * Get the current plugin version from package.json
 */
function getPluginVersion(): string | null {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to read plugin version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string | null> {
  try {
    const port = getWorkerPort();
    const response = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const data = await response.json() as { version: string };
    return data.version;
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to get worker version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * Check if worker version matches plugin version
 * If mismatch detected, restart the worker automatically
 */
async function ensureWorkerVersionMatches(): Promise<void> {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();

  if (!pluginVersion || !workerVersion) {
    // Can't determine versions, skip check
    return;
  }

  if (pluginVersion !== workerVersion) {
    logger.info('SYSTEM', 'Worker version mismatch detected - restarting worker', {
      pluginVersion,
      workerVersion
    });

    // Give files time to sync before restart (Windows: 3000ms, Unix: 2000ms)
    const settleDelay = process.platform === 'win32' ? 3000 : 2000;
    await new Promise(resolve => setTimeout(resolve, settleDelay));

    // Restart the worker
    await ProcessManager.restart(getWorkerPort());

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify it's healthy
    if (!await isWorkerHealthy()) {
      logger.error('SYSTEM', 'Worker failed to restart after version mismatch', {
        expectedVersion: pluginVersion,
        runningVersion: workerVersion,
        port: getWorkerPort()
      });
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
    try {
      spawnSync('pm2', ['delete', 'claude-mem-worker'], { stdio: 'ignore' });
      // Mark migration as complete
      writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
      logger.debug('SYSTEM', 'PM2 cleanup completed and marked');
    } catch {
      // PM2 not installed or process doesn't exist - still mark as migrated
      writeFileSync(pm2MigratedMarker, new Date().toISOString(), 'utf-8');
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
 * Also ensures worker version matches plugin version
 */
export async function ensureWorkerRunning(): Promise<void> {
  // Check if already healthy
  if (await isWorkerHealthy()) {
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
    if (await isWorkerHealthy()) {
      await ensureWorkerVersionMatches();
      return;
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
