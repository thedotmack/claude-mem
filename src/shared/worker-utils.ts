import path from "path";
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { spawnHidden } from "./spawn.js";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, HOOK_EXIT_CODES, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT, DATA_DIR } from "./paths.js";
import { loadFromFileOnce } from "./hook-settings.js";
import { validateWorkerPidFile } from "../supervisor/index.js";

const HEALTH_CHECK_TIMEOUT_MS = (() => {
  const envVal = process.env.CLAUDE_MEM_HEALTH_TIMEOUT_MS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= 500 && parsed <= 300000) {
      return parsed;
    }
    logger.warn('SYSTEM', 'Invalid CLAUDE_MEM_HEALTH_TIMEOUT_MS, using default', {
      value: envVal, min: 500, max: 300000
    });
  }
  return getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);
})();

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

let cachedPort: number | null = null;
let cachedHost: string | null = null;

export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.CLAUDE_MEM_WORKER_HOST;
  return cachedHost;
}

export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
}

export function buildWorkerUrl(apiPath: string): string {
  return `http://${getWorkerHost()}:${getWorkerPort()}${apiPath}`;
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

async function isWorkerHealthy(): Promise<boolean> {
  const response = await workerHttpRequest('/api/health', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  return response.ok;
}

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

async function getWorkerVersion(): Promise<string> {
  const response = await workerHttpRequest('/api/version', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

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

  if (workerVersion === 'unknown') return;

  if (pluginVersion !== workerVersion) {
    logger.debug('SYSTEM', 'Version check', {
      pluginVersion,
      workerVersion,
      note: 'Mismatch will be auto-restarted by worker-service start command'
    });
  }
}

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

  const alive = await waitForWorkerPort({ attempts: 3, backoffMs: 250 });
  if (!alive) {
    logger.warn('SYSTEM', 'Worker port did not open after lazy-spawn within 3 attempts');
    return false;
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
