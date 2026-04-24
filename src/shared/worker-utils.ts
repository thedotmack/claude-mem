import path from "path";
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { spawn, execSync } from "child_process";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, HOOK_EXIT_CODES, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT, DATA_DIR } from "./paths.js";
import { loadFromFileOnce } from "./hook-settings.js";
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

// ============================================================================
// Plan 05 Phase 9 — single per-process alive cache.
//
// One hook invocation may issue multiple worker requests (session-init issues
// several). The alive-state cannot change mid-invocation without the hook
// process exiting, so memoize the first result. By Principle 6 (one helper,
// N callers), this is the ONLY alive-state cache; all hook→worker call sites
// route through `executeWithWorkerFallback` (Phase 2) which calls this.
// ============================================================================

let aliveCache: boolean | null = null;

export async function ensureWorkerAliveOnce(): Promise<boolean> {
  if (aliveCache !== null) return aliveCache;
  aliveCache = await ensureWorkerRunning();
  return aliveCache;
}

// ============================================================================
// Plan 05 Phase 8 — fail-loud counter.
//
// The counter records how many consecutive hook invocations have seen the
// worker unreachable. After N (default 3) consecutive failures, the next
// hook exits code 2 so Claude Code's hook contract surfaces the outage to
// Claude. Below N, hooks exit 0 to avoid breaking the user's session.
//
// This is NOT a retry. We do not reinvoke `ensureWorkerAliveOnce` or
// reattempt the HTTP request. We record the result of the one primary-path
// attempt and either return (graceful) or escalate (fail-loud).
//
// File: ~/.claude-mem/state/hook-failures.json
// Atomic write: tmp + rename (POSIX atomic within a filesystem).
// ============================================================================

interface HookFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
}

const FAIL_LOUD_DEFAULT_THRESHOLD = 3;

function getStateDir(): string {
  return path.join(DATA_DIR, 'state');
}

function getHookFailuresPath(): string {
  return path.join(getStateDir(), 'hook-failures.json');
}

function readHookFailureState(): HookFailureState {
  try {
    const raw = readFileSync(getHookFailuresPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HookFailureState>;
    return {
      consecutiveFailures: typeof parsed.consecutiveFailures === 'number' && Number.isFinite(parsed.consecutiveFailures)
        ? Math.max(0, Math.floor(parsed.consecutiveFailures))
        : 0,
      lastFailureAt: typeof parsed.lastFailureAt === 'number' && Number.isFinite(parsed.lastFailureAt)
        ? parsed.lastFailureAt
        : 0,
    };
  } catch {
    // Missing file or corrupt JSON → fresh state.
    return { consecutiveFailures: 0, lastFailureAt: 0 };
  }
}

function writeHookFailureStateAtomic(state: HookFailureState): void {
  const stateDir = getStateDir();
  const dest = getHookFailuresPath();
  const tmp = `${dest}.tmp`;
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, dest);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to persist hook-failure counter', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getFailLoudThreshold(): number {
  try {
    const settings = loadFromFileOnce();
    const raw = settings.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  } catch {
    // settings unreadable — fall through to default
  }
  return FAIL_LOUD_DEFAULT_THRESHOLD;
}

/**
 * Record a worker-unreachable hook invocation. Returns the new counter value.
 * If the counter reaches the threshold, this function writes to stderr and
 * exits the process with code 2 (blocking error per Claude Code hook contract).
 *
 * Not a retry — does not reattempt the operation. The caller already ran the
 * single primary-path attempt and got `false` from `ensureWorkerAliveOnce`.
 */
function recordWorkerUnreachable(): number {
  const state = readHookFailureState();
  const next: HookFailureState = {
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: Date.now(),
  };
  writeHookFailureStateAtomic(next);

  const threshold = getFailLoudThreshold();
  if (next.consecutiveFailures >= threshold) {
    process.stderr.write(
      `claude-mem worker unreachable for ${next.consecutiveFailures} consecutive hooks.\n`
    );
    process.exit(HOOK_EXIT_CODES.BLOCKING_ERROR);
  }
  return next.consecutiveFailures;
}

/**
 * Reset the consecutive-failure counter. Called when the worker is alive,
 * acknowledging that any prior outage has ended. Not a retry — it is a
 * success-path acknowledgement.
 */
function resetWorkerFailureCounter(): void {
  const state = readHookFailureState();
  if (state.consecutiveFailures === 0) return;       // skip a no-op write
  writeHookFailureStateAtomic({ consecutiveFailures: 0, lastFailureAt: 0 });
}

// ============================================================================
// Plan 05 Phase 2 — `executeWithWorkerFallback(url, method, body)`.
//
// Eight handlers used to duplicate the
// `ensureWorkerRunning() → workerHttpRequest() → if (!ok) return { continue: true }`
// sequence. This helper is the ONE implementation; eight handlers import it.
//
// Behavior:
//   1. ensureWorkerAliveOnce() (Phase 9). If false → fail-loud counter
//      (Phase 8). May process.exit(2). Otherwise return graceful fallback.
//   2. workerHttpRequest(url, method, body). Parse JSON.
//   3. On success, reset the fail-loud counter.
//
// No retry inside this helper. No timeout-and-exit-0 swallow. The fail-loud
// counter records consecutive invocation outcomes; it does not reinvoke work.
// ============================================================================

// Branded sentinel so isWorkerFallback cannot false-positive on legitimate
// API responses that happen to carry `continue: true` in their own schema.
const WORKER_FALLBACK_BRAND: unique symbol = Symbol.for('claude-mem/worker-fallback');

export type WorkerFallback =
  | { continue: true; [WORKER_FALLBACK_BRAND]: true }
  | { continue: true; reason: string; [WORKER_FALLBACK_BRAND]: true };

export type WorkerCallResult<T> = T | WorkerFallback;

export function isWorkerFallback<T>(result: WorkerCallResult<T>): result is WorkerFallback {
  return typeof result === 'object'
    && result !== null
    && (result as { [WORKER_FALLBACK_BRAND]?: unknown })[WORKER_FALLBACK_BRAND] === true;
}

export interface WorkerFallbackOptions {
  /**
   * Per-call HTTP timeout in ms. Forwarded to workerHttpRequest. Omit to use
   * HEALTH_CHECK_TIMEOUT_MS (the default ~3 s suitable for short pings).
   * Long-lived endpoints like POST /api/session/end (server holds up to
   * SessionRoutes.SERVER_SIDE_SUMMARY_TIMEOUT_MS = 30_000) MUST set this
   * above the server-side hold window, or the client will race to a spurious
   * timeout and treat the worker as unreachable.
   */
  timeoutMs?: number;
}

export async function executeWithWorkerFallback<T = unknown>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  options: WorkerFallbackOptions = {},
): Promise<WorkerCallResult<T>> {
  const alive = await ensureWorkerAliveOnce();
  if (!alive) {
    // Records and possibly process.exit(2). If we return below, the counter
    // is below threshold, the user's session continues uninterrupted.
    recordWorkerUnreachable();
    return { continue: true, reason: 'worker_unreachable', [WORKER_FALLBACK_BRAND]: true };
  }

  const init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (options.timeoutMs !== undefined) {
    init.timeoutMs = options.timeoutMs;
  }

  const response = await workerHttpRequest(url, init);
  if (!response.ok) {
    // Non-2xx is a real worker response (so the worker IS reachable). Reset
    // the consecutive-failures counter; surface the response body to the
    // caller as a typed value via T's caller-controlled shape. Callers that
    // care about non-2xx must inspect the value (or wrap with their own
    // status check); the helper does not silently coerce non-2xx into a
    // graceful fallback.
    resetWorkerFailureCounter();
    const text = await response.text().catch(() => '');
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    return parsed as T;
  }

  resetWorkerFailureCounter();
  const text = await response.text();
  if (text.length === 0) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
