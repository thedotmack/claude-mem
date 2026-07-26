import path from "path";
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from "fs";
import { spawnHidden } from "./spawn.js";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager, type SettingsDefaults } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT, DATA_DIR } from "./paths.js";
import { loadFromFileOnce } from "./hook-settings.js";
import { validateWorkerPidFile, readOwnedWorkerPidInfo } from "../supervisor/index.js";
import { emitBlockingError } from "./hook-io.js";
import { captureCliEvent } from "../services/telemetry/cli-telemetry.js";
import { checkVersionMatch } from "../services/infrastructure/index.js";
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

export interface WorkerScriptCandidate {
  scriptPath: string;
  version: string | null;
}

/**
 * Descending version order for worker-script candidates: numeric
 * major.minor.patch, release ahead of prerelease at the same base, reverse
 * lexical tiebreak. The inline resolvers in src/build/hook-shell-template.ts
 * embed this same ordering — every resolver ranking candidates identically is
 * the invariant that makes restart storms impossible, so keep them in
 * lockstep.
 */
export function compareVersionsDescending(a: string, b: string): number {
  const parseBase = (version: string): [number, number, number] => {
    const parts = version.split('-')[0].split('.');
    return [parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, parseInt(parts[2], 10) || 0];
  };
  const [aMajor, aMinor, aPatch] = parseBase(a);
  const [bMajor, bMinor, bPatch] = parseBase(b);
  if (bMajor !== aMajor) return bMajor - aMajor;
  if (bMinor !== aMinor) return bMinor - aMinor;
  if (bPatch !== aPatch) return bPatch - aPatch;
  const aIsPrerelease = a.includes('-') ? 1 : 0;
  const bIsPrerelease = b.includes('-') ? 1 : 0;
  if (aIsPrerelease !== bIsPrerelease) return aIsPrerelease - bIsPrerelease;
  return a < b ? 1 : a > b ? -1 : 0;
}

export function cacheWorkerScriptCandidates(
  cacheRoot: string = path.join(path.dirname(path.dirname(MARKETPLACE_ROOT)), 'cache', 'thedotmack', 'claude-mem')
): WorkerScriptCandidate[] {
  try {
    return readdirSync(cacheRoot)
      .filter(name => /^\d/.test(name))
      .map(name => path.join(cacheRoot, name))
      .filter(versionDir => {
        try {
          if (!statSync(versionDir).isDirectory()) return false;
        } catch {
          return false;
        }
        // Claude Code stamps superseded cache versions with .orphaned_at when
        // a new version installs. An orphaned dir must never outrank the live
        // install: the 2026-07-22 restart storm happened because the stamp
        // bumped the OLD dir's mtime and the then mtime-ordered resolver
        // respawned 13.11.0 under a 13.12.0 plugin indefinitely.
        return !existsSync(path.join(versionDir, '.orphaned_at'));
      })
      .map(versionDir => ({
        scriptPath: candidateWorkerScriptPath(versionDir),
        version: path.basename(versionDir),
      }));
  } catch {
    return [];
  }
}

function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.debug('SYSTEM', 'Could not read package version for worker resolution', { packageJsonPath, code });
    }
    return null;
  }
}

/**
 * Canonical worker-script resolver AND the single version oracle: the version
 * returned here is what hooks compare the live worker against
 * (checkVersionMatch) and what every spawner — hook lazy-spawn, MCP server,
 * dying-worker restart handoff — launches. Detection and respawn consulting
 * different oracles is what made the 2026-07-22 restart storm possible.
 *
 * Highest version wins. Array.prototype.sort is stable, so equal versions
 * preserve the cache → marketplace → cwd precedence, and versionless
 * candidates rank behind every versioned one. The opt-in override exists for
 * local testing.
 */
export function resolveWorkerScript(): WorkerScriptCandidate | null {
  const override = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH?.trim();
  if (override) {
    if (existsSync(override)) return { scriptPath: override, version: null };
    logger.debug('SYSTEM', 'Ignoring missing CLAUDE_MEM_WORKER_SCRIPT_PATH override', { override });
  }

  const candidates: WorkerScriptCandidate[] = [
    ...cacheWorkerScriptCandidates(),
    {
      scriptPath: candidateWorkerScriptPath(path.join(MARKETPLACE_ROOT, 'plugin')),
      version: readPackageVersion(path.join(MARKETPLACE_ROOT, 'package.json')),
    },
    {
      scriptPath: path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
      version: readPackageVersion(path.join(process.cwd(), 'package.json')),
    },
  ];

  return selectWorkerScript(candidates);
}

export function selectWorkerScript(candidates: WorkerScriptCandidate[]): WorkerScriptCandidate | null {
  const installed = candidates.filter(candidate => existsSync(candidate.scriptPath));
  if (installed.length === 0) return null;

  installed.sort((a, b) => {
    if (a.version === null && b.version === null) return 0;
    if (a.version === null) return 1;
    if (b.version === null) return -1;
    return compareVersionsDescending(a.version, b.version);
  });
  return installed[0];
}

export function resolveWorkerScriptPath(): string | null {
  return resolveWorkerScript()?.scriptPath ?? null;
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
 * After SIGKILLing the stale worker, wait for the OS to release its listen
 * socket before lazy-spawning — the worker boot refuses to start while the
 * port is bound. A rejected connection is the port-free signal. Only called
 * once the stale process is confirmed dead (kill succeeded or ESRCH), so a
 * rejection here cannot be a live-but-stalled worker.
 */
async function waitForWorkerPortClosed(timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      await workerHttpRequest('/api/health', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
    } catch {
      return true;
    }
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise<void>(resolve => setTimeout(resolve, 200));
  }
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

export async function ensureWorkerRunning(): Promise<boolean> {
  // Resolve ONCE and use the result for both the staleness check and the
  // (re)spawn script below. Detection and spawn sharing this single oracle
  // is what guarantees a mismatch clears in one recycle instead of
  // ping-ponging (the 2026-07-22 restart storm: detection read the
  // marketplace package.json while the spawner took the newest-mtime cache
  // dir, and the two disagreed forever).
  const resolvedScript = resolveWorkerScript();

  // Resolved version captured when the alive branch runs, so every
  // post-readiness path below can run the one-shot amplifier check
  // (warnIfVersionStillMismatched). Stays null when no worker was alive
  // (plain cold-start lazy-spawn — no recycle happened, nothing to amplify)
  // or when the resolved version is unreadable ('unknown').
  let expectedPluginVersion: string | null = null;

  if (await isWorkerPortAlive()) {
    // A worker is already alive. If it is a DIFFERENT version than the one
    // this resolution would spawn (e.g. the user upgraded but the previous
    // worker is still squatting the port), recycle it so the resolved
    // version takes over — otherwise the stale worker keeps serving
    // indefinitely.
    const { matches, pluginVersion, workerVersion } = await checkVersionMatch(getWorkerPort(), resolvedScript?.version ?? null);
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

    logger.info('SYSTEM', 'Worker version mismatch — killing stale worker', {
      pluginVersion,
      workerVersion,
    });
    // The stale worker must never run its own replacement. The previous
    // design (POST /api/admin/restart, then the dying worker spawns its
    // successor) executed the OLD install's handoff code: a ≤13.11.0 worker
    // resolves the successor script from its own install dir, respawns its
    // own version, and re-binds the port before this hook's lazy-spawn — so
    // the mismatch recurs on every hook forever (#3378: 2,424 recycles in
    // one machine-day). SIGKILL is the only teardown guaranteed to run zero
    // stale-version code; the lazy-spawn below, using this install's
    // resolver, is then the only spawner.
    const stalePidInfo = readOwnedWorkerPidInfo();
    if (stalePidInfo === null || stalePidInfo.port !== getWorkerPort()) {
      logger.error('SYSTEM', 'Stale worker is serving the port but the PID file does not identify it; kill the claude-mem worker process manually', {
        port: getWorkerPort(),
        pidFilePid: stalePidInfo?.pid ?? null,
        pidFilePort: stalePidInfo?.port ?? null,
      });
      return false;
    }
    try {
      process.kill(stalePidInfo.pid, 'SIGKILL');
    } catch (error: unknown) {
      // ESRCH: it exited between the health probe and the kill — the port is
      // free (or about to be) either way.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.error('SYSTEM', 'Could not kill stale worker', {
          pid: stalePidInfo.pid,
          port: stalePidInfo.port,
        }, error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    }
    if (!(await waitForWorkerPortClosed())) {
      logger.error('SYSTEM', 'Stale worker port still open after SIGKILL; skipping spawn this hook event', {
        pid: stalePidInfo.pid,
        port: getWorkerPort(),
      });
      return false;
    }
    // The killed worker's PID file is left behind; the successor's boot
    // removes it (validateWorkerPidFile returns 'stale' for a dead pid).
    // Fall through to (re)spawn + readiness wait below.
  }

  const runtimePath = resolveWorkerRuntimePath();
  const scriptPath = resolvedScript?.scriptPath ?? null;

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
  // it is the spawner for CLI-initiated restarts. Hook version recycles never
  // trigger it — they SIGKILL the stale worker and spawn here.)
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

export async function ensureWorkerAliveOnce(): Promise<boolean> {
  if (aliveCache !== null) return aliveCache;
  aliveCache = await ensureWorkerRunning();
  return aliveCache;
}

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

function parseHookFailureState(raw: string): HookFailureState {
  const parsed = JSON.parse(raw) as Partial<HookFailureState>;
  return {
    consecutiveFailures: typeof parsed.consecutiveFailures === 'number' && Number.isFinite(parsed.consecutiveFailures)
      ? Math.max(0, Math.floor(parsed.consecutiveFailures))
      : 0,
    lastFailureAt: typeof parsed.lastFailureAt === 'number' && Number.isFinite(parsed.lastFailureAt)
      ? parsed.lastFailureAt
      : 0,
  };
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

export async function recordWorkerUnreachable(): Promise<number> {
  const state = readHookFailureState();
  const next: HookFailureState = {
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: Date.now(),
  };
  writeHookFailureStateAtomic(next);

  const threshold = getFailLoudThreshold();
  if (next.consecutiveFailures >= threshold) {
    // hook_failed distress signal. Gated to the failure that JUST reached the
    // threshold (`===`, not `>=`): the stderr warning below repeats on every
    // failure past the threshold, but telemetry emits once per failure streak
    // to bound volume. MUST be awaited BEFORE emitBlockingError — it calls
    // process.exit(2) immediately, which would kill a fire-and-forget POST
    // mid-flight. captureCliEvent never throws and is hard-capped at 2s, so
    // this cannot hang the fail-loud path. Closed-enum/count props only —
    // never error text. Transport is the direct CLI POST, never the worker
    // API (the defining failure here IS "worker unreachable").
    if (next.consecutiveFailures === threshold) {
      await captureCliEvent('hook_failed', {
        ...(activeHookType !== null ? { hook_type: activeHookType } : {}),
        error_mode: 'worker_unavailable',
        consecutive_failures: next.consecutiveFailures,
        threshold_tripped: true,
      });
    }
    // #2292 fix: BLOCKING_FEEDBACK. emitBlockingError flushes the Phase 2
    // stderr buffer (so preceding logger.warn lines also surface) and writes
    // via the bypass channel + exits 2. Previously this raw process.stderr.write
    // was swallowed by hookCommand's blanket no-op, so the user/model never saw it.
    emitBlockingError(
      `claude-mem worker unreachable for ${next.consecutiveFailures} consecutive hooks.`
    );
  }
  return next.consecutiveFailures;
}

function resetWorkerFailureCounter(): void {
  const state = readHookFailureState();
  if (state.consecutiveFailures === 0) return;
  writeHookFailureStateAtomic({ consecutiveFailures: 0, lastFailureAt: 0 });
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
}

export async function executeWithWorkerFallback<T = unknown>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  options: WorkerFallbackOptions = {},
): Promise<WorkerCallResult<T>> {
  const alive = await ensureWorkerAliveOnce();
  if (!alive) {
    await recordWorkerUnreachable();
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
    const text = await response.text().catch(() => '');
    resetWorkerFailureCounter();
    if (response.status === 429 || response.status >= 500) {
      logger.warn('SYSTEM', `Worker API ${method} ${url} returned ${response.status}; skipping hook API call`, {
        body: text.substring(0, 200),
      });
      return {
        continue: true,
        reason: `worker_api_${response.status}`,
        [WORKER_FALLBACK_BRAND]: true,
      };
    }

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
