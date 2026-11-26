import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { isConnectionRefusedError } from '../shared/connection-errors.js';
import { expandHome } from '../shared/expand-home.js';
import { HOOK_TIMEOUTS, getTimeout } from '../shared/hook-constants.js';
import { getDefaultWorkerPort } from '../shared/install-port.js';
import { localApiTokenHeadersFor, normalizeLocalApiToken } from '../shared/local-api-token.js';
import { normalizeWorkerBaseUrl } from '../shared/worker-url.js';

const TIMEOUT_MS = 5_000;
const CONTEXT_TIMEOUT_BOUNDS = { min: 500, max: 300_000 } as const;

function dataDirectory(): string {
  return expandHome(process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem'));
}

function readHarnessSettingsFile(dataDir: string): Record<string, unknown> {
  try {
    const document = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    const nested = document?.env;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
      && Object.keys(nested).some(key => key.startsWith('CLAUDE_MEM_')) ? nested : document ?? {};
  } catch {
    // Settings are optional; environment overrides and per-user defaults remain usable.
    return {};
  }
}

function harnessSetting(dataDir = dataDirectory()): (key: string, fallback: string) => string {
  const settings = readHarnessSettingsFile(dataDir);
  return (key: string, fallback: string): string => {
    const value = settings[key];
    // The worker accepts numeric JSON ports and timeouts as well as strings.
    const saved = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
      ? String(value) : '';
    return process.env[key] || saved || fallback;
  };
}

/** This machine's worker by CLAUDE_MEM_WORKER_HOST and _PORT, as the worker binds it. */
function resolveHarnessHostPortOrigin(): string {
  const dataDir = dataDirectory();
  const setting = harnessSetting(dataDir);
  const configuredHost = setting('CLAUDE_MEM_WORKER_HOST', '127.0.0.1');
  const host = configuredHost === 'localhost' ? '127.0.0.1' : configuredHost;
  const port = setting('CLAUDE_MEM_WORKER_PORT', String(getDefaultWorkerPort(dataDir)));
  return 'http://' + (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + ':' + port;
}

/**
 * Where Pi and DSH reach the worker: CLAUDE_MEM_WORKER_URL when it is set, as for the hooks
 * (worker-utils getWorkerBaseUrl), otherwise host and port. Deriving host and port when a URL
 * is set would downgrade an https remote worker to http (#6390). An invalid URL throws
 * instead of falling back, as it does for the hooks.
 */
export function resolveHarnessWorkerUrl(): string {
  return normalizeWorkerBaseUrl(harnessSetting()('CLAUDE_MEM_WORKER_URL', '')) || resolveHarnessHostPortOrigin();
}

/**
 * The local API token (#5141) as request headers, when settings.json has one and `baseUrl` is
 * this machine's loopback worker at host and port, or the one remote host named in
 * CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST (#6390); `{}` otherwise. Decided by the shared rule
 * (localApiTokenHeadersFor). The token and the opt-in are read from settings.json alone, like
 * the worker reads them, so the environment cannot change what is sent or where. Any other
 * address, another loopback port included (it may be an SSH forward), never receives it.
 */
export function resolveHarnessAuthHeaders(baseUrl: string = resolveHarnessWorkerUrl()): Record<string, string> {
  const settings = readHarnessSettingsFile(dataDirectory());
  const token = normalizeLocalApiToken(settings.CLAUDE_MEM_LOCAL_API_TOKEN);
  if (!token) return {};
  try {
    return localApiTokenHeadersFor({
      token,
      workerOrigin: new URL(baseUrl).origin,
      // Host and port, never CLAUDE_MEM_WORKER_URL: a loopback URL there may be an SSH
      // forward to another machine's worker, so it must not count as this machine's.
      localOrigin: new URL(resolveHarnessHostPortOrigin()).origin,
      configuredHost: harnessSetting()('CLAUDE_MEM_WORKER_HOST', '127.0.0.1'),
      remoteTokenHost: typeof settings.CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST === 'string'
        ? settings.CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST
        : '',
    });
  } catch {
    return {};
  }
}

/** `init` with `auth` added. A header the caller already set wins; with nothing to add, `init` itself. */
export function withHarnessAuth(init: RequestInit, auth: Record<string, string>): RequestInit {
  if (Object.keys(auth).length === 0) return init;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(auth)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return { ...init, headers };
}

/** A context render can take seconds on a big database, so it gets the hooks' API budget (CLAUDE_MEM_API_TIMEOUT_MS). */
export function resolveHarnessContextTimeoutMs(): number {
  const fallback = getTimeout(HOOK_TIMEOUTS.API_REQUEST);
  const raw = harnessSetting()('CLAUDE_MEM_API_TIMEOUT_MS', String(fallback)).trim();
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return parsed >= CONTEXT_TIMEOUT_BOUNDS.min && parsed <= CONTEXT_TIMEOUT_BOUNDS.max ? parsed : fallback;
}

let starting: Promise<void> | undefined;

/** Only start code from the installed marketplace, never the current repository. */
export function startHarnessWorker(): Promise<void> {
  if (starting) return starting;
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'marketplaces', 'thedotmack');
  const runner = join(root, 'plugin', 'scripts', 'bun-runner.js');
  const worker = join(root, 'plugin', 'scripts', 'worker-service.cjs');
  if (!existsSync(runner) || !existsSync(worker)) {
    return Promise.reject(new Error('Run npx claude-mem install to install the worker.'));
  }
  const attempt = new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [runner, worker, 'start'], {
      stdio: 'ignore', windowsHide: true, timeout: 15_000,
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('claude-mem worker could not start')));
  });
  starting = attempt.finally(() => { starting = undefined; });
  return starting;
}

/** A bounded client shared by the native Pi extension and DSH plugin. */
export function createHarnessWorkerClient({ startIfNeeded = true }: { startIfNeeded?: boolean } = {}) {
  let baseUrl = resolveHarnessWorkerUrl();
  let contextTimeoutMs = resolveHarnessContextTimeoutMs();
  let auth = resolveHarnessAuthHeaders(baseUrl);
  return {
    reset(): void {
      baseUrl = resolveHarnessWorkerUrl();
      contextTimeoutMs = resolveHarnessContextTimeoutMs();
      auth = resolveHarnessAuthHeaders(baseUrl);
    },
    async ready(): Promise<void> {
      try {
        const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (response.ok) return;
        throw new Error('claude-mem health check returned ' + response.status);
      } catch (error) {
        // An HTTP failure belongs to the running server. Only a transport failure starts a worker.
        if (!isConnectionRefusedError(error)) throw error;
        if (!startIfNeeded) throw new Error('Start Claude-Mem in Terminal with npx claude-mem start, then listen again.');
        await startHarnessWorker();
      }
    },
    async request(route: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
      const response = await fetch(baseUrl + route, withHarnessAuth({
        ...init, signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      }, auth));
      if (!response.ok) throw new Error('claude-mem ' + route + ' returned ' + response.status);
      return response;
    },
    async context(query: URLSearchParams): Promise<string> {
      return (await this.request('/api/context/inject?' + query, {}, contextTimeoutMs)).text();
    },
    async post(route: string, body: unknown): Promise<Response> {
      return this.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
  };
}
