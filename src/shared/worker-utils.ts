import path from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";

const execFileAsync = promisify(execFile);

const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'magic-claude-mem');
const WORKER_FETCH_TIMEOUT_MS = 5000;

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Cache to avoid repeated settings file reads
let cachedPort: number | null = null;
let cachedHost: string | null = null;

/**
 * Get the worker port number from settings
 * Uses MAGIC_CLAUDE_MEM_WORKER_PORT from settings file or default (37777)
 * Caches the port value to avoid repeated file reads
 */
export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('MAGIC_CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.MAGIC_CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

/**
 * Get the worker host address
 * Uses MAGIC_CLAUDE_MEM_WORKER_HOST from settings file or default (127.0.0.1)
 * Caches the host value to avoid repeated file reads
 */
export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('MAGIC_CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.MAGIC_CLAUDE_MEM_WORKER_HOST;
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
 * Check if worker HTTP server is responsive
 * Uses /api/health (liveness) instead of /api/readiness because:
 * - Hooks have 15-second timeout, but full initialization can take 5+ minutes (MCP connection)
 * - /api/health returns 200 as soon as HTTP server is up (sufficient for hook communication)
 * - /api/readiness returns 503 until full initialization completes (too slow for hooks)
 * See: https://github.com/doublefx/magic-claude-mem/issues/811
 */
async function isWorkerHealthy(): Promise<boolean> {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
    signal: AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
  });
  return response.ok;
}

/**
 * Get the current plugin version from package.json
 */
function getPluginVersion(): string {
  const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };
  return packageJson.version;
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string> {
  const port = getWorkerPort();
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/version`, {
    signal: AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${String(response.status)}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

/**
 * Check if worker version matches plugin version.
 * Returns true when versions match (or when version cannot be determined – assume OK),
 * false when a mismatch is detected.
 */
async function checkWorkerVersion(): Promise<boolean> {
  try {
    const pluginVersion = getPluginVersion();
    const workerVersion = await getWorkerVersion();

    if (pluginVersion !== workerVersion) {
      logger.debug('SYSTEM', 'Version mismatch detected', { pluginVersion, workerVersion });
      return false;
    }

    return true;
  } catch (e) {
    // Cannot determine version – treat as matching so we don't restart unnecessarily
    logger.debug('SYSTEM', 'Could not determine worker version, assuming match', {
      error: toErrorMessage(e)
    });
    return true;
  }
}

/**
 * Restart the worker service and verify it comes back healthy.
 * Returns true when the worker is healthy after restart, false otherwise.
 */
async function restartWorker(): Promise<boolean> {
  const workerServicePath = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
  try {
    logger.info('SYSTEM', 'Restarting worker due to version mismatch');
    await execFileAsync('node', [workerServicePath, 'restart'], { timeout: 45000 });
    clearPortCache();  // New version may use a different port
    const healthy = await isWorkerHealthy();
    if (healthy) {
      logger.info('SYSTEM', 'Worker restarted successfully after version mismatch');
    } else {
      logger.warn('SYSTEM', 'Worker restart completed but health check failed');
    }
    return healthy;
  } catch (e) {
    logger.warn('SYSTEM', 'Worker restart failed, proceeding gracefully', {
      error: toErrorMessage(e)
    });
    return false;
  }
}

/**
 * Ensure worker service is running.
 * Quick health check - returns false if worker not healthy (doesn't block).
 * When the worker is healthy but running an outdated version, triggers a
 * restart via the existing worker-service.cjs restart command and returns
 * the post-restart health status.
 */
export async function ensureWorkerRunning(): Promise<boolean> {
  // Quick health check (single attempt, no polling)
  try {
    if (await isWorkerHealthy()) {
      const versionsMatch = await checkWorkerVersion();
      if (!versionsMatch) {
        return await restartWorker();
      }
      return true;
    }
  } catch (e) {
    // Not healthy - log for debugging
    logger.debug('SYSTEM', 'Worker health check failed', {
      error: toErrorMessage(e)
    });
  }

  // Port might be in use by something else, or worker not started
  // Return false but don't throw - let caller decide how to handle
  logger.warn('SYSTEM', 'Worker not healthy, hook will proceed gracefully');
  return false;
}
