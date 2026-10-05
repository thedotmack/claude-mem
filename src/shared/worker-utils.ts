import path from "path";
import { randomUUID } from "crypto";
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, defaultSessionInitRequestTimeoutMs, getTimeout, maxSessionInitRequestTimeoutMs } from "./hook-constants.js";
import { readSseEvents } from "./sse-reader.js";
import { SettingsDefaultsManager, type SettingsDefaults } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT, DATA_DIR, resolveDataDir } from "./paths.js";
import { loadFromFileOnce } from "./hook-settings.js";
import { isWorkerAutostartDisabled } from "./worker-autostart.js";
import { viewerBaseUrl } from "./viewer-url.js";
import { readOwnedWorkerPidInfo } from "../supervisor/index.js";
import { emitDiagnostic } from "./hook-io.js";
import { captureCliEvent } from "../services/telemetry/cli-telemetry.js";
import { checkVersionMatch, isPortInUse } from "../services/infrastructure/index.js";
import { classifyPortOccupancy } from "../services/infrastructure/HealthMonitor.js";
import { UNBINDABLE_PORT_REMEDIATION } from "./connection-errors.js";
// Imported from ProcessManager.js directly (not the infrastructure barrel):
// tests mock the barrel module wholesale, and the resolver must stay real.
// ProcessManager imports nothing from worker-utils, so no cycle.
import {
  resolveWorkerRuntimePath,
  spawnDetachedWorkerDaemon,
} from "../services/infrastructure/ProcessManager.js";
import { acquireSpawnLock, releaseSpawnLock } from "./worker-spawn-gate.js";
import { reclaimGhostListeningPort } from "./port-reclaim.js";
import { sanitizeEnv } from "../supervisor/env-sanitizer.js";
import { killProcessTree } from "./kill-process-tree.js";
import { writeJsonFileAtomic } from "./atomic-json.js";
import { findMissingPluginDependencies } from "./plugin-dependency-closure.js";

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

/**
 * GET /api/ready sends a `: ping` every 2 s while the worker boots, so this
 * much silence means the worker is wedged (alive socket, dead event loop or a
 * stalled init), not slow. Booting time itself is never a reason to recycle.
 */
const READY_STREAM_IDLE_TIMEOUT_MS = 5000;

const API_REQUEST_TIMEOUT_BOUNDS = { min: 500, max: 300000 } as const;
const SESSION_INIT_REQUEST_TIMEOUT_BOUNDS = {
  min: 500,
  max: HOOK_TIMEOUTS.SESSION_INIT_REQUEST_MAX,
} as const;
/** Below this much budget, a hook-side worker step is skipped rather than started. */
const MIN_WORKER_BUDGET_MS = 100;

/**
 * Node/undici RequestInit extension. Passing `{ verbose: true }` is the
 * documented way to get socket-level fetch diagnostics (issue #3957).
 * Not part of the DOM lib, so we keep it local instead of widening RequestInit.
 */
type WorkerFetchInit = RequestInit & { verbose?: boolean };

/**
 * Opt-in only. Default stays off so hook/IPC noise is unchanged.
 * Accepts 1/true/on/yes (any case). Env-only — not a settings.json default.
 */
export function isWorkerFetchVerboseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLAUDE_MEM_FETCH_VERBOSE;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function withFetchDiagnostics(init: RequestInit): WorkerFetchInit {
  if (!isWorkerFetchVerboseEnabled()) return init;
  return { ...init, verbose: true };
}

function describeFetchError(err: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  let current: unknown = err;
  for (let depth = 0; current && depth < 4; depth++) {
    const key = depth === 0 ? 'error' : `cause${depth}`;
    if (current instanceof Error) {
      const errno = current as NodeJS.ErrnoException;
      details[key] = {
        name: current.name,
        message: current.message,
        ...(errno.code !== undefined ? { code: errno.code } : {}),
      };
      current = current.cause;
      continue;
    }
    details[key] = String(current);
    break;
  }
  return details;
}

function logVerboseFetchFailure(url: string, init: RequestInit, err: unknown): void {
  const method = typeof init.method === 'string' ? init.method : 'GET';
  const details = describeFetchError(err);
  // Serialize before logging: logger.formatData abbreviates objects with more
  // than 3 keys, which would drop nested cause messages at the default INFO level.
  const serialized = JSON.stringify(details);
  logger.warn('SYSTEM', 'Worker IPC fetch failed', { url, method }, serialized);
  // Bypass the hook stderr buffer (#2292) so undici's own verbose dumps plus
  // this cause chain stay visible when CLAUDE_MEM_FETCH_VERBOSE is on.
  emitDiagnostic(`[claude-mem] fetch verbose: ${method} ${url} ${serialized}\n`);
}

async function workerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const requestInit = withFetchDiagnostics(init);
  try {
    return await fetch(url, requestInit);
  } catch (err: unknown) {
    if (isWorkerFetchVerboseEnabled()) {
      logVerboseFetchFailure(url, init, err);
    }
    throw err;
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  try {
    // AbortSignal.timeout (Node 18+) replaces the manual setTimeout/clearTimeout
    // race. On expiry it aborts with a TimeoutError DOMException.
    return await workerFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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

export interface IdleTimeoutOptions {
  /** Max silence: armed before the request, reset on headers and on every body chunk. */
  idleTimeoutMs: number;
  /** Optional hard ceiling for the whole exchange (only where a host imposes one). */
  absoluteCapMs?: number;
  /** Called for every body chunk as it arrives (liveness / progress). */
  onChunk?: (chunk: Uint8Array) => void;
}

export interface IdleFetchResponseMeta {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
}

export interface IdleFetchTextResult extends IdleFetchResponseMeta {
  text: string;
}

export interface IdleFetchStreamResult extends IdleFetchResponseMeta {
  /** Single-use; start reading promptly (the idle timer runs from headers to the first read). Each chunk resets it; time the consumer spends between reads does not count. */
  chunks: AsyncIterable<Uint8Array>;
  /** Abandon the body without reading it (releases the request and all timers). */
  cancel(): Promise<void>;
}

/**
 * Idle + optional absolute-cap watchdog for one request. Aborts through its own
 * controller (merged with the caller's signal) and remembers why, so the fetch
 * rejection can be rewritten to the "Request timed out ..." wording callers match.
 */
function createIdleWatchdog(options: IdleTimeoutOptions, callerSignal: AbortSignal | null | undefined) {
  const controller = new AbortController();
  let timeoutError: Error | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearIdle = () => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  };
  const dispose = () => {
    disposed = true;
    clearIdle();
    if (capTimer !== null) { clearTimeout(capTimer); capTimer = null; }
  };
  const trip = (error: Error) => {
    if (disposed) return;
    timeoutError = error;
    dispose();
    controller.abort(error);
  };
  const touch = () => {
    if (disposed) return;
    clearIdle();
    idleTimer = setTimeout(
      () => trip(new Error(`Request timed out after ${options.idleTimeoutMs}ms idle`)),
      options.idleTimeoutMs
    );
  };

  if (options.absoluteCapMs !== undefined && options.absoluteCapMs > 0) {
    const absoluteCapMs = options.absoluteCapMs;
    capTimer = setTimeout(() => trip(new Error(`Request timed out after ${absoluteCapMs}ms`)), absoluteCapMs);
  }
  touch();

  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
    touch,
    pause: clearIdle,
    dispose,
    /** Our timeout error if the watchdog fired, otherwise the original error. */
    translate: (err: unknown): unknown => timeoutError ?? err,
  };
}

/**
 * fetch whose deadline is silence, not wall time. Owns the body read, so the idle
 * timer covers the body too — never hands back a bare Response.
 */
export async function fetchStreamWithIdleTimeout(
  url: string,
  init: RequestInit,
  options: IdleTimeoutOptions
): Promise<IdleFetchStreamResult> {
  const watchdog = createIdleWatchdog(options, init.signal);
  let response: Response;
  try {
    response = await workerFetch(url, { ...init, signal: watchdog.signal });
  } catch (err: unknown) {
    watchdog.dispose();
    throw watchdog.translate(err);
  }
  watchdog.touch();

  const body = response.body;
  const reader = body ? body.getReader() : null;
  let bodyFinished = false;

  async function* readChunks(): AsyncGenerator<Uint8Array> {
    if (!reader) { bodyFinished = true; watchdog.dispose(); return; }
    try {
      while (true) {
        watchdog.touch();
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (err: unknown) {
          bodyFinished = true;
          throw watchdog.translate(err);
        }
        if (result.done) { bodyFinished = true; return; }
        watchdog.pause();
        options.onChunk?.(result.value);
        yield result.value;
      }
    } finally {
      watchdog.dispose();
      if (!bodyFinished) await reader.cancel();
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    chunks: readChunks(),
    cancel: async () => {
      watchdog.dispose();
      if (reader && !bodyFinished) { bodyFinished = true; await reader.cancel(); }
    },
  };
}

/** Buffered form of fetchStreamWithIdleTimeout: resolves once the whole body is read. */
export async function fetchWithIdleTimeout(
  url: string,
  init: RequestInit,
  options: IdleTimeoutOptions
): Promise<IdleFetchTextResult> {
  const streamed = await fetchStreamWithIdleTimeout(url, init, options);
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of streamed.chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { status: streamed.status, statusText: streamed.statusText, ok: streamed.ok, headers: streamed.headers, text };
}

let cachedPort: number | null = null;
let cachedHost: string | null = null;
let cachedSettings: SettingsDefaults | null = null;
let cachedApiRequestTimeoutMs: number | null = null;
let cachedSessionInitRequestTimeoutMs: number | null = null;

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

/**
 * Base URL for the live-view UI as printed to users. Prefers an explicit public
 * URL (env `CLAUDE_MEM_PUBLIC_URL`, else the settings value) — the
 * browser-reachable alias when the worker runs in a remote sandbox behind a
 * port-forward — and falls back to loopback on the given port. Empty/unset
 * preserves the historical `http://localhost:<port>` output for local users.
 */
export function getViewerBaseUrl(port: number | string): string {
  return viewerBaseUrl(port, getWorkerSettings().CLAUDE_MEM_PUBLIC_URL);
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

/**
 * The UserPromptSubmit session-init budget (#3434, plan-17 step 3): one
 * deadline for the whole worker round-trip, kept inside the 15 s host timeout.
 * Never Windows-scaled up — the cap it has to fit under is not scaled — and
 * on Windows both its default and its ceiling are shorter, because hook
 * start-up there eats seconds the budget's clock never sees
 * (defaultSessionInitRequestTimeoutMs, maxSessionInitRequestTimeoutMs).
 */
export function getSessionInitRequestTimeoutMs(): number {
  if (cachedSessionInitRequestTimeoutMs !== null) {
    return cachedSessionInitRequestTimeoutMs;
  }

  cachedSessionInitRequestTimeoutMs = Math.min(
    readSettingsBackedTimeout(
      'CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS',
      defaultSessionInitRequestTimeoutMs(),
      SESSION_INIT_REQUEST_TIMEOUT_BOUNDS
    ),
    maxSessionInitRequestTimeoutMs(),
  );
  return cachedSessionInitRequestTimeoutMs;
}

export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
  cachedSettings = null;
  cachedApiRequestTimeoutMs = null;
  cachedSessionInitRequestTimeoutMs = null;
}

/** Milliseconds left before `deadlineAt`, or null when the caller set no deadline. */
function remainingBudgetMs(deadlineAt: number | null): number | null {
  return deadlineAt === null ? null : Math.max(0, deadlineAt - Date.now());
}

function isBudgetExhausted(deadlineAt: number | null): boolean {
  const remainingMs = remainingBudgetMs(deadlineAt);
  return remainingMs !== null && remainingMs < MIN_WORKER_BUDGET_MS;
}

/**
 * A step's own timeout, cut down to what is left of the caller's budget. Never
 * below 1 ms: workerHttpRequest treats a 0 timeout as "no timeout at all".
 */
function boundedByBudget(stepTimeoutMs: number, deadlineAt: number | null): number {
  const remainingMs = remainingBudgetMs(deadlineAt);
  return remainingMs === null ? stepTimeoutMs : Math.max(1, Math.min(stepTimeoutMs, remainingMs));
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
    /**
     * Switch to a silence-based deadline (fetchWithIdleTimeout). The body is read
     * in full under the idle timer and re-wrapped in a Response. An explicit
     * `timeoutMs` then acts as the absolute cap; without it there is no cap.
     */
    idleTimeoutMs?: number;
  } = {}
): Promise<Response> {
  const method = options.method ?? 'GET';

  const url = buildWorkerUrl(apiPath);
  const init: RequestInit = { method };
  if (options.headers) {
    init.headers = options.headers;
  }
  if (options.body) {
    init.body = options.body;
  }

  if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
    return fetchWithIdleTimeout(url, init, {
      idleTimeoutMs: options.idleTimeoutMs,
      absoluteCapMs: options.timeoutMs,
    }).then((result) => new Response(result.text.length > 0 ? result.text : null, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    }));
  }

  const timeoutMs = options.timeoutMs ?? getWorkerApiRequestTimeoutMs();
  if (timeoutMs > 0) {
    return fetchWithTimeout(url, init, timeoutMs);
  }
  return workerFetch(url, init);
}

async function isWorkerHealthy(timeoutMs: number): Promise<boolean> {
  const response = await workerHttpRequest('/api/health', { timeoutMs });
  return response.ok;
}

async function isWorkerReady(timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS): Promise<boolean> {
  const response = await workerHttpRequest('/api/readiness', { timeoutMs });
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

/** Where resolveWorkerScript() looks. Injectable so tests can use temp roots. */
export interface WorkerScriptSearchRoots {
  cacheRoot: string;
  marketplaceRoot: string;
  cwd: string;
}

function defaultWorkerScriptSearchRoots(): WorkerScriptSearchRoots {
  return {
    cacheRoot: path.join(path.dirname(path.dirname(MARKETPLACE_ROOT)), 'cache', 'thedotmack', 'claude-mem'),
    marketplaceRoot: MARKETPLACE_ROOT,
    cwd: process.cwd(),
  };
}

/**
 * Canonical worker-script resolver AND the single version oracle: the version
 * returned here is what hooks compare the live worker against
 * (checkVersionMatch) and what every spawner — hook lazy-spawn, MCP server,
 * dying-worker restart handoff — launches. The CLI's `start`/`stop`/`status`/
 * `doctor` read the same answer through resolvePluginRoot(). Detection and
 * respawn consulting different oracles is what made the 2026-07-22 restart
 * storm possible.
 *
 * Highest version wins among roots whose dependency closure is complete (see
 * selectWorkerScript). Array.prototype.sort is stable, so equal versions
 * preserve the cache → marketplace → cwd precedence, and versionless
 * candidates rank behind every versioned one. The opt-in override exists for
 * local testing. $CLAUDE_PLUGIN_ROOT is deliberately not a candidate: it is
 * set only inside host hook processes, so honoring it would give each process
 * its own answer. The shell hooks use it only to find their own scripts.
 */
export function resolveWorkerScript(
  roots: WorkerScriptSearchRoots = defaultWorkerScriptSearchRoots(),
): WorkerScriptCandidate | null {
  const override = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH?.trim();
  if (override) {
    if (existsSync(override)) return { scriptPath: override, version: null };
    logger.debug('SYSTEM', 'Ignoring missing CLAUDE_MEM_WORKER_SCRIPT_PATH override', { override });
  }

  const candidates: WorkerScriptCandidate[] = [
    ...cacheWorkerScriptCandidates(roots.cacheRoot),
    {
      scriptPath: candidateWorkerScriptPath(path.join(roots.marketplaceRoot, 'plugin')),
      version: readPackageVersion(path.join(roots.marketplaceRoot, 'package.json')),
    },
    {
      scriptPath: path.join(roots.cwd, 'plugin', 'scripts', 'worker-service.cjs'),
      version: readPackageVersion(path.join(roots.cwd, 'package.json')),
    },
  ];

  return selectWorkerScript(candidates);
}

/** The plugin root a worker script belongs to: `<root>/scripts/worker-service.cjs`. */
export function pluginRootOfWorkerScript(scriptPath: string): string {
  return path.dirname(path.dirname(scriptPath));
}

function hasCompleteDependencyClosure(candidate: WorkerScriptCandidate): boolean {
  return findMissingPluginDependencies(pluginRootOfWorkerScript(candidate.scriptPath)).length === 0;
}

/**
 * The highest-version installed candidate whose dependency closure is complete
 * (plan-16 step 1c). A newer root with missing modules — a marketplace copy
 * whose node_modules was never installed, or a fresh cache extract the Setup
 * hook has not filled yet — would spawn a worker that dies on
 * `Cannot find module 'zod/v3'` (#3604). When no candidate is complete, the
 * highest installed one still wins, so nothing regresses before Setup runs.
 */
export function selectWorkerScript(
  candidates: WorkerScriptCandidate[],
  isComplete: (candidate: WorkerScriptCandidate) => boolean = hasCompleteDependencyClosure,
): WorkerScriptCandidate | null {
  const installed = candidates.filter(candidate => existsSync(candidate.scriptPath));
  if (installed.length === 0) return null;

  installed.sort((a, b) => {
    if (a.version === null && b.version === null) return 0;
    if (a.version === null) return 1;
    if (b.version === null) return -1;
    return compareVersionsDescending(a.version, b.version);
  });
  return installed.find(isComplete) ?? installed[0];
}

export function resolveWorkerScriptPath(): string | null {
  return resolveWorkerScript()?.scriptPath ?? null;
}

export interface PluginRootResolution {
  /** The directory holding scripts/worker-service.cjs. */
  root: string;
  version: string | null;
  /** Declared dependencies this root's node_modules does not provide. */
  missingDependencies: string[];
}

/**
 * The plugin root the worker spawns from, from the same oracle as
 * resolveWorkerScript(), with its dependency completeness. The CLI reports and
 * spawns from this instead of assuming the marketplace copy, so a working
 * cache-only install is never "not installed" (#3534, plan-16 steps 1 and 5).
 */
export function resolvePluginRoot(
  roots: WorkerScriptSearchRoots = defaultWorkerScriptSearchRoots(),
): PluginRootResolution | null {
  const script = resolveWorkerScript(roots);
  if (!script) return null;
  const root = pluginRootOfWorkerScript(script.scriptPath);
  return { root, version: script.version, missingDependencies: findMissingPluginDependencies(root) };
}

async function waitForWorkerPort(
  options: { attempts: number; backoffMs: number; deadlineAt?: number | null },
): Promise<boolean> {
  const deadlineAt = options.deadlineAt ?? null;
  let delayMs = options.backoffMs;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (isBudgetExhausted(deadlineAt)) return false;
    if (await isWorkerPortAlive(deadlineAt ?? Number.POSITIVE_INFINITY)) return true;
    if (attempt < options.attempts) {
      await new Promise<void>(resolve => setTimeout(resolve, boundedByBudget(delayMs, deadlineAt)));
      delayMs *= 2;
    }
  }
  return false;
}

/**
 * What one GET /api/ready read concluded:
 * - ready:        the worker finished init.
 * - failed:       the worker reported its background init died (it never will be ready).
 * - wedged:       AFTER response headers, the stream closed (or errored)
 *                 before a terminal phase. Never read as ready.
 * - unresponsive: silence past the idle window, before response headers OR
 *                 after them (no phase and no ping). Not proof of a wedge:
 *                 bun:sqlite's busy_timeout blocks the worker's event loop
 *                 during lock contention, so a booting worker can be silent for
 *                 >5 s at any point of the stream. Only the same pid staying
 *                 unresponsive across hooks for UNRESPONSIVE_WORKER_WEDGED_AFTER_MS
 *                 counts as wedged.
 * - still_booting: progress kept arriving but the caller's budget ran out first.
 * - not_running:  nothing accepted the connection.
 */
type WorkerReadyOutcome = 'ready' | 'failed' | 'wedged' | 'unresponsive' | 'still_booting' | 'not_running';

interface WorkerReadyResult {
  outcome: WorkerReadyOutcome;
  /** `failed`: the worker's message. `wedged` / `unresponsive`: what was observed. */
  detail?: string;
}

/** Older workers have no /api/ready (404, or 503 from their init gate). */
type ReadyStreamRead = WorkerReadyResult | { outcome: 'unsupported' };

function isIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && /^Request timed out after \d+ms idle$/.test(error.message);
}

function isAbsoluteCapTimeoutError(error: unknown): boolean {
  return error instanceof Error && /^Request timed out after \d+ms$/.test(error.message);
}

/**
 * One read of GET /api/ready: idle-timed (READY_STREAM_IDLE_TIMEOUT_MS), capped
 * at the caller's budget. Replaces polling /api/readiness and the uptime guess.
 */
async function readWorkerReadyStream(budgetMs: number): Promise<ReadyStreamRead> {
  let stream: Awaited<ReturnType<typeof fetchStreamWithIdleTimeout>>;
  try {
    stream = await fetchStreamWithIdleTimeout(buildWorkerUrl('/api/ready'), { method: 'GET' }, {
      idleTimeoutMs: READY_STREAM_IDLE_TIMEOUT_MS,
      absoluteCapMs: Math.max(1, budgetMs),
    });
  } catch (error: unknown) {
    if (isIdleTimeoutError(error)) return { outcome: 'unresponsive', detail: 'no response headers within the idle window' };
    if (isAbsoluteCapTimeoutError(error)) return { outcome: 'still_booting', detail: 'budget spent before response headers' };
    logger.debug('SYSTEM', 'Worker /api/ready connection failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: 'not_running' };
  }

  // Dropping the body once the outcome is known must not change it: a cancel
  // error inside the read loop below would otherwise read as `wedged` and
  // SIGKILL a worker that just reported `ready`.
  const releaseStream = (): Promise<void> => stream.cancel().catch((error: unknown) => {
    logger.debug('SYSTEM', 'Releasing the /api/ready body failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Headers alone do not clear the unresponsive record: a worker that answers
  // headers and then goes silent on every hook must still reach the same-pid
  // threshold. Only a read that shows the worker progressing clears it.
  const contentType = stream.headers?.get('content-type') ?? '';
  if (!stream.ok || !contentType.includes('text/event-stream')) {
    // Not our SSE stream (an older worker's 404 / init-gate 503, or anything
    // else answering the port): drop the body and use the legacy probe.
    clearUnresponsiveWorkerRecord();
    await releaseStream();
    return { outcome: 'unsupported' };
  }

  let lastPhase: string | null = null;
  try {
    for await (const event of readSseEvents(stream.chunks)) {
      if (event.event !== 'phase') continue;
      const parsed = JSON.parse(event.data) as { phase?: unknown; message?: unknown };
      lastPhase = typeof parsed.phase === 'string' ? parsed.phase : null;
      if (lastPhase === 'ready') {
        clearUnresponsiveWorkerRecord();
        await releaseStream();
        return { outcome: 'ready' };
      }
      if (lastPhase === 'failed') {
        await releaseStream();
        return { outcome: 'failed', detail: typeof parsed.message === 'string' ? parsed.message : 'unknown init failure' };
      }
    }
  } catch (error: unknown) {
    if (isAbsoluteCapTimeoutError(error)) {
      // Progress (phases or pings) kept arriving until the budget ran out.
      clearUnresponsiveWorkerRecord();
      return { outcome: 'still_booting', detail: `last phase ${lastPhase ?? 'none'}` };
    }
    if (isIdleTimeoutError(error)) {
      // Same persistence guard as pre-header silence: a stall, until the same
      // pid stays silent across hooks for UNRESPONSIVE_WORKER_WEDGED_AFTER_MS.
      return { outcome: 'unresponsive', detail: `silent past the idle window after response headers (last phase ${lastPhase ?? 'none'})` };
    }
    return { outcome: 'wedged', detail: `stream error: ${error instanceof Error ? error.message : String(error)} (last phase ${lastPhase ?? 'none'})` };
  }
  return { outcome: 'wedged', detail: `stream closed before ready/failed (last phase ${lastPhase ?? 'none'})` };
}

/** Pre-/api/ready workers: the historical /api/readiness poll, used only on fallback. */
async function pollLegacyWorkerReadiness(timeoutMs: number): Promise<WorkerReadyResult> {
  if (timeoutMs <= 0) {
    try {
      return await isWorkerReady() ? { outcome: 'ready' } : { outcome: 'still_booting' };
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Worker readiness check threw', {}, error instanceof Error ? error : new Error(String(error)));
      return { outcome: 'still_booting' };
    }
  }
  const start = Date.now();
  do {
    const waitLeftMs = timeoutMs - (Date.now() - start);
    try {
      if (await isWorkerReady(Math.max(1, Math.min(HEALTH_CHECK_TIMEOUT_MS, waitLeftMs)))) return { outcome: 'ready' };
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Worker readiness check threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const remainingMs = timeoutMs - (Date.now() - start);
    if (remainingMs <= 0) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, remainingMs)));
  } while (Date.now() - start < timeoutMs);
  return { outcome: 'still_booting', detail: 'legacy /api/readiness never reported ready' };
}

/**
 * Wait for the worker to finish init. A worker without /api/ready (an older
 * version still holding the port) gets the legacy /api/readiness poll once;
 * the version-mismatch recycle replaces it anyway.
 */
async function waitForWorkerReadiness(timeoutMs: number = HOOK_READINESS_TIMEOUT_MS): Promise<WorkerReadyResult> {
  // A 0 budget (CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS=0) still gets one
  // health-probe-sized look, as the single /api/readiness check used to.
  const budgetMs = timeoutMs > 0 ? timeoutMs : HEALTH_CHECK_TIMEOUT_MS;
  const read = await readWorkerReadyStream(budgetMs);
  // A worker that reached ready ends any never-ready streak: a later failure,
  // even with the same message, earns a fresh recycle.
  if (read.outcome === 'ready') clearNeverReadyRecycleRecord();
  if (read.outcome !== 'unsupported') return read;
  logger.debug('SYSTEM', 'Worker has no /api/ready stream; falling back to /api/readiness');
  return pollLegacyWorkerReadiness(timeoutMs);
}

/**
 * Read the version the worker self-reports on GET /api/health. The payload
 * carries pid/version even on a 503 (degraded queue) response, so the body is
 * parsed regardless of status — same contract as restart-verify.ts. Returns
 * null when the worker is unreachable or the payload is malformed.
 */
async function fetchWorkerHealthVersion(timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS): Promise<string | null> {
  try {
    const response = await workerHttpRequest('/api/health', { timeoutMs });
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
 * port is bound. Released means BINDABLE: a bind probe (classifyPortOccupancy)
 * must report 'free'. A refused connection is not proof (#3416): on Windows a
 * killed worker's socket can stay LISTENING under the dead PID, refusing every
 * connection while bind() still hits EADDRINUSE, and a successor spawned onto
 * it can never listen, so each hook would spawn another one forever.
 */
async function waitForWorkerPortReleased(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    if ((await classifyPortOccupancy(getWorkerPort(), Math.min(1000, remainingMs))) === 'free') return true;
    const pauseMs = Math.min(200, deadline - Date.now());
    if (pauseMs > 0) await new Promise<void>(resolve => setTimeout(resolve, pauseMs));
  }
}

// A mislabeled bundle can survive a restart with the same stale version.
// Persist that result because each hook runs in a fresh process. Replacing the
// bundle (even without a version bump) makes it eligible for another attempt.
function workerBuildKey(script: WorkerScriptCandidate | null, expectedVersion: string): string | null {
  if (!script) return null;
  try {
    const stat = statSync(script.scriptPath);
    return JSON.stringify([script.scriptPath, expectedVersion, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch {
    return null;
  }
}

function failedRecyclePath(): string {
  return path.join(resolveDataDir(), 'worker-version-recycle.json');
}

function alreadyRecycledBundle(buildKey: string | null, workerVersion: string | null): boolean {
  if (buildKey === null || workerVersion === null) return false;
  try {
    const previous = JSON.parse(readFileSync(failedRecyclePath(), 'utf-8'));
    return previous?.buildKey === buildKey && previous?.workerVersion === workerVersion;
  } catch {
    return false;
  }
}

async function warnIfVersionStillMismatched(
  expectedPluginVersion: string,
  buildKey: string | null = null,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<void> {
  const observedVersion = await fetchWorkerHealthVersion(timeoutMs);
  if (observedVersion !== null && observedVersion !== expectedPluginVersion) {
    if (buildKey !== null) {
      try {
        writeJsonFileAtomic(failedRecyclePath(), { buildKey, workerVersion: observedVersion });
      } catch (error: unknown) {
        logger.warn('SYSTEM', 'Could not persist the failed worker version recycle', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.warn('SYSTEM', 'Worker is ready but still reports a stale version; rebuild or reinstall the worker bundle before retrying', {
      pluginVersion: expectedPluginVersion,
      workerVersion: observedVersion,
    });
  }
}

/**
 * How long the SAME worker pid must stay unresponsive (accepts connections,
 * then goes silent before or after the /api/ready headers) across hook events before it is treated as
 * wedged and recycled. Comfortably above bun:sqlite's 5 s busy_timeout
 * (src/services/sqlite/connection.ts), which blocks the worker's event loop
 * under lock contention, and above any single boot stall — so a worker that
 * is merely slow is never SIGKILLed on one hook's 5 s of silence.
 */
const UNRESPONSIVE_WORKER_WEDGED_AFTER_MS = 30_000;

interface UnresponsiveWorkerRecord {
  pid: number;
  firstUnresponsiveAtEpochMs: number;
}

function unresponsiveWorkerRecordPath(): string {
  return path.join(resolveDataDir(), 'worker-unresponsive.json');
}

function readUnresponsiveWorkerRecord(): UnresponsiveWorkerRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(unresponsiveWorkerRecordPath(), 'utf-8')) as Partial<UnresponsiveWorkerRecord>;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.firstUnresponsiveAtEpochMs !== 'number') return null;
    return { pid: parsed.pid, firstUnresponsiveAtEpochMs: parsed.firstUnresponsiveAtEpochMs };
  } catch {
    return null;
  }
}

function clearUnresponsiveWorkerRecord(): void {
  const recordPath = unresponsiveWorkerRecordPath();
  if (!existsSync(recordPath)) return;
  try {
    unlinkSync(recordPath);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Could not clear the unresponsive-worker record', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Silence from the worker on the port (before or after /api/ready headers). True ⇒ the same pid has been
 * unresponsive for UNRESPONSIVE_WORKER_WEDGED_AFTER_MS across hooks: treat it
 * as wedged. False ⇒ record (or keep) the first sighting and leave it alone.
 */
function unresponsiveWorkerIsWedged(nowEpochMs: number = Date.now()): boolean {
  const ownerPid = readOwnedWorkerPidInfo()?.pid ?? null;
  // Without a pid there is nothing to track across hooks, and nothing a
  // recycle could kill: never escalate.
  if (ownerPid === null) return false;
  const previous = readUnresponsiveWorkerRecord();
  if (previous !== null && previous.pid === ownerPid) {
    return nowEpochMs - previous.firstUnresponsiveAtEpochMs >= UNRESPONSIVE_WORKER_WEDGED_AFTER_MS;
  }
  try {
    writeJsonFileAtomic(unresponsiveWorkerRecordPath(), { pid: ownerPid, firstUnresponsiveAtEpochMs: nowEpochMs });
  } catch (error: unknown) {
    logger.warn('SYSTEM', 'Could not persist the unresponsive-worker record', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

/**
 * Restart-storm guard for never-ready recycles (#3378 shape). A worker whose
 * boot fails deterministically (corrupt DB, bad migration) reports `failed`
 * within ~1 s; without this every hook would SIGKILL and respawn it. Keyed on
 * (build key + failure message), like worker-version-recycle.json: a new
 * bundle or a different failure earns another attempt, the same failure from
 * the same bundle does not. A worker reaching `ready` clears it.
 */
interface NeverReadyRecycleRecord {
  buildKey: string;
  failureMessage: string;
  refusalLogged?: boolean;
}

function neverReadyRecyclePath(): string {
  return path.join(resolveDataDir(), 'worker-never-ready-recycle.json');
}

function readNeverReadyRecycleRecord(): NeverReadyRecycleRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(neverReadyRecyclePath(), 'utf-8')) as Partial<NeverReadyRecycleRecord>;
    if (typeof parsed?.buildKey !== 'string' || typeof parsed?.failureMessage !== 'string') return null;
    return { buildKey: parsed.buildKey, failureMessage: parsed.failureMessage, refusalLogged: parsed.refusalLogged === true };
  } catch {
    return null;
  }
}

function writeNeverReadyRecycleRecord(record: NeverReadyRecycleRecord): void {
  try {
    writeJsonFileAtomic(neverReadyRecyclePath(), record);
  } catch (error: unknown) {
    logger.warn('SYSTEM', 'Could not persist the never-ready worker recycle', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function clearNeverReadyRecycleRecord(): void {
  const recordPath = neverReadyRecyclePath();
  if (!existsSync(recordPath)) return;
  try {
    unlinkSync(recordPath);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Could not clear the never-ready worker recycle record', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A stat-less bundle still needs a stable key, or the guard could never match. */
function neverReadyBuildKey(script: WorkerScriptCandidate | null): string {
  return workerBuildKey(script, script?.version ?? 'unknown') ?? 'unresolved-worker-bundle';
}

/**
 * The (build key, failure message) pair a never-ready recycle is keyed on.
 * `failed` carries the worker's own message; wedged/unresponsive are keyed on
 * the outcome, since their observed detail varies run to run.
 */
function neverReadyFailureMessage(readiness: WorkerReadyResult): string {
  return readiness.outcome === 'failed' ? (readiness.detail ?? 'unknown init failure') : readiness.outcome;
}

/**
 * Decide whether a same-version, not-ready worker may be recycled now.
 * still_booting / not_running are never recycled; unresponsive only once it
 * has been unresponsive long enough (see UNRESPONSIVE_WORKER_WEDGED_AFTER_MS);
 * failed / wedged (and long-unresponsive) are subject to the storm guard.
 */
function neverReadyWorkerMayBeRecycled(readiness: WorkerReadyResult, buildKey: string): boolean {
  if (readiness.outcome === 'unresponsive' && !unresponsiveWorkerIsWedged()) {
    logger.warn('SYSTEM', 'Worker went silent on /api/ready; skipping this hook without killing it', {
      detail: readiness.detail,
      wedgedAfterMs: UNRESPONSIVE_WORKER_WEDGED_AFTER_MS,
    });
    return false;
  }
  const failureMessage = neverReadyFailureMessage(readiness);
  const previous = readNeverReadyRecycleRecord();
  if (previous !== null && previous.buildKey === buildKey && previous.failureMessage === failureMessage) {
    if (!previous.refusalLogged) {
      logger.error('SYSTEM', 'Worker keeps failing to start the same way after a recycle; not recycling again. Run `npx claude-mem doctor` and check the worker logs', {
        outcome: readiness.outcome,
        failureMessage,
        logsDir: path.join(resolveDataDir(), 'logs'),
      });
      writeNeverReadyRecycleRecord({ ...previous, refusalLogged: true });
    } else {
      logger.debug('SYSTEM', 'Never-ready worker recycle already refused for this bundle and failure', { failureMessage });
    }
    return false;
  }
  return true;
}

function recordNeverReadyRecycle(readiness: WorkerReadyResult, buildKey: string): void {
  writeNeverReadyRecycleRecord({ buildKey, failureMessage: neverReadyFailureMessage(readiness) });
  clearUnresponsiveWorkerRecord();
}

async function isWorkerPortAlive(deadline: number = Number.POSITIVE_INFINITY): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;
  let healthy: boolean;
  try {
    healthy = await isWorkerHealthy(Math.min(HEALTH_CHECK_TIMEOUT_MS, remainingMs));
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Worker health check threw', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  return healthy;
}

/**
 * SIGKILL the worker that owns the port (its whole process tree) and wait for
 * the port to become bindable again. True ⇒ a successor may be spawned.
 * Shared by the version-mismatch and wedged-worker recycles.
 */
async function killWorkerForRecycle(
  deadlineAt: number | null,
  outOfBudget: (step: string) => boolean,
): Promise<boolean> {
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
  // #3482 — a single-PID kill here orphans the stale worker's whole spawn
  // chain (uvx -> uv -> python -> chroma-mcp). Those descendants inherited
  // the worker's listening socket, so they keep the port bound after the
  // root dies: waitForWorkerPortReleased() below never succeeds, every hook
  // hard-blocks, and the recycle repeats forever (834 health-check failures
  // observed). This is NOT Windows-specific — on POSIX the same descendants
  // simply re-parent to init and survive identically.
  //
  // 'immediate' is required, not incidental: it sends SIGKILL with no
  // SIGTERM and no grace window, so the #3378 invariant above still holds
  // exactly as written — SIGKILL is uncatchable, so zero stale-version
  // shutdown code runs anywhere in the tree. A graceful tree-kill would let
  // the stale worker execute the dying install's handoff logic, which is the
  // restart storm that invariant exists to prevent.
  //
  // With the budget spent, leave the recycle to the next hook event rather
  // than kill a worker this hook could not wait to replace.
  if (outOfBudget('stale-worker recycle')) return false;
  try {
    await killProcessTree(stalePidInfo.pid, { signalMode: 'immediate' });
  } catch (error: unknown) {
    logger.error('SYSTEM', 'Could not kill stale worker', {
      pid: stalePidInfo.pid,
      port: stalePidInfo.port,
    }, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
  if (!(await waitForWorkerPortReleased(boundedByBudget(5000, deadlineAt)))) {
    // A spent hook budget cut the wait short, which is no evidence of an
    // orphaned socket: leave the diagnosis to a hook that waits it out.
    if (outOfBudget('stale port release')) return false;
    // The worker we killed is gone and its port still cannot be bound: an
    // orphaned OS socket. Name the fix in the fail-loud message (#4002)
    // instead of spawning a successor that could never listen.
    orphanedPortDiagnosis = getWorkerPort();
    logger.error('SYSTEM', 'Stale worker port still open after SIGKILL; skipping spawn this hook event', {
      pid: stalePidInfo.pid,
      port: getWorkerPort(),
      fix: ORPHANED_PORT_REMEDIATION,
    });
    return false;
  }
  return true;
}

export async function ensureWorkerRunning(timeoutMs?: number): Promise<boolean> {
  // #3434 / plan-17 step 3: a caller spending a hook deadline (UserPromptSubmit
  // session-init) passes its budget. Every probe, wait and spawn step below is
  // cut to what is left of it, and a spent budget skips the remaining steps,
  // so the hook returns its fallback before the host kills it. Callers without
  // a deadline keep the standalone per-step timeouts.
  const deadlineAt = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  const outOfBudget = (step: string): boolean => {
    if (!isBudgetExhausted(deadlineAt)) return false;
    logger.warn('SYSTEM', 'Worker check ran out of the hook budget; skipping the rest this hook event', {
      step,
      budgetMs: timeoutMs,
    });
    return true;
  };
  // Budgeted probe timeouts; undefined keeps each callee's own default.
  const probeTimeoutMs = (): number | undefined =>
    deadlineAt === null ? undefined : boundedByBudget(HEALTH_CHECK_TIMEOUT_MS, deadlineAt);
  // #3171: the pre-spawn probes (health check, port classification) share a
  // 5 s bound, cut further by the caller's budget.
  const preSpawnDeadline = Math.min(Date.now() + 5000, deadlineAt ?? Number.POSITIVE_INFINITY);

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
  let recycleBuildKey: string | null = null;
  let recycledStaleWorker = false;
  // Set only when a same-version worker is recycled for never becoming ready,
  // so the storm guard records the recycle once the kill succeeds.
  let neverReadyReadiness: WorkerReadyResult | null = null;
  let neverReadyRecycleBuildKey: string | null = null;
  // CLAUDE_MEM_WORKER_AUTOSTART=false: use a running worker, but never launch,
  // kill or recycle one (see worker-autostart.ts).
  const autostartDisabled = isWorkerAutostartDisabled(loadFromFileOnce());

  if (outOfBudget('health probe')) return false;
  if (await isWorkerPortAlive(preSpawnDeadline)) {
    // A worker is already alive. If it is a DIFFERENT version than the one
    // this resolution would spawn (e.g. the user upgraded but the previous
    // worker is still squatting the port), recycle it so the resolved
    // version takes over — otherwise the stale worker keeps serving
    // indefinitely.
    if (outOfBudget('version probe')) return false;
    const { matches, pluginVersion, workerVersion } = await checkVersionMatch(
      getWorkerPort(),
      resolvedScript?.version ?? null,
      probeTimeoutMs(),
    );
    if (pluginVersion !== 'unknown') {
      expectedPluginVersion = pluginVersion;
    }
    if (matches) {
      if (outOfBudget('readiness wait')) return false;
      const readiness = await waitForWorkerReadiness(boundedByBudget(HOOK_READINESS_TIMEOUT_MS, deadlineAt));
      if (readiness.outcome === 'ready') {
        if (expectedPluginVersion !== null && !isBudgetExhausted(deadlineAt)) {
          await warnIfVersionStillMismatched(expectedPluginVersion, null, probeTimeoutMs());
        }
        return true;
      }

      // Same version, not ready. /api/ready tells the cases apart: progress
      // still arriving ⇒ booting, leave it alone; `failed`, silence past the
      // idle window after headers, or a close without a terminal phase ⇒ its
      // init died and it will NEVER become ready — recycle it, since the
      // version matches and nothing else will. Pre-header silence
      // (`unresponsive`) and repeated identical failures are gated in
      // neverReadyWorkerMayBeRecycled.
      if (readiness.outcome === 'still_booting' || readiness.outcome === 'not_running') {
        logger.warn('SYSTEM', 'Worker is healthy but not ready yet; skipping hook API call', {
          outcome: readiness.outcome,
          detail: readiness.detail,
        });
        return false;
      }

      if (autostartDisabled) {
        logger.warn('SYSTEM', 'Worker will never become ready; CLAUDE_MEM_WORKER_AUTOSTART=false, so leaving it to whatever manages it', {
          outcome: readiness.outcome,
          detail: readiness.detail,
        });
        return false;
      }

      neverReadyRecycleBuildKey = neverReadyBuildKey(resolvedScript);
      if (!neverReadyWorkerMayBeRecycled(readiness, neverReadyRecycleBuildKey)) return false;
      neverReadyReadiness = readiness;

      logger.info('SYSTEM', 'Worker will never become ready — recycling wedged worker', {
        outcome: readiness.outcome,
        detail: readiness.detail,
        version: workerVersion,
      });
    } else {
      if (autostartDisabled) {
        logger.warn('SYSTEM', 'Worker version differs from the installed plugin; CLAUDE_MEM_WORKER_AUTOSTART=false, so using it as is', {
          pluginVersion,
          workerVersion,
        });
        if (outOfBudget('readiness wait')) return false;
        return (await waitForWorkerReadiness(boundedByBudget(HOOK_READINESS_TIMEOUT_MS, deadlineAt))).outcome === 'ready';
      }
      // The version-mismatch recycle keeps its own guard: an unchanged bundle
      // that still reports a stale version must not be recycled again. The
      // wedged-worker branch above deliberately has no such guard — its bundle
      // is not stale, its init died, and each recycle is a fresh attempt.
      recycleBuildKey = workerBuildKey(resolvedScript, pluginVersion);
      if (alreadyRecycledBundle(recycleBuildKey, workerVersion)) {
        logger.warn('SYSTEM', 'Skipping repeated worker recycle: the unchanged bundle still reports a stale version; rebuild or reinstall it', {
          pluginVersion,
          workerVersion,
          scriptPath: resolvedScript?.scriptPath,
        });
        if (outOfBudget('readiness wait')) return false;
        return (await waitForWorkerReadiness(boundedByBudget(HOOK_READINESS_TIMEOUT_MS, deadlineAt))).outcome === 'ready';
      }

      logger.info('SYSTEM', 'Worker version mismatch — killing stale worker', {
        pluginVersion,
        workerVersion,
      });
    }
    if (!(await killWorkerForRecycle(deadlineAt, outOfBudget))) return false;
    if (neverReadyReadiness !== null && neverReadyRecycleBuildKey !== null) {
      recordNeverReadyRecycle(neverReadyReadiness, neverReadyRecycleBuildKey);
    }
    recycledStaleWorker = true;
    // The killed worker's PID file is left behind; the successor's boot
    // removes it (validateWorkerPidFile returns 'stale' for a dead pid).
    // Fall through to (re)spawn + readiness wait below.
  }

  if (autostartDisabled) {
    // No worker is up and hooks may not start one; the caller's fallback
    // reports worker_autostart_disabled without counting a failure.
    logger.debug('SYSTEM', 'Worker not running and CLAUDE_MEM_WORKER_AUTOSTART=false — not lazy-spawning');
    return false;
  }

  const scriptPath = resolvedScript?.scriptPath ?? null;

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
  if (outOfBudget('lazy spawn')) return false;
  const spawnLockHeld = acquireSpawnLock();
  try {
    if (spawnLockHeld) {
      // A stale worker we just killed already proved its port closed
      // (waitForWorkerPortReleased); every other spawn must first prove the port
      // free (#3171).
      if (!recycledStaleWorker && !(await preSpawnPortIsFree(preSpawnDeadline, deadlineAt))) return false;
      const runtimePath = resolveWorkerRuntimePath();
      if (!runtimePath) {
        logger.warn('SYSTEM', 'Cannot lazy-spawn worker: Bun runtime not found (PATH, BUN / BUN_PATH / BUN_INSTALL, or ~/.bun/bin)');
        return false;
      }
      if (!scriptPath) {
        logger.warn('SYSTEM', 'Cannot lazy-spawn worker: worker-service.cjs not found in plugin/scripts');
        return false;
      }
      logger.info('SYSTEM', 'Worker not running — lazy-spawning', { runtimePath, scriptPath });

      try {
        // Windows: Start-Process -WindowStyle Hidden (never Node detached —
        // detached allocates its own console on win32, #3521). POSIX: setsid /
        // detached. Either way the daemon's cwd is claude-mem's data dir, not
        // the user's project that this hook inherited: a daemon holds its cwd
        // open for its whole life, and on Windows that locks the folder against
        // rename or move long after the session ends (#3706). The helper also
        // listens for the async spawn 'error' (a dangling runtime shim), which
        // would otherwise escape as an uncaught exception (#4039).
        // A budgeted hook caps the Windows launch (a synchronous PowerShell
        // Start-Process) at what is left of its deadline.
        const spawned = spawnDetachedWorkerDaemon(
          runtimePath,
          scriptPath,
          sanitizeEnv({
            ...process.env,
            CLAUDE_MEM_WORKER_PORT: String(getWorkerPort()),
          }),
          process.platform,
          remainingBudgetMs(deadlineAt) ?? undefined,
        );
        if (spawned === undefined) {
          return false;
        }
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
    const alive = await waitForWorkerPort({ attempts: 6, backoffMs: 500, deadlineAt });
    if (!alive) {
      // A budget cut the cold-boot wait short, so the zombie diagnosis below
      // (which needs the full wait) cannot tell a late bind from an orphan.
      if (outOfBudget('cold-boot port wait')) return false;
      logger.warn('SYSTEM', spawnLockHeld
        ? 'Worker port did not open after lazy-spawn within the cold-boot wait (~15s)'
        : 'Spawn-lock holder\'s worker port did not open within the cold-boot wait (~15s)');
      // Zombie-socket diagnosis. Only reachable once the full cold-boot wait
      // has expired, so a worker that merely bound late (server.listen runs
      // BEFORE writePidFile — a warming worker legitimately has an occupied
      // port and no PID file) has already had its chance to answer. If the
      // port is STILL occupied with no reachable worker and no PID file
      // naming a killable owner, the socket is orphaned at the OS level:
      // Windows can leave a LISTEN socket behind for a process that no
      // longer exists. Every future spawn is doomed — the new daemon's
      // duplicate-gate sees the occupied port and exit(0)s without binding —
      // so name the actual fix instead of letting the generic "unreachable"
      // counter climb forever.
      if (
        readOwnedWorkerPidInfo() === null
        && (await isPortInUse(getWorkerPort(), deadlineAt === null ? undefined : boundedByBudget(5000, deadlineAt)))
      ) {
        orphanedPortDiagnosis = getWorkerPort();
        logger.error('SYSTEM', 'Worker port is occupied by an unreachable process that no PID file claims (likely an orphaned OS socket); every lazy-spawn on this port will be silently refused', {
          port: orphanedPortDiagnosis,
          fix: ORPHANED_PORT_REMEDIATION,
        });
      }
      return false;
    }
  } finally {
    if (spawnLockHeld) releaseSpawnLock();
  }
  if (outOfBudget('readiness wait')) return false;
  const readiness = await waitForWorkerReadiness(boundedByBudget(HOOK_READINESS_TIMEOUT_MS, deadlineAt));
  if (readiness.outcome !== 'ready') {
    // A fresh worker that reports failed/wedged is left for the next hook
    // event's recycle: recycling it again here would loop inside one hook.
    logger.warn('SYSTEM', 'Worker lazy-spawned but did not become ready before hook readiness timeout', {
      outcome: readiness.outcome,
      detail: readiness.detail,
    });
    return false;
  }
  // Remember a failed version change across hook invocations, so a stale
  // bundled artifact cannot trigger a restart on every tool call.
  if (expectedPluginVersion !== null && !isBudgetExhausted(deadlineAt)) {
    await warnIfVersionStillMismatched(expectedPluginVersion, recycleBuildKey, probeTimeoutMs());
  }
  return true;
}

const ORPHANED_PORT_REMEDIATION =
  'Set CLAUDE_MEM_WORKER_PORT to a different port in claude-mem settings, or reboot to release the stuck port';

/**
 * Port number diagnosed as holding an orphaned OS socket during this hook
 * process, or null if that condition was never observed. Set by
 * ensureWorkerRunning and read by recordWorkerUnreachable so the fail-loud
 * message names the fix. Process-scoped deliberately: it is only ever set
 * from a fresh probe earlier in the same invocation, so it cannot go stale
 * across a reboot or a port change the way a persisted flag could.
 */
let orphanedPortDiagnosis: number | null = null;

/** Port this hook process found unbindable (EACCES / EADDRNOTAVAIL), or null. Same scoping as above. */
let unbindablePortDiagnosis: number | null = null;

/**
 * The hook's pre-spawn port gate (#3171, plan-15 steps 2-3). A failed health
 * request is not proof the port is free: a wedged or orphaned listener refuses
 * HTTP yet keeps the port bound, and every hook that lazy-spawned onto it added
 * another doomed daemon. So only a bind decides, within the caller's budget:
 * - free → spawn;
 * - occupied → one reclaim attempt (a dead owner's ghost listener, or a
 *   provably wedged worker of ours, see port-reclaim.ts). Spawn only if it
 *   freed the port; when it declines and no PID file claims the listener,
 *   record the orphaned port so the fail-loud message names the fix (#4002);
 * - indeterminate (the bind neither succeeded nor hit EADDRINUSE in time) →
 *   no spawn: never start another worker onto a port in an unknown state.
 */
async function preSpawnPortIsFree(deadline: number, hookDeadlineAt: number | null): Promise<boolean> {
  const port = getWorkerPort();
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;

  const occupancy = await classifyPortOccupancy(port, remainingMs);
  if (occupancy === 'free') return true;
  if (occupancy === 'unbindable') {
    // The OS refuses the bind itself (EACCES / EADDRNOTAVAIL): a daemon would
    // die at listen() on every hook event. Name the fix instead of spawning.
    unbindablePortDiagnosis = port;
    logger.error('SYSTEM', 'Worker port cannot be bound (EACCES or EADDRNOTAVAIL) — skipping lazy-spawn', {
      port,
      host: getWorkerHost(),
      fix: UNBINDABLE_PORT_REMEDIATION,
    });
    return false;
  }
  if (occupancy === 'indeterminate') {
    logger.warn('SYSTEM', 'Worker port state could not be determined in time — skipping lazy-spawn', { port });
    return false;
  }

  // The reclaim gets the hook's own deadline, not the 5 s probe bound: it
  // declines ('out-of-budget') rather than start a kill it cannot finish
  // before the host kills the hook, and runs unbounded for callers without one.
  const reclaim = await reclaimGhostListeningPort(port, { deadlineAt: hookDeadlineAt });
  if (reclaim.reclaimed) {
    logger.info('SYSTEM', 'Reclaimed the worker port before lazy-spawn', { port, killedPids: reclaim.killedPids });
    return true;
  }
  if (readOwnedWorkerPidInfo() === null) {
    orphanedPortDiagnosis = port;
  }
  logger.warn('SYSTEM', 'Worker port is held by a listener that does not answer health — skipping lazy-spawn', {
    port,
    reclaimReason: reclaim.reason,
    ...(orphanedPortDiagnosis === port ? { fix: ORPHANED_PORT_REMEDIATION } : {}),
  });
  return false;
}

let aliveCache: boolean | null = null;

export async function ensureWorkerAliveOnce(timeoutMs?: number): Promise<boolean> {
  if (aliveCache !== null) return aliveCache;
  aliveCache = await ensureWorkerRunning(timeoutMs);
  return aliveCache;
}

/**
 * Bounded startup for callers with their own short budget (Codex, SessionEnd):
 * one /api/ready read decides. Ready ⇒ go. Failed or wedged ⇒ recycle (kill,
 * then spawn a fresh worker), subject to neverReadyWorkerMayBeRecycled's
 * unresponsive window and storm guard. Not running ⇒ spawn. Only "nothing is listening
 * yet" is retried, because a just-spawned worker has not bound its port.
 */
async function ensureWorkerReadyWithin(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => deadline - Date.now();
  const outOfBudget = (step: string): boolean => {
    if (remainingMs() >= MIN_WORKER_BUDGET_MS) return false;
    logger.debug('SYSTEM', 'Bounded worker startup ran out of budget', { step, budgetMs: timeoutMs });
    return true;
  };

  const first = await waitForWorkerReadiness(Math.max(1, remainingMs()));
  if (first.outcome === 'ready') return true;
  if (first.outcome === 'still_booting') {
    // Progress is still arriving: leave the booting worker alone, skip this call.
    logger.warn('SYSTEM', 'Worker is still booting; bounded startup budget spent, skipping this call', {
      detail: first.detail,
      budgetMs: timeoutMs,
    });
    return false;
  }

  // CLAUDE_MEM_WORKER_AUTOSTART=false: wait out the budget for the externally
  // managed worker, but never kill, take the spawn lock or launch one.
  const mayLaunch = !isWorkerAutostartDisabled(loadFromFileOnce());
  if (!mayLaunch) return waitForWorkerToListen(deadline);

  const runtimePath = resolveWorkerRuntimePath();
  const scriptPath = resolveWorkerScriptPath();
  if (!runtimePath || !scriptPath) return false;

  if (first.outcome === 'failed' || first.outcome === 'wedged' || first.outcome === 'unresponsive') {
    const buildKey = neverReadyBuildKey(resolveWorkerScript());
    if (!neverReadyWorkerMayBeRecycled(first, buildKey)) return false;
    logger.info('SYSTEM', 'Worker will never become ready — recycling wedged worker', {
      outcome: first.outcome,
      detail: first.detail,
    });
    if (!(await killWorkerForRecycle(deadline, outOfBudget))) return false;
    recordNeverReadyRecycle(first, buildKey);
  }

  const spawnLockHeld = acquireSpawnLock();
  try {
    if (spawnLockHeld) {
      // Same launch as ensureWorkerRunning: hidden on Windows (#3521) and
      // with the daemon's cwd pinned to the data dir, not the caller's project
      // (#3706).
      const spawned = spawnDetachedWorkerDaemon(
        runtimePath,
        scriptPath,
        sanitizeEnv({
          ...process.env,
          CLAUDE_MEM_WORKER_PORT: String(getWorkerPort()),
        }),
        process.platform,
        Math.max(1, remainingMs()),
      );
      if (spawned === undefined) return false;
    }
    return await waitForWorkerToListen(deadline);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Bounded worker startup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (spawnLockHeld) releaseSpawnLock();
  }
}

/**
 * Re-read /api/ready until the deadline while nothing is listening yet (a
 * just-spawned worker binds its port after a short boot). Any other outcome
 * is final for this call.
 */
async function waitForWorkerToListen(deadline: number): Promise<boolean> {
  while (deadline - Date.now() > 0) {
    const readiness = await waitForWorkerReadiness(Math.max(1, deadline - Date.now()));
    if (readiness.outcome === 'ready') return true;
    if (readiness.outcome !== 'not_running') {
      logger.debug('SYSTEM', 'Bounded worker startup did not reach ready', {
        outcome: readiness.outcome,
        detail: readiness.detail,
      });
      return false;
    }
    const waitMs = Math.min(100, deadline - Date.now());
    if (waitMs > 0) await new Promise<void>(resolve => setTimeout(resolve, waitMs));
  }
  return false;
}

interface HookFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
  thresholdTripped: boolean;
  /**
   * Sessions that already got this outage's user notice (see
   * consumeWorkerOutageNotice). Cleared with the rest of the state when the
   * worker answers again, so the next outage notifies every session anew.
   */
  notifiedSessionIds?: string[];
}

const FAIL_LOUD_DEFAULT_THRESHOLD = 3;
/** Bounds the notified-session list so the state file stays tiny in a long outage. */
const MAX_NOTIFIED_SESSION_IDS = 20;
const HOOK_FAILURE_LOCK_WAIT_MS = 1_000;
const HOOK_FAILURE_LOCK_RETRY_MS = 10;
const HOOK_FAILURE_LOCK_STALE_MS = 5_000;
const HOOK_FAILURE_RESET_LOCK_WAIT_MS = HOOK_FAILURE_LOCK_STALE_MS + HOOK_FAILURE_LOCK_WAIT_MS;

function getStateDir(): string {
  return path.join(DATA_DIR, 'state');
}

function getHookFailuresPath(): string {
  return path.join(getStateDir(), 'hook-failures.json');
}

function getHookFailuresLockPath(): string {
  return path.join(getStateDir(), 'hook-failures.lock');
}

async function acquireHookFailureLock(waitMs = HOOK_FAILURE_LOCK_WAIT_MS): Promise<string | null> {
  const stateDir = getStateDir();
  const lockPath = getHookFailuresLockPath();
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token });
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(lockPath, payload, { flag: 'wx' });
      return token;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        logger.warn('SYSTEM', 'Hook-failure lock unavailable; skipping failure-state update', {
          lockPath,
          code,
        }, err);
        return null;
      }

      let mtimeMs: number;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }

      if (Date.now() - mtimeMs > HOOK_FAILURE_LOCK_STALE_MS) {
        let recheckedMtimeMs: number;
        try {
          recheckedMtimeMs = statSync(lockPath).mtimeMs;
        } catch {
          continue;
        }
        if (recheckedMtimeMs === mtimeMs) {
          try {
            unlinkSync(lockPath);
            continue;
          } catch {
            // Another stale-lock breaker won, or the filesystem refused the
            // removal. Retry within the bounded wait instead of failing loud.
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, HOOK_FAILURE_LOCK_RETRY_MS));
    }
  }

  logger.warn('SYSTEM', 'Timed out waiting for hook-failure lock; skipping failure-state update', {
    lockPath,
    waitMs,
  });
  return null;
}

function releaseHookFailureLock(token: string): void {
  const lockPath = getHookFailuresLockPath();
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token?: unknown };
    if (lock.token !== token) return;
    unlinkSync(lockPath);
  } catch {
    // Missing, unreadable, or foreign lock: never remove a lock this process
    // cannot prove it owns. Stale locks self-heal during acquisition.
  }
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
    // Backward-compatible migration: state files written before this field
    // existed must still escalate once if their count already exceeds a
    // subsequently lowered threshold.
    thresholdTripped: parsed.thresholdTripped === true,
    notifiedSessionIds: Array.isArray(parsed.notifiedSessionIds)
      ? parsed.notifiedSessionIds
        .filter((sessionId): sessionId is string => typeof sessionId === 'string')
        .slice(-MAX_NOTIFIED_SESSION_IDS)
      : undefined,
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
    return { consecutiveFailures: 0, lastFailureAt: 0, thresholdTripped: false };
  }
}

function writeHookFailureStateAtomic(state: HookFailureState): boolean {
  const stateDir = getStateDir();
  const dest = getHookFailuresPath();
  const tmp = `${dest}.tmp`;
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, dest);
    return true;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to persist hook-failure counter', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
const TELEMETRY_HOOK_TYPES = ['context', 'session-init', 'observation', 'summarize', 'session-end', 'file-context'] as const;
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

/**
 * The worker-outage notice. The worker is an optional background service, so
 * the notice only ever informs: it says memory is degraded, that nothing was
 * blocked, and how to recover. When this hook process diagnosed an orphaned
 * port, the port fix replaces the generic recovery hint.
 */
function buildWorkerOutageNotice(consecutiveFailures: number): string {
  const recovery = unbindablePortDiagnosis !== null
    ? `The worker cannot bind port ${unbindablePortDiagnosis} on ${getWorkerHost()}: the system refuses it (EACCES or EADDRNOTAVAIL). ${UNBINDABLE_PORT_REMEDIATION}.`
    : orphanedPortDiagnosis !== null
      ? `Port ${orphanedPortDiagnosis} is held by an unreachable process that no PID file claims, so the worker cannot bind it. ${ORPHANED_PORT_REMEDIATION}.`
      : 'Run `npx claude-mem restart`; if it keeps failing, run `npx claude-mem doctor`.';
  return `claude-mem worker unreachable for ${consecutiveFailures} consecutive hooks — memory features are degraded, but your prompts are not blocked. ${recovery}`;
}

export function isWorkerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  const transportPatterns = [
    'econnrefused',
    'econnreset',
    'epipe',
    'etimedout',
    'enotfound',
    'econnaborted',
    'enetunreach',
    'ehostunreach',
    'fetch failed',
    'unable to connect',
    'socket hang up',
    'socket connection was closed',
    'connection closed',
  ];
  if (transportPatterns.some(p => lower.includes(p))) return true;

  if (lower.includes('timed out') || lower.includes('timeout')) return true;

  if (/failed:\s*5\d{2}/.test(message) || /status[:\s]+5\d{2}/.test(message)) return true;

  if (/failed:\s*429/.test(message) || /status[:\s]+429/.test(message)) return true;

  if (/failed:\s*4\d{2}/.test(message) || /status[:\s]+4\d{2}/.test(message)) return false;

  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
    return false;
  }

  return false;
}

let workerUnreachableScopeActive = false;
let workerUnreachableRecordedThisProcess = false;

/**
 * Open a per-hook-process scope for recordWorkerUnreachable. hookCommand calls
 * this at the start of each invocation so the fail-loud counter is incremented
 * at most once per hook process, not once per worker API attempt within a
 * composite handler. Callers outside a hook invocation are not deduplicated.
 */
export function resetWorkerUnreachableState(): void {
  workerUnreachableScopeActive = true;
  workerUnreachableRecordedThisProcess = false;
}

/**
 * Count one worker-unreachable hook. Never blocks and never exits: a memory
 * outage must not stop the user's prompt, Read or Stop (plan-17 step 2).
 *
 * When the count first reaches the fail-loud threshold, the latch trips once
 * per outage: send hook_failed telemetry and write the notice to stderr as an
 * operator diagnostic. The user sees the notice through
 * consumeWorkerOutageNotice on the next synchronous hook.
 */
export async function recordWorkerUnreachable(): Promise<number> {
  // The counter tracks consecutive hook invocations (processes), not individual
  // worker API attempts: a composite handler (e.g. Kimi's session-init-context)
  // can hit the unreachable worker more than once in one process.
  if (workerUnreachableScopeActive) {
    if (workerUnreachableRecordedThisProcess) {
      return readHookFailureState().consecutiveFailures;
    }
    workerUnreachableRecordedThisProcess = true;
  }

  const lockToken = await acquireHookFailureLock();
  if (lockToken === null) {
    return readHookFailureState().consecutiveFailures;
  }

  let next: HookFailureState;
  let shouldEscalate = false;
  try {
    const state = readHookFailureState();
    next = {
      consecutiveFailures: state.consecutiveFailures + 1,
      lastFailureAt: Date.now(),
      thresholdTripped: state.thresholdTripped,
      notifiedSessionIds: state.notifiedSessionIds,
    };
    const threshold = getFailLoudThreshold();
    shouldEscalate = next.consecutiveFailures >= threshold && !next.thresholdTripped;
    if (shouldEscalate) next.thresholdTripped = true;
    const statePersisted = writeHookFailureStateAtomic(next);
    shouldEscalate = shouldEscalate && statePersisted;
  } finally {
    releaseHookFailureLock(lockToken);
  }

  if (shouldEscalate) {
    // hook_failed distress signal. The inter-process lock above makes the
    // read/check/latch/write transition exclusive, and the latched state is
    // durable before telemetry. The lock is deliberately released before any
    // side effect. Awaited so the hook process cannot exit mid-POST;
    // captureCliEvent never throws and is hard-capped at 2s, so this cannot
    // hang the hook. Closed-enum/count props only — never error text.
    // Transport is the direct CLI POST, never the worker API (the defining
    // failure here IS "worker unreachable").
    await captureCliEvent('hook_failed', {
      ...(activeHookType !== null ? { hook_type: activeHookType } : {}),
      error_mode: 'worker_unavailable',
      consecutive_failures: next.consecutiveFailures,
      threshold_tripped: true,
    });
    // DIAGNOSTIC only (stderr, bypassing the hook's stderr buffer). This used
    // to be emitBlockingError, whose exit 2 blocked the user's prompt on
    // UserPromptSubmit and denied Read on PreToolUse (#2966, #3481, #3523).
    emitDiagnostic(`${buildWorkerOutageNotice(next.consecutiveFailures)}\n`);
  }
  return next.consecutiveFailures;
}

/**
 * The user-facing half of the fail-loud path. Call it from the worker-fallback
 * branch of a SYNCHRONOUS hook (SessionStart context, UserPromptSubmit
 * session-init) and put the result in HookResult.systemMessage. Async hooks
 * must not call it: Claude Code hands an async hook's systemMessage to the
 * model on the next turn instead of showing it to the user.
 *
 * Returns the notice once per session per outage: only after the fail-loud
 * latch has tripped, and only if this session has not seen it yet. Returns
 * null otherwise, including when the state cannot be locked or persisted (a
 * notice that cannot be recorded as shown would repeat on every prompt).
 */
export async function consumeWorkerOutageNotice(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const lockToken = await acquireHookFailureLock();
  if (lockToken === null) return null;
  try {
    const state = readHookFailureState();
    const notifiedSessionIds = state.notifiedSessionIds ?? [];
    if (!state.thresholdTripped || notifiedSessionIds.includes(sessionId)) return null;
    const persisted = writeHookFailureStateAtomic({
      ...state,
      notifiedSessionIds: [...notifiedSessionIds, sessionId].slice(-MAX_NOTIFIED_SESSION_IDS),
    });
    return persisted ? buildWorkerOutageNotice(state.consecutiveFailures) : null;
  } finally {
    releaseHookFailureLock(lockToken);
  }
}

async function resetWorkerFailureCounter(): Promise<void> {
  // Recovery must outwait this lock's stale threshold. Returning after the
  // shorter failure-path bound can leave thresholdTripped set and suppress
  // the first escalation of the next outage.
  const lockToken = await acquireHookFailureLock(HOOK_FAILURE_RESET_LOCK_WAIT_MS);
  if (lockToken === null) return;
  try {
    const state = readHookFailureState();
    if (state.consecutiveFailures === 0 && !state.thresholdTripped) return;
    writeHookFailureStateAtomic({ consecutiveFailures: 0, lastFailureAt: 0, thresholdTripped: false });
  } finally {
    releaseHookFailureLock(lockToken);
  }
}

export async function __resetWorkerFailureCounterForTesting(): Promise<void> {
  await resetWorkerFailureCounter();
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
  /**
   * With workerStartupTimeoutMs: the request timeout alone. Without it: ONE
   * budget for the whole call, spent by the worker check first and then by
   * the request (#3434), so a synchronous hook stays inside its host timeout.
   */
  timeoutMs?: number;
  /** Bounded worker startup (Codex, SessionEnd): its own wait, separate from timeoutMs. */
  workerStartupTimeoutMs?: number;
}

export async function executeWithWorkerFallback<T = unknown>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  options: WorkerFallbackOptions = {},
): Promise<WorkerCallResult<T>> {
  const startedAt = Date.now();
  const boundedStartup = options.workerStartupTimeoutMs !== undefined;
  const alive = boundedStartup
    ? await ensureWorkerReadyWithin(options.workerStartupTimeoutMs!)
    : await ensureWorkerAliveOnce(options.timeoutMs);
  if (!alive) {
    // An externally managed worker (CLAUDE_MEM_WORKER_AUTOSTART=false) being
    // down is the operator's call, not a claude-mem failure: skip quietly and
    // never feed the fail-loud counter.
    if (isWorkerAutostartDisabled(loadFromFileOnce())) {
      return { continue: true, reason: 'worker_autostart_disabled', [WORKER_FALLBACK_BRAND]: true };
    }
    if (!boundedStartup) {
      await recordWorkerUnreachable();
    }
    return { continue: true, reason: 'worker_unreachable', [WORKER_FALLBACK_BRAND]: true };
  }

  const init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (options.timeoutMs !== undefined) {
    const requestTimeoutMs = boundedStartup
      ? options.timeoutMs
      : options.timeoutMs - (Date.now() - startedAt);
    if (requestTimeoutMs < MIN_WORKER_BUDGET_MS) {
      logger.debug('SYSTEM', 'Hook budget spent before the worker request; skipping it', { url });
      if (!boundedStartup) {
        await recordWorkerUnreachable();
      }
      return { continue: true, reason: 'worker_budget_exhausted', [WORKER_FALLBACK_BRAND]: true };
    }
    init.timeoutMs = requestTimeoutMs;
  }

  let response: Response;
  try {
    response = await workerHttpRequest(url, init);
  } catch (error) {
    if (!boundedStartup) throw error;
    logger.debug('SYSTEM', 'Worker unavailable for best-effort hook call', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { continue: true, reason: 'worker_unreachable', [WORKER_FALLBACK_BRAND]: true };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    await resetWorkerFailureCounter();
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

  // #3161: a worker that dies mid-body rejects text() with a socket error that
  // no transport pattern may match, and it would escape to hookCommand's
  // catch-all. Treat it as the unreachable worker it is. The streak is reset
  // only once the body has actually been read.
  let text: string;
  try {
    text = await response.text();
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Worker response body could not be read; treating the worker as unreachable', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!boundedStartup) {
      await recordWorkerUnreachable();
    }
    return { continue: true, reason: 'worker_body_read_failed', [WORKER_FALLBACK_BRAND]: true };
  }
  await resetWorkerFailureCounter();
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
