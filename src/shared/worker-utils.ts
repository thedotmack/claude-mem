import path from "path";
import { homedir } from "os";
import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
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
  // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
  const response = await fetch(`http://127.0.0.1:${port}/api/readiness`);
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
  // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
  const response = await fetch(`http://127.0.0.1:${port}/api/version`);
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

/**
 * Check if worker version matches plugin version
 * Note: Auto-restart on version mismatch is now handled in worker-service.ts start command (issue #484)
 * This function logs for informational purposes only
 */
async function checkWorkerVersion(): Promise<void> {
  const pluginVersion = getPluginVersion();
  const workerVersion = await getWorkerVersion();

  if (pluginVersion !== workerVersion) {
    // Just log debug info - auto-restart handles the mismatch in worker-service.ts
    logger.debug('SYSTEM', 'Version check', {
      pluginVersion,
      workerVersion,
      note: 'Mismatch will be auto-restarted by worker-service start command'
    });
  }
}


/**
 * Get the path to Bun executable (checking common locations)
 */
function getBunPath(): string {
  // Common bun paths
  const bunPaths = process.platform === 'win32'
    ? [path.join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [path.join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun'];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      return bunPath;
    }
  }

  // Fallback to assuming bun is in PATH
  return 'bun';
}

/**
 * Attempt to start the worker by calling worker-service.cjs start
 * Returns true if start command completed without error, false otherwise
 */
function tryStartWorker(): boolean {
  const workerServicePath = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
  const bunPath = getBunPath();

  try {
    logger.debug('SYSTEM', 'Attempting to start worker', { bunPath, workerServicePath });

    const result = spawnSync(bunPath, [workerServicePath, 'start'], {
      stdio: 'inherit',
      timeout: 30000,  // 30 second timeout for start command
      shell: process.platform === 'win32',
      env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(getWorkerPort()) }
    });

    if (result.status === 0) {
      logger.debug('SYSTEM', 'Worker start command completed successfully');
      return true;
    }

    logger.debug('SYSTEM', 'Worker start command failed', { status: result.status });
    return false;
  } catch (error) {
    logger.debug('SYSTEM', 'Worker start command threw error', {
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

/**
 * Ensure worker service is running
 * First tries quick health check, then attempts to start worker if not running,
 * then polls until worker is ready.
 */
export async function ensureWorkerRunning(): Promise<void> {
  const maxRetries = 75;  // 15 seconds total
  const pollInterval = 200;

  // Quick check - if worker is already healthy, we're done
  try {
    if (await isWorkerHealthy()) {
      await checkWorkerVersion();
      return;
    }
  } catch {
    // Worker not responding, will try to start it
  }

  // Try to start the worker
  logger.debug('SYSTEM', 'Worker not healthy, attempting to start');
  tryStartWorker();

  // Now poll until worker is ready
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (await isWorkerHealthy()) {
        await checkWorkerVersion();  // logs warning on mismatch, doesn't restart
        return;
      }
    } catch {
      // Continue polling
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error(getWorkerRestartInstructions({
    port: getWorkerPort(),
    customPrefix: 'Worker did not become ready within 15 seconds.'
  }));
}
