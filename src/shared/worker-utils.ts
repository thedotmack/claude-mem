import http from "http";
import path from "path";
import { readFileSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT } from "./paths.js";
import {
  resolveWorkerAddress,
  workerSocketExists,
  type WorkerAddress,
  type SocketAddress,
  type TcpAddress
} from "../supervisor/socket-manager.js";

// Re-export types for consumers
export type { WorkerAddress, SocketAddress, TcpAddress };

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
let cachedAddress: WorkerAddress | null = null;

/**
 * Get the resolved worker address (socket path or TCP host:port).
 *
 * Prefers Unix domain socket when available:
 *   - Socket file exists at ~/.claude-mem/sockets/worker.sock
 *   - Settings don't force TCP via CLAUDE_MEM_WORKER_TRANSPORT=tcp
 *   - Platform supports AF_UNIX
 *
 * Falls back to TCP (host:port) otherwise.
 * Caches the result to avoid repeated filesystem reads.
 */
export function getWorkerAddress(): WorkerAddress {
  if (cachedAddress !== null) {
    return cachedAddress;
  }

  cachedAddress = resolveWorkerAddress();
  return cachedAddress;
}

/**
 * Get the worker port number from settings
 * Uses CLAUDE_MEM_WORKER_PORT from settings file or default (37777)
 * Caches the port value to avoid repeated file reads
 *
 * Note: Kept for backwards compatibility. New code should use getWorkerAddress().
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
 *
 * Note: Kept for backwards compatibility. New code should use getWorkerAddress().
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
 * Clear the cached port, host, and address values.
 * Call this when settings are updated to force re-reading from file.
 */
export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
  cachedAddress = null;
}

/**
 * Build a full URL for a given API path, suitable for TCP connections.
 * For socket connections, use workerHttpRequest() instead.
 */
export function buildWorkerUrl(apiPath: string, address?: WorkerAddress): string {
  const addr = address ?? getWorkerAddress();
  if (addr.type === 'tcp') {
    return `http://${addr.host}:${addr.port}${apiPath}`;
  }
  // For socket mode, we still need a URL for the HTTP protocol layer.
  // Node's http.request() uses socketPath separately, but fetch() in
  // some runtimes doesn't support it. Use localhost as the Host header
  // placeholder — the actual routing happens via the socket file.
  return `http://localhost${apiPath}`;
}

/**
 * Make an HTTP request to the worker, supporting both Unix domain sockets and TCP.
 *
 * This is the preferred way for hooks to communicate with the worker.
 * For socket transport, uses Node's http.request() with socketPath.
 * For TCP transport, uses the global fetch() API.
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
  const address = getWorkerAddress();
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  if (address.type === 'socket') {
    return socketFetch(address.socketPath, apiPath, method, options.headers, options.body, timeoutMs);
  }

  // TCP mode — use standard fetch
  const url = `http://${address.host}:${address.port}${apiPath}`;
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
 * Perform an HTTP request over a Unix domain socket using Node's http module.
 * Returns a standard Response object for compatibility with existing code.
 */
function socketFetch(
  socketPath: string,
  apiPath: string,
  method: string,
  headers?: Record<string, string>,
  body?: string,
  timeoutMs?: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(
        () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    }

    const requestOptions: http.RequestOptions = {
      socketPath,
      path: apiPath,
      method,
      headers: {
        ...headers,
        // Host header is required by HTTP spec even for UDS
        Host: 'localhost'
      }
    };

    const req = http.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (timeoutId) clearTimeout(timeoutId);
        const responseBody = Buffer.concat(chunks).toString('utf-8');
        const status = res.statusCode ?? 500;

        // Build a standard Response object
        const response = new Response(responseBody, {
          status,
          statusText: res.statusMessage ?? '',
          headers: res.headers as Record<string, string>
        });
        resolve(response);
      });
    });

    req.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Check if worker HTTP server is responsive.
 * Uses /api/health (liveness) instead of /api/readiness because:
 * - Hooks have 15-second timeout, but full initialization can take 5+ minutes (MCP connection)
 * - /api/health returns 200 as soon as HTTP server is up (sufficient for hook communication)
 * - /api/readiness returns 503 until full initialization completes (too slow for hooks)
 * See: https://github.com/thedotmack/claude-mem/issues/811
 *
 * Supports both Unix domain socket and TCP transports.
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


/**
 * Ensure worker service is running
 * Quick health check - returns false if worker not healthy (doesn't block)
 * Port might be in use by another process, or worker might not be started yet
 *
 * Supports both Unix domain socket and TCP transports.
 */
export async function ensureWorkerRunning(): Promise<boolean> {
  // Quick health check (single attempt, no polling)
  try {
    if (await isWorkerHealthy()) {
      await checkWorkerVersion();  // logs warning on mismatch, doesn't restart
      return true;  // Worker healthy
    }
  } catch (e) {
    // Not healthy - log for debugging
    logger.debug('SYSTEM', 'Worker health check failed', {
      error: e instanceof Error ? e.message : String(e)
    });
  }

  // Port might be in use by something else, or worker not started
  // Return false but don't throw - let caller decide how to handle
  logger.warn('SYSTEM', 'Worker not healthy, hook will proceed gracefully');
  return false;
}
