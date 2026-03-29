import path from "path";
import { readFileSync, existsSync, statSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT, DATA_DIR } from "./paths.js";

// Named constants for health checks
// Allow env var override for users on slow systems (e.g., CLAUDE_MEM_HEALTH_TIMEOUT_MS=10000)
const HEALTH_CHECK_TIMEOUT_MS = (() => {
  const envVal = process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= 500 && parsed <= 300000) {
      return parsed;
    }
    // Invalid env var — log once and use default
    logger.warn('SYSTEM', 'Invalid CLAUDE_MEM_HEALTH_TIMEOUT_MS, using default', {
      value: envVal, min: 500, max: 300000
    });
  }
  return getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);
})();

/**
 * Fetch with a timeout using Promise.race instead of AbortSignal.
 * AbortSignal.timeout() causes a libuv assertion crash in Bun on Windows,
 * so we use a racing setTimeout pattern that avoids signal cleanup entirely.
 * The orphaned fetch is harmless since the process exits shortly after.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    fetch(url, init).then(
      response => { clearTimeout(timeoutId); resolve(response); },
      err => { clearTimeout(timeoutId); reject(err); }
    );
  });
}

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
 * Clear the cached port and host values.
 * Call this when settings are updated to force re-reading from file.
 */
export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
}

/**
 * Build a full URL for a given API path.
 */
export function buildWorkerUrl(apiPath: string): string {
  return `http://${getWorkerHost()}:${getWorkerPort()}${apiPath}`;
}

/**
 * Make an HTTP request to the worker over TCP.
 *
 * This is the preferred way for hooks to communicate with the worker.
 */
export function workerHttpRequest(
  apiPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<Response> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  const url = buildWorkerUrl(apiPath);
  const init: RequestInit = { method };
  if (options.headers) {
    init.headers = options.headers;
  }
  if (options.body) {
    init.body = options.body;
  }

  if (timeoutMs > 0) {
    return fetchWithTimeout(url, init, timeoutMs);
  }
  return fetch(url, init);
}

/**
 * Check if worker HTTP server is responsive.
 * Uses /api/health (liveness) instead of /api/readiness because:
 * - Hooks have 15-second timeout, but full initialization can take 5+ minutes (MCP connection)
 * - /api/health returns 200 as soon as HTTP server is up (sufficient for hook communication)
 * - /api/readiness returns 503 until full initialization completes (too slow for hooks)
 * See: https://github.com/thedotmack/claude-mem/issues/811
 */
async function isWorkerHealthy(): Promise<boolean> {
  const response = await workerHttpRequest('/api/health', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  return response.ok;
}

/**
 * Get the current plugin version from package.json.
 * Returns 'unknown' on ENOENT/EBUSY (shutdown race condition, fix #1042).
 */
function getPluginVersion(): string {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EBUSY') {
      logger.debug('SYSTEM', 'Could not read plugin version (shutdown race)', { code });
      return 'unknown';
    }
    throw error;
  }
}

/**
 * Get the running worker's version from the API
 */
async function getWorkerVersion(): Promise<string> {
  const response = await workerHttpRequest('/api/version', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

/**
 * Check if worker version matches plugin version
 * Note: Auto-restart on version mismatch is now handled in worker-service.ts start command (issue #484)
 * This function logs for informational purposes only.
 * Skips comparison when either version is 'unknown' (fix #1042 — avoids restart loops).
 */
async function checkWorkerVersion(): Promise<void> {
  try {
    const pluginVersion = getPluginVersion();

    // Skip version check if plugin version couldn't be read (shutdown race)
    if (pluginVersion === 'unknown') return;

    const workerVersion = await getWorkerVersion();

    // Skip version check if worker version is 'unknown' (avoids restart loops)
    if (workerVersion === 'unknown') return;

    if (pluginVersion !== workerVersion) {
      // Just log debug info - auto-restart handles the mismatch in worker-service.ts
      logger.debug('SYSTEM', 'Version check', {
        pluginVersion,
        workerVersion,
        note: 'Mismatch will be auto-restarted by worker-service start command'
      });
    }
  } catch (error) {
    // Version check is informational — don't fail the hook
    logger.debug('SYSTEM', 'Version check failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}


// PID file path — matches ProcessManager.ts constant
const WORKER_PID_FILE = path.join(DATA_DIR, 'worker.pid');

// Threshold for considering PID file "recent" (worker likely still starting)
const PID_FILE_RECENT_THRESHOLD_MS = 30000;

/**
 * Check if the worker appears to be starting up.
 * Returns true if a PID file exists and was modified recently,
 * indicating a spawn is in progress and retrying health checks is worthwhile.
 * Returns false if no PID file exists (worker needs spawn, not retry)
 * or PID file is stale (worker likely dead).
 */
function isWorkerStartingUp(): boolean {
  try {
    if (!existsSync(WORKER_PID_FILE)) return false;
    const stats = statSync(WORKER_PID_FILE);
    return (Date.now() - stats.mtimeMs) < PID_FILE_RECENT_THRESHOLD_MS;
  } catch {
    return false;
  }
}

/**
 * Ensure worker service is running.
 *
 * Makes up to 3 health check attempts within the HEALTH_CHECK_TIMEOUT_MS budget.
 * On first failure, checks whether a PID file exists and is recent:
 * - Recent PID file → worker is starting up, retry with 1s intervals
 * - No PID file or stale → worker needs spawn, return false immediately
 *
 * Total wall-clock time never exceeds HEALTH_CHECK_TIMEOUT_MS (default 3s).
 */
export async function ensureWorkerRunning(): Promise<boolean> {
  const startTime = Date.now();
  const maxAttempts = 3;
  const retryIntervalMs = 1000;
  const perAttemptTimeoutMs = Math.min(800, Math.floor(HEALTH_CHECK_TIMEOUT_MS / maxAttempts));

  // First attempt — quick health check
  try {
    const response = await workerHttpRequest('/api/health', { timeoutMs: perAttemptTimeoutMs });
    if (response.ok) {
      await checkWorkerVersion();
      return true;
    }
  } catch (e) {
    logger.debug('SYSTEM', 'Worker health check failed', {
      error: e instanceof Error ? e.message : String(e)
    });
  }

  // Check if worker is starting up (PID file recent) — worth retrying
  // If no PID file or stale, worker needs spawn, not retry
  if (!isWorkerStartingUp()) {
    logger.warn('SYSTEM', 'Worker not healthy and no recent PID file, hook will proceed gracefully');
    return false;
  }

  // Worker appears to be starting up — retry within remaining budget
  logger.debug('SYSTEM', 'Worker starting up (recent PID file), retrying health check');

  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const elapsed = Date.now() - startTime;
    const remaining = HEALTH_CHECK_TIMEOUT_MS - elapsed;

    if (remaining < perAttemptTimeoutMs) {
      break; // Not enough budget for another attempt
    }

    // Wait before retry (capped to leave room for the health check)
    const sleepTime = Math.min(retryIntervalMs, remaining - perAttemptTimeoutMs);
    if (sleepTime > 0) {
      await new Promise(resolve => setTimeout(resolve, sleepTime));
    }

    try {
      const attemptTimeout = Math.min(perAttemptTimeoutMs, HEALTH_CHECK_TIMEOUT_MS - (Date.now() - startTime));
      if (attemptTimeout <= 0) break;

      const response = await workerHttpRequest('/api/health', { timeoutMs: attemptTimeout });
      if (response.ok) {
        logger.debug('SYSTEM', 'Worker became healthy on retry', { attempt, elapsedMs: Date.now() - startTime });
        await checkWorkerVersion();
        return true;
      }
    } catch (e) {
      logger.debug('SYSTEM', `Worker health retry ${attempt} failed`, {
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - startTime
      });
    }
  }

  logger.warn('SYSTEM', 'Worker not healthy after startup retries, hook will proceed gracefully');
  return false;
}
