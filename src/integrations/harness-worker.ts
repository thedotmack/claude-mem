import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { isConnectionRefusedError } from '../shared/connection-errors.js';
import { expandHome } from '../shared/expand-home.js';

const TIMEOUT_MS = 5_000;

/** Resolve the same per-user address as the worker, including persisted settings. */
export function resolveHarnessWorkerUrl(): string {
  const dataDir = expandHome(process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem'));
  let settings: Record<string, unknown> = {};
  try {
    const document = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    const nested = document?.env;
    settings = nested && typeof nested === 'object' && !Array.isArray(nested)
      && Object.keys(nested).some(key => key.startsWith('CLAUDE_MEM_')) ? nested : document ?? {};
  } catch {
    // Settings are optional; environment overrides and per-user defaults remain usable.
  }
  const setting = (key: string, fallback: string): string =>
    process.env[key] || (typeof settings[key] === 'string' && settings[key] ? String(settings[key]) : fallback);
  const configuredHost = setting('CLAUDE_MEM_WORKER_HOST', '127.0.0.1');
  const host = configuredHost === 'localhost' ? '127.0.0.1' : configuredHost;
  const port = setting('CLAUDE_MEM_WORKER_PORT', String(37700 + ((process.getuid?.() ?? 77) % 100)));
  return 'http://' + (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + ':' + port;
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
export function createHarnessWorkerClient() {
  let baseUrl = resolveHarnessWorkerUrl();
  return {
    reset(): void { baseUrl = resolveHarnessWorkerUrl(); },
    async ready(): Promise<void> {
      try {
        const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (response.ok) return;
        throw new Error('claude-mem health check returned ' + response.status);
      } catch (error) {
        // An HTTP failure belongs to the running server. Only a transport failure starts a worker.
        if (!isConnectionRefusedError(error)) throw error;
        await startHarnessWorker();
      }
    },
    async request(route: string, init: RequestInit = {}): Promise<Response> {
      const response = await fetch(baseUrl + route, {
        ...init, signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
          : AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('claude-mem ' + route + ' returned ' + response.status);
      return response;
    },
    async post(route: string, body: unknown): Promise<Response> {
      return this.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
  };
}
