import path from "path";
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { spawnHidden } from "./spawn.js";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT, DATA_DIR } from "./paths.js";
import { loadFromFileOnce } from "./hook-settings.js";
import { validateWorkerPidFile } from "../supervisor/index.js";
import { emitDiagnostic } from "./hook-io.js";
import { captureCliEvent } from "../services/telemetry/cli-telemetry.js";
import { checkVersionMatch } from "../services/infrastructure/HealthMonitor.js";
// Imported from ProcessManager.js directly (not the infrastructure barrel):
// tests mock the barrel module wholesale, and the resolver must stay real.
// ProcessManager imports nothing from worker-utils, so no cycle.
import { resolveWorkerRuntimePath } from "../services/infrastructure/ProcessManager.js";
import { acquireSpawnLock, releaseSpawnLock } from "./worker-spawn-gate.js";

function readTimeoutEnv(
  envName: string,
  defaultValue: number,
  bounds: { min: number; max: number }
): number {
  const envVal = process.env[envName];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
      return parsed;
    }
    logger.warn('SYSTEM', `Invalid ${envName}, using default`, {
      value: envVal, min: bounds.min, max: bounds.max
    });
  }
  return defaultValue;
}

const HEALTH_CHECK_TIMEOUT_MS = readTimeoutEnv(
  'CLAUDE_MEM_HEALTH_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK),
  { min: 500, max: 300000 }
);

const HOOK_READINESS_TIMEOUT_MS = readTimeoutEnv(
  'CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.HOOK_READINESS_WAIT),
  { min: 0, max: 300000 }
);

const API_REQUEST_TIMEOUT_BOUNDS = { min: 500, max: 300000 } as const;

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  try {
    // AbortSignal.timeout (Node 18+) replaces the manual setTimeout/clearTimeout
    // race. On expiry it aborts with a TimeoutError DOMException.
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: unknown) {
    // Preserve the historical timeout-error message ("...timed out...") that
    // callers match on (hook-command.ts, server-beta-client.ts) — the
    // DOMException text is runtime-dependent, so normalize it here.
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

let cachedPort: number | null = null;
let cachedHost: string | null = null;
let cachedSettings: SettingsDefaults | null = null;
let cachedApiRequestTimeoutMs: number | null = null;

function getWorkerSettingsPath(): string {
  return path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
}

function getWorkerSettings(): SettingsDefaults {
  if (cachedSettings !== null) {
    return cachedSettings;
  }

  cachedSettings = SettingsDefaultsManager.loadFromFile(getWorkerSettingsPath());
  return cachedSettings;
}

function parseBoundedTimeout(
  rawValue: string | undefined,
  bounds: { min: number; max: number }
): number | null {
  if (!rawValue) return null;
  const parsed = parseInt(rawValue, 10);
  if (Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
    return parsed;
  }
  return null;
}

function readSettingsBackedTimeout(
  settingName: keyof SettingsDefaults,
  defaultValue: number,
  bounds: { min: number; max: number }
): number {
  const envVal = process.env[settingName];
  if (envVal !== undefined) {
    const parsed = parseBoundedTimeout(envVal, bounds);
    if (parsed !== null) {
      return parsed;
    }
    logger.warn('SYSTEM', `Invalid ${settingName}, using default`, {
      value: envVal, min: bounds.min, max: bounds.max
    });
    return defaultValue;
  }

  const settingsValue = getWorkerSettings()[settingName];
  const parsed = parseBoundedTimeout(settingsValue, bounds);
  if (parsed !== null) {
    return parsed;
  }

  logger.warn('SYSTEM', `Invalid ${settingName} in settings.json, using default`, {
    value: settingsValue, min: bounds.min, max: bounds.max
  });
  return defaultValue;
}

export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settings = getWorkerSettings();
  cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settings = getWorkerSettings();
  cachedHost = settings.CLAUDE_MEM_WORKER_HOST;
  return cachedHost;
}

export function getWorkerApiRequestTimeoutMs(): number {
  if (cachedApiRequestTimeoutMs !== null) {
    return cachedApiRequestTimeoutMs;
  }

  cachedApiRequestTimeoutMs = readSettingsBackedTimeout(
    'CLAUDE_MEM_API_TIMEOUT_MS',
    getTimeout(HOOK_TIMEOUTS.API_REQUEST),
    API_REQUEST_TIMEOUT_BOUNDS
  );
  return cachedApiRequestTimeoutMs;
}

export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
  cachedSettings = null;
  cachedApiRequestTimeoutMs = null;
}

export function formatHostForUrl(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

export function buildWorkerUrl(apiPath: string): string {
  return `http://${formatHostForUrl(getWorkerHost())}:${getWorkerPort()}${apiPath}`;
}

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
  const timeoutMs = options.timeoutMs ?? getWorkerApiRequestTimeoutMs();

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

async function isWorkerHealthy(): Promise<boolean> {
  const response = await workerHttpRequest('/api/health', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  return response.ok;
}

async function isWorkerReady(): Promise<boolean> {
  const response = await workerHttpRequest('/api/readiness', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  return response.ok;
}

function candidateWorkerScriptPath(root: string): string {
  const pluginRoot = existsSync(path.join(root, 'plugin', 'scripts'))
    ? path.join(root, 'plugin')
    : root;
  return path.join(pluginRoot, 'scripts', 'worker-service.cjs');
}

function cacheWorkerScriptCandidates(): string[] {
  const pluginsRoot = path.dirname(path.dirname(MARKETPLACE_ROOT));
  const cacheRoot = path.join(pluginsRoot, 'cache', 'thedotmack', 'claude-mem');
  try {
    return readdirSync(cacheRoot)
      .filter(name => /^\d/.test(name))
      .map(name => path.join(cacheRoot, name))
      .filter(candidate => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .map(candidateWorkerScriptPath);
  } catch {
    return [];
  }
}

/**
 * Canonical worker-script resolver. The opt-in override exists for local
 * testing; otherwise mirror the host hook resolver's cache-before-marketplace
 * order so cache, marketplace, MCP, and worker restart launches converge on a
 * single worker identity.
 */
export function resolveWorkerScriptPath(): string | null {
  const override = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH?.trim();
  if (override) {
    if (existsSync(override)) return override;
    logger.debug('SYSTEM', 'Ignoring missing CLAUDE_MEM_WORKER_SCRIPT_PATH override', { override });
  }

  const candidates = [
    ...cacheWorkerScriptCandidates(),
    candidateWorkerScriptPath(path.join(MARKETPLACE_ROOT, 'plugin')),
    path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

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

async function waitForWorkerReadiness(timeoutMs: number = HOOK_READINESS_TIMEOUT_MS): Promise<boolean> {
  if (timeoutMs <= 0) {
    try {
      return await isWorkerReady();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.debug('SYSTEM', 'Worker readiness check threw', {}, err);
      return false;
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await isWorkerReady()) return true;
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Worker readiness check threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const remainingMs = timeoutMs - (Date.now() - start);
    if (remainingMs <= 0) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, remainingMs)));
  }
  return false;
}

/**
 * Read the version the worker self-reports on GET /api/health. The payload
 * carries pid/version even on a 503 (degraded queue) response, so the body is
 * parsed regardless of status — same contract as restart-verify.ts. Returns
 * null when the worker is unreachable or the payload is malformed.
 */
async function fetchWorkerHealthVersion(): Promise<string | null> {
  try {
    const response = await workerHttpRequest('/api/health', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
    const body = await response.json() as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug('SYSTEM', 'Worker health-version fetch failed', {}, err);
    return null;
  }
}

/**
 * After POSTing /api/admin/restart, the OLD worker spawns its own successor
 * once its port closes (runShutdownSequence in src/services/worker-shutdown.ts;
 * plans/2026-06-10-worker-restart-single-source-of-truth.md). Wait for that
 * successor — a worker answering /api/health with the installed plugin's
 * version — instead of immediately lazy-spawning into the dying worker
 * (the old behavior, which caused the spawn ping-pong).
 */
async function waitForRecycledWorker(
  pluginVersion: string,
  timeoutMs: number = HOOK_READINESS_TIMEOUT_MS
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const observedVersion = await fetchWorkerHealthVersion();
    if (observedVersion === pluginVersion) return true;

    const remainingMs = timeoutMs - (Date.now() - start);
    if (remainingMs <= 0) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(500, remainingMs)));
  }
  return false;
}

/**
 * Amplifier guard: a hook recycles a stale worker AT MOST once per
 * invocation. If the worker that became ready still reports a mismatched
 * version, warn and return — the NEXT hook event retries. Recycling again in
 * the same invocation re-creates the restart storm.
 */
async function warnIfVersionStillMismatched(expectedPluginVersion: string): Promise<void> {
  const observedVersion = await fetchWorkerHealthVersion();
  if (observedVersion !== null && observedVersion !== expectedPluginVersion) {
    logger.warn('SYSTEM', 'Worker is ready but still reports a stale version; not recycling again in this hook invocation (one recycle per hook event)', {
      pluginVersion: expectedPluginVersion,
      workerVersion: observedVersion,
    });
  }
}

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
  if (pidStatus === 'missing') return true;
  if (pidStatus === 'alive') return true;
  return false;
}

export interface EnsureWorkerRunningOptions {
  allowLazySpawn?: boolean;
}

export async function ensureWorkerRunning(options: EnsureWorkerRunningOptions = {}): Promise<boolean> {
  const allowLazySpawn = options.allowLazySpawn !== false;
  // Installed-plugin version captured when the alive branch runs, so every
  // post-readiness path below can run the one-shot amplifier check
  // (warnIfVersionStillMismatched). Stays null when no worker was alive
  // (plain cold-start lazy-spawn — no recycle happened, nothing to amplify)
  // or when the plugin version is unreadable ('unknown').
  let expectedPluginVersion: string | null = null;

  if (await isWorkerPortAlive()) {
    // A worker is already alive. If it is a DIFFERENT version than the
    // installed plugin (e.g. the user upgraded but the previous worker is
    // still squatting the port), recycle it so the current version takes
    // over — otherwise the stale worker keeps serving indefinitely.
    const { matches, pluginVersion, workerVersion } = await checkVersionMatch(getWorkerPort());
    if (pluginVersion !== 'unknown') {
      expectedPluginVersion = pluginVersion;
    }
    if (matches) {
      const ready = await waitForWorkerReadiness();
      if (!ready) {
        logger.warn('SYSTEM', 'Worker is healthy but not ready; skipping hook API call');
        return false;
      }
      if (expectedPluginVersion !== null) {
        await warnIfVersionStillMismatched(expectedPluginVersion);
      }
      return true;
    }

    logger.info('SYSTEM', 'Worker version mismatch — recycling stale worker', {
      pluginVersion,
      workerVersion,
    });
    // Only the restart POST itself can throw here (the waits below swallow
    // their own probe errors); on failure skip the successor wait and fall
    // through to lazy-spawn.
    let restartRequested = false;
    try {
      await workerHttpRequest('/api/admin/restart', {
        method: 'POST',
        timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
      });
      restartRequested = true;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.debug('SYSTEM', 'Worker restart request failed; falling through to lazy-spawn', {}, err);
    }
    if (restartRequested) {
      // Do NOT lazy-spawn immediately after the POST — the old worker is
      // still dying and owns the port, so a spawn here races the corpse (the
      // observed restart ping-pong). The dying worker spawns its own
      // successor once its port closes (worker-shutdown.ts; see
      // plans/2026-06-10-worker-restart-single-source-of-truth.md); wait for
      // that successor and only fall through to lazy-spawn as the safety net
      // when it never appears.
      if (await waitForRecycledWorker(pluginVersion)) {
        const ready = await waitForWorkerReadiness();
        if (!ready) {
          logger.warn('SYSTEM', 'Recycled worker appeared but did not become ready; skipping hook API call');
          return false;
        }
        if (expectedPluginVersion !== null) {
          await warnIfVersionStillMismatched(expectedPluginVersion);
        }
        return true;
      }
      logger.warn('SYSTEM', 'No successor worker appeared after recycle; falling through to lazy-spawn', {
        pluginVersion,
        workerVersion,
      });
    }
    // Fall through to (re)spawn + readiness wait below.
  }

  if (!allowLazySpawn) {
    logger.info('SYSTEM', 'Worker not already healthy; skipping lazy-spawn for best-effort hook call');
    return false;
  }

  const runtimePath = resolveWorkerRuntimePath();
  const scriptPath = resolveWorkerScriptPath();

  if (!runtimePath) {
    logger.warn('SYSTEM', 'Cannot lazy-spawn worker: Bun runtime not found on PATH');
    return false;
  }
  if (!scriptPath) {
    logger.warn('SYSTEM', 'Cannot lazy-spawn worker: worker-service.cjs not found in plugin/scripts');
    return false;
  }

  // Spawn gate (worker-spawn-gate.ts): only ONE gated launcher — hook, MCP
  // server, or the CLI restart fallback — may spawn at a time. (The dying
  // worker's restart handoff in worker-shutdown.ts is deliberately NOT gated:
  // it is the primary spawner on restart, and hooks wait for its successor.)
  // Losing the lock never fails the hook; the loser skips its spawn and waits
  // for the winner's worker on the existing port/readiness waits below. The
  // winner holds the lock through the port-open wait (the spawn isn't "done"
  // until the worker owns the port) and releases in finally on every exit
  // path.
  const spawnLockHeld = acquireSpawnLock();
  try {
    if (spawnLockHeld) {
      logger.info('SYSTEM', 'Worker not running — lazy-spawning', { runtimePath, scriptPath });

      try {
        const proc = spawnHidden(runtimePath, [scriptPath, '--daemon'], {
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
    } else {
      logger.info('SYSTEM', 'Another launcher holds the spawn lock — skipping lazy-spawn and waiting for its worker');
    }

    // Cold boot (#2795): on the first session after a reboot the SessionStart
    // `start` hook is booting the daemon in parallel, and a cold macOS+Chroma
    // worker needs ~7s to bind. The old 3-attempt/250ms budget (~0.75s) expired
    // long before that, so the context (and session-init) hooks raced boot and
    // soft-failed to empty — dropping memory injection and the user_prompts row
    // (the upstream trigger for #2794). Wait up to ~15.5s (≈ POST_SPAWN_WAIT) so
    // whichever worker wins the port is seen before we give up.
    const alive = await waitForWorkerPort({ attempts: 6, backoffMs: 500 });
    if (!alive) {
      logger.warn('SYSTEM', spawnLockHeld
        ? 'Worker port did not open after lazy-spawn within the cold-boot wait (~15s)'
        : 'Spawn-lock holder\'s worker port did not open within the cold-boot wait (~15s)');
      return false;
    }
  } finally {
    if (spawnLockHeld) releaseSpawnLock();
  }
  const ready = await waitForWorkerReadiness();
  if (!ready) {
    logger.warn('SYSTEM', 'Worker lazy-spawned but did not become ready before hook readiness timeout');
    return false;
  }
  // Amplifier guard: even if the worker that won the port is still stale,
  // never recycle a second time in the same hook invocation.
  if (expectedPluginVersion !== null) {
    await warnIfVersionStillMismatched(expectedPluginVersion);
  }
  return true;
}

let aliveCache: boolean | null = null;

/** Test-only: reset the ensureWorkerAliveOnce() cache (mirrors clearPortCache). */
export function resetAliveCache(): void {
  aliveCache = null;
}

export async function ensureWorkerAliveOnce(): Promise<boolean> {
  if (aliveCache !== null) return aliveCache;
  // Opt-out: when CLAUDE_MEM_WORKER_AUTOSTART=false, hooks must NOT lazy-spawn
  // the worker daemon. Lets server-beta-only or externally-managed deployments
  // stop hook activity from resurrecting the worker. Default 'true' preserves
  // existing behavior.
  if ((loadFromFileOnce().CLAUDE_MEM_WORKER_AUTOSTART ?? 'true').trim().toLowerCase() === 'false') {
    aliveCache = false;
    return aliveCache;
  }
  aliveCache = await ensureWorkerRunning();
  return aliveCache;
}

interface HookFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
}

// #2996: Platform-specific fail-loud threshold
// This constant is the FALLBACK when settings.json has no explicit value.
// SettingsDefaultsManager keeps the default at '3' for backward compatibility
// (so existing settings.json files aren't affected), but on Windows we want
// a higher threshold (10) to handle zombie worker recovery.
// Windows (all versions: 10, 11, and future): TCP port conflicts are common due to
// zombie worker processes that hold ports after crashes. Multi-window Claude Code
// sessions frequently trigger this. A higher threshold (10) gives the worker ~30-60s
// to self-heal before blocking prompts.
// Linux/macOS: Port conflicts are rare (SO_REUSEADDR behavior is more permissive,
// process cleanup is cleaner). The original threshold (3) provides faster failure
// detection for genuine worker issues.
// Note: process.platform === 'win32' matches Windows 10, 11, and all future versions.
const FAIL_LOUD_DEFAULT_THRESHOLD = process.platform === 'win32' ? 10 : 3;

function getStateDir(): string {
  return path.join(DATA_DIR, 'state');
}

function getHookFailuresPath(): string {
  return path.join(getStateDir(), 'hook-failures.json');
}

function getHooksDisabledPath(): string {
  return path.join(getStateDir(), 'hooks-disabled-until.json');
}

function readHookFailureState(): HookFailureState {
  try {
    return parseHookFailureState(readFileSync(getHookFailuresPath(), 'utf-8'));
  } catch {
    // [ANTI-PATTERN IGNORED]: the failure-counter state file is optional and
    // absent (ENOENT) on every hook run until the first worker failure, so
    // logging here would fire on effectively every healthy invocation; the
    // recovery is the zeroed default state below.
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
  // #2996: distinguish user-explicit threshold from SettingsDefaultsManager defaults.
  // 1. Check environment variable first (highest priority).
  const envRaw = process.env.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD;
  if (envRaw !== undefined) {
    const envParsed = parseInt(envRaw, 10);
    if (Number.isFinite(envParsed) && envParsed >= 1) return envParsed;
  }

  // 2. Read the raw settings file to check if user explicitly set the key.
  // 'auto' is the sentinel default written by SettingsDefaultsManager.
  // Any other value (including legacy "3" from older defaults) is treated
  // as user-explicit and used directly.
  try {
    if (existsSync(USER_SETTINGS_PATH)) {
      const raw = readFileSync(USER_SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const flatSettings = settings.env && typeof settings.env === 'object'
        ? { ...settings.env, ...settings }
        : settings;
      if ('CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD' in flatSettings) {
        const rawValue = String(flatSettings.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD);
        // 'auto' is the sentinel default — fall through to platform fallback.
        // Any other value (including '3') is treated as user-explicit.
        if (rawValue !== 'auto') {
          const parsed = parseInt(rawValue, 10);
          if (Number.isFinite(parsed) && parsed >= 1) return parsed;
        }
      }
    }
  } catch {
    // settings unreadable — fall through to default
  }

  // 3. No explicit value found; use platform-specific fallback.
  return FAIL_LOUD_DEFAULT_THRESHOLD;
}

/**
 * Closed enum of hook handler names allowed as the `hook_type` telemetry
 * property. Mirrors the scrub whitelist comment (scrub.ts), the CLI
 * disclosure (npx-cli/commands/telemetry.ts), and docs/public/telemetry.mdx —
 * never widen one without the others. Events outside this set (user-message,
 * file-edit) simply omit hook_type.
 */
const TELEMETRY_HOOK_TYPES = ['context', 'session-init', 'observation', 'summarize', 'file-context'] as const;
export type TelemetryHookType = (typeof TELEMETRY_HOOK_TYPES)[number];

let activeHookType: TelemetryHookType | null = null;

/**
 * Record which hook event this short-lived hook process is executing, so the
 * fail-loud counter can tag its threshold-gated hook_failed telemetry.
 * Called once at hookCommand entry; values outside the closed enum are
 * dropped (never free text).
 */
export function setActiveHookType(event: string): void {
  activeHookType = (TELEMETRY_HOOK_TYPES as readonly string[]).includes(event)
    ? (event as TelemetryHookType)
    : null;
}

export function getActiveHookType(): TelemetryHookType | null {
  return activeHookType;
}

let activePlatform: string | null = null;

/**
 * Record the host platform for the current hook invocation. On Kiro CLI,
 * exit 2 has host-side semantics claude-mem must never trigger (preToolUse
 * exit 2 blocks the user's tool call), so the fail-loud paths degrade to
 * stderr diagnostics + exit 0 there. Called once at hookCommand entry.
 */
export function setActivePlatform(platform: string): void {
  activePlatform = platform;
}

export function activePlatformNeverBlocks(): boolean {
  return activePlatform === 'kiro' || activePlatform === 'kiro-cli';
}

export async function recordWorkerUnreachable(): Promise<number> {
  const state = readHookFailureState();
  const next: HookFailureState = {
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: Date.now(),
  };
  writeHookFailureStateAtomic(next);

  const threshold = getFailLoudThreshold();
  if (next.consecutiveFailures >= threshold) {
    // DIAGNOSTIC only — never block the harness for an optional background service.
    // Callers surface user-facing banners via consumeWorkerOutageHint + withUserHint.
    if (next.consecutiveFailures === threshold) {
      await captureCliEvent('hook_failed', {
        ...(activeHookType !== null ? { hook_type: activeHookType } : {}),
        error_mode: 'worker_unavailable',
        consecutive_failures: next.consecutiveFailures,
        threshold_tripped: true,
      });
    }
    emitDiagnostic(
      `claude-mem worker unreachable for ${next.consecutiveFailures} consecutive hooks.\n`
    );
  }
  return next.consecutiveFailures;
}

function resetWorkerFailureCounter(): void {
  const state = readHookFailureState();
  if (state.consecutiveFailures === 0) return;
  writeHookFailureStateAtomic({ consecutiveFailures: 0, lastFailureAt: 0 });
  try {
    const sentinelPath = getHooksDisabledPath();
    if (existsSync(sentinelPath)) unlinkSync(sentinelPath);
  } catch {
    // Best-effort cleanup.
  }
}

function writeHooksDisabledSentinel(): void {
  const stateDir = getStateDir();
  const dest = getHooksDisabledPath();
  const tmp = `${dest}.tmp`;
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    const payload = { disabledAt: Date.now() };
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    renameSync(tmp, dest);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to write hooks-disabled sentinel', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function areHooksDisabledForSession(): boolean {
  try {
    const raw = readFileSync(getHooksDisabledPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { disabledAt?: number };
    if (typeof parsed.disabledAt !== 'number') return false;
    const DISABLED_TTL_MS = 30 * 60 * 1000;
    return Date.now() - parsed.disabledAt < DISABLED_TTL_MS;
  } catch {
    return false;
  }
}

interface OutageWarningState {
  lastWarnedAt: number;
  lastSessionId?: string;
}

function getOutageWarningPath(): string {
  return path.join(getStateDir(), 'last-outage-warning.json');
}

function readOutageWarningState(): OutageWarningState {
  try {
    const parsed = JSON.parse(readFileSync(getOutageWarningPath(), 'utf-8')) as Partial<OutageWarningState>;
    return {
      lastWarnedAt: typeof parsed.lastWarnedAt === 'number' ? parsed.lastWarnedAt : 0,
      lastSessionId: typeof parsed.lastSessionId === 'string' ? parsed.lastSessionId : undefined,
    };
  } catch {
    return { lastWarnedAt: 0 };
  }
}

function writeOutageWarningStateAtomic(state: OutageWarningState): void {
  const stateDir = getStateDir();
  const dest = getOutageWarningPath();
  const tmp = `${dest}.tmp`;
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, dest);
  } catch {
    // Best effort only; a failed write can at worst show the banner again.
  }
}

const OUTAGE_BANNER_THROTTLE_MS = 30 * 60 * 1000;
const WORKER_OFFLINE_BANNER =
  'claude-mem: background worker offline — memory features (search, observations, context) unavailable this session.';

export function consumeWorkerOutageHint(sessionId?: string, bypassThrottle = false): string | null {
  const failures = readHookFailureState();
  if (failures.consecutiveFailures === 0) return null;

  const warned = readOutageWarningState();
  const now = Date.now();
  const sameSession = sessionId !== undefined && warned.lastSessionId === sessionId;
  const withinThrottle = (now - warned.lastWarnedAt) < OUTAGE_BANNER_THROTTLE_MS;
  if (!bypassThrottle && sameSession && withinThrottle) return null;

  writeOutageWarningStateAtomic({ lastWarnedAt: now, lastSessionId: sessionId });
  return WORKER_OFFLINE_BANNER;
}

interface OutageWarningState {
  lastWarnedAt: number;
  lastSessionId?: string;
}

function getOutageWarningPath(): string {
  return path.join(getStateDir(), 'last-outage-warning.json');
}

function readOutageWarningState(): OutageWarningState {
  try {
    const raw = readFileSync(getOutageWarningPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OutageWarningState>;
    return {
      lastWarnedAt: typeof parsed.lastWarnedAt === 'number' ? parsed.lastWarnedAt : 0,
      lastSessionId: typeof parsed.lastSessionId === 'string' ? parsed.lastSessionId : undefined,
    };
  } catch {
    return { lastWarnedAt: 0 };
  }
}

function writeOutageWarningStateAtomic(state: OutageWarningState): void {
  const dest = getOutageWarningPath();
  const tmp = `${dest}.tmp`;
  const stateDir = getStateDir();
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, dest);
  } catch {
    // non-fatal — worst case we emit a duplicate banner
  }
}

const OUTAGE_BANNER_THROTTLE_MS = 30 * 60 * 1000;
const WORKER_OFFLINE_BANNER =
  'claude-mem: background worker offline — memory features (search, observations, context) unavailable this session.';

/**
 * Returns the user-facing offline banner string when the worker is unreachable
 * and the throttle window has elapsed (or it's a new session). Returns null if
 * the banner was already shown recently.
 *
 * Pass `bypassThrottle: true` for session-start hooks where the banner should
 * always appear if the worker is down.
 */
export function consumeWorkerOutageHint(
  sessionId?: string,
  bypassThrottle = false,
): string | null {
  const failures = readHookFailureState();
  if (failures.consecutiveFailures === 0) return null;

  const warned = readOutageWarningState();
  const now = Date.now();
  const sameSession = sessionId && warned.lastSessionId === sessionId;
  const withinThrottle = (now - warned.lastWarnedAt) < OUTAGE_BANNER_THROTTLE_MS;

  if (!bypassThrottle && sameSession && withinThrottle) return null;

  writeOutageWarningStateAtomic({ lastWarnedAt: now, lastSessionId: sessionId });
  return WORKER_OFFLINE_BANNER;
}

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
  timeoutMs?: number;
  allowLazySpawn?: boolean;
}

export async function executeWithWorkerFallback<T = unknown>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  options: WorkerFallbackOptions = {},
): Promise<WorkerCallResult<T>> {
  const hooksDisabledForSession = areHooksDisabledForSession();
  const alive = await ensureWorkerAliveOnce();
  if (!alive) {
    if (hooksDisabledForSession) {
      return { continue: true, reason: 'hooks_disabled_session', [WORKER_FALLBACK_BRAND]: true };
    }
    await recordWorkerUnreachable();
    return { continue: true, reason: 'worker_unreachable', [WORKER_FALLBACK_BRAND]: true };
  }

  if (hooksDisabledForSession) {
    resetWorkerFailureCounter();
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
    const text = await response.text().catch(() => '');
    if (response.status === 429 || response.status >= 500) {
      // Degraded worker (5xx/429) is treated as unreachable — it should surface
      // the offline banner just like a connection failure, not silently pass.
      recordWorkerUnreachable();
      logger.warn('SYSTEM', `Worker API ${method} ${url} returned ${response.status}; skipping hook API call`, {
        body: text.substring(0, 200),
      });
      return {
        continue: true,
        reason: `worker_api_${response.status}`,
        [WORKER_FALLBACK_BRAND]: true,
      };
    }
    resetWorkerFailureCounter();

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
    // [ANTI-PATTERN IGNORED]: worker responses are not guaranteed to be JSON;
    // a non-JSON body is an expected shape and the raw text is the correct
    // result for the caller.
    return text as unknown as T;
  }
}
