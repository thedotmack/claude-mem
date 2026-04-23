import path from "path";
import { readFileSync, existsSync } from "fs";
import { spawn, execSync } from "child_process";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT } from "./paths.js";
// `validateWorkerPidFile` consults `captureProcessStartToken` at
// `src/supervisor/process-registry.ts` for PID-reuse detection (commit
// 99060bac). The lazy-spawn fast path below uses it to confirm a live port
// is owned by OUR worker incarnation rather than a stale PID squatting on
// the port after container restart.
import { validateWorkerPidFile } from "../supervisor/index.js";

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
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
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
  let pluginVersion: string;
  try {
    pluginVersion = getPluginVersion();
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Version check failed reading plugin version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  // Skip version check if plugin version couldn't be read (shutdown race)
  if (pluginVersion === 'unknown') return;

  let workerVersion: string;
  try {
    workerVersion = await getWorkerVersion();
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Version check failed reading worker version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

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
}


/**
 * Resolve the absolute path to the worker-service script the hook should
 * relaunch as a detached daemon. Hooks live in the plugin's `scripts/`
 * directory next to `worker-service.cjs`; production and dev checkouts both
 * ship the bundled CJS there. Returns null when no candidate exists on disk
 * (partial install, build artifact missing).
 */
function resolveWorkerScriptPath(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs'),
    path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the absolute path to the Bun runtime.
 *
 * Local to worker-utils.ts so the lazy-spawn path does not transitively
 * import `services/infrastructure/ProcessManager.ts` — that module pulls
 * in `bun:sqlite` via `cwd-remap`, and pulling it in would break the NPX
 * CLI bundle which must run under plain Node (no Bun). The worker daemon
 * itself requires Bun (it uses bun:sqlite directly); this lookup finds
 * the Bun binary that the daemon will execute under.
 */
function resolveBunRuntime(): string | null {
  if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN;

  try {
    const cmd = process.platform === 'win32' ? 'where bun' : 'which bun';
    const output = execSync(cmd, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true,
    });
    const firstMatch = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.length > 0);
    return firstMatch || null;
  } catch {
    return null;
  }
}

/**
 * Wait for the worker port to open, using exponential backoff.
 *
 * Deliberately hand-rolled — `respawn` or similar npm helpers add a
 * supervisor semantic layer we do not want here (Principle 6). The retry
 * policy is three attempts with 250ms → 500ms → 1000ms backoff, which is
 * enough to cover the worker's start-up (~1-2s on a warm cache, slower on
 * Windows) without blocking a hook for long when the spawn outright failed.
 */
async function waitForWorkerPort(options: { attempts: number; backoffMs: number }): Promise<boolean> {
  let delayMs = options.backoffMs;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (await isWorkerPortAlive()) return true;
    if (attempt < options.attempts) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
  return false;
}

/**
 * Is the worker port owned by a live worker we recognize?
 *
 * Two gates:
 *   1. HTTP /api/health returns 200, AND
 *   2. PID-file start-token check (via `validateWorkerPidFile` →
 *      `captureProcessStartToken`) confirms the recorded PID has not been
 *      reused by a different process since the file was written.
 *
 * When the PID file is missing we accept a healthy HTTP response on its own
 * — the file is written by the worker itself after `listen()` succeeds, so
 * a brief window exists during which a freshly-spawned worker is reachable
 * via HTTP but has not yet persisted its PID record. Treating this as
 * "not ours" would cause the hook to double-spawn in a race with the
 * worker's own PID-file write.
 *
 * An 'alive' status that fails identity verification is treated as dead so
 * the caller falls through to the spawn path (Phase 8 contract).
 */
async function isWorkerPortAlive(): Promise<boolean> {
  let healthy: boolean;
  try {
    healthy = await isWorkerHealthy();
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Worker health check threw', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!healthy) return false;

  const pidStatus = validateWorkerPidFile({ logAlive: false });
  if (pidStatus === 'missing') return true;     // race: listening before PID file written
  if (pidStatus === 'alive') return true;       // identity verified via start-token
  return false;                                 // 'stale' | 'invalid' — PID reused
}

/**
 * Lazy-spawn the worker if it is not already running, then wait for its port.
 *
 * Flow:
 *   1. If the port is alive AND verified as ours, return true (fast path).
 *   2. Otherwise, resolve the bun runtime + worker script path.
 *   3. Spawn detached, `unref()` so the hook's exit does not take the worker
 *      down with it (the worker lives as its own independent daemon).
 *   4. Wait for the port to come up, up to 3 attempts with exponential
 *      backoff (250ms → 500ms → 1000ms — ~1.75s total).
 *
 * PID-reuse safety is inherited from `validateWorkerPidFile` (commit
 * 99060bac) — see the `isWorkerPortAlive` comment above. There is no
 * auto-restart loop; failure is reported via the return value so the hook
 * can surface it through exit code 2 (Principle 2 — fail-fast).
 */
export async function ensureWorkerRunning(): Promise<boolean> {
  if (await isWorkerPortAlive()) {
    await checkWorkerVersion();
    return true;
  }

  const runtimePath = resolveBunRuntime();
  const scriptPath = resolveWorkerScriptPath();

  if (!runtimePath) {
    logger.warn('SYSTEM', 'Cannot lazy-spawn worker: Bun runtime not found on PATH');
    return false;
  }
  if (!scriptPath) {
    logger.warn('SYSTEM', 'Cannot lazy-spawn worker: worker-service.cjs not found in plugin/scripts');
    return false;
  }

  logger.info('SYSTEM', 'Worker not running — lazy-spawning', { runtimePath, scriptPath });

  try {
    const proc = spawn(runtimePath, [scriptPath, '--daemon'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error('SYSTEM', 'Lazy-spawn of worker failed', { runtimePath, scriptPath }, error);
    } else {
      logger.error('SYSTEM', 'Lazy-spawn of worker failed (non-Error)', {
        runtimePath, scriptPath, error: String(error),
      });
    }
    return false;
  }

  const alive = await waitForWorkerPort({ attempts: 3, backoffMs: 250 });
  if (!alive) {
    logger.warn('SYSTEM', 'Worker port did not open after lazy-spawn within 3 attempts');
    return false;
  }
  return true;
}
