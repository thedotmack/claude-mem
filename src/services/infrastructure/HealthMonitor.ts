
import path from 'path';
import net from 'net';
import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { MARKETPLACE_ROOT, USER_SETTINGS_PATH } from '../../shared/paths.js';

function getWorkerHost(): string {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_WORKER_HOST;
}

const PORT_PROBE_TIMEOUT_MS = 5_000;

// Bracket IPv6 literals so a `CLAUDE_MEM_WORKER_HOST` of `::1` yields a valid
// `http://[::1]:port` URL instead of the malformed `http://::1:port`.
function formatHostForUrl(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

async function httpRequestToWorker(
  port: number,
  endpointPath: string,
  method: string = 'GET'
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const response = await fetch(`http://${formatHostForUrl(getWorkerHost())}:${port}${endpointPath}`, { method });
  let body = '';
  try {
    body = await response.text();
  } catch {
    // Body unavailable — health/readiness checks only need .ok
  }
  return { ok: response.ok, statusCode: response.status, body };
}

export async function isPortInUse(port: number, timeoutMs: number = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  if (process.platform === 'win32') {
    try {
      const response = await fetch(`http://${formatHostForUrl(getWorkerHost())}:${port}/api/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(PORT_PROBE_TIMEOUT_MS, deadline - Date.now()))),
      });
      if (response.ok) return true;
      logger.debug('SYSTEM', 'Windows health check returned non-ok; falling through to socket probe', {
        port,
        status: response.status,
      });
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Windows health check threw; falling through to socket probe', {}, error);
      } else {
        logger.debug('SYSTEM', 'Windows health check threw; falling through to socket probe', { error: String(error) });
      }
    }
  }

  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    const workerHost = getWorkerHost();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(inUse);
    };
    const closeServer = () => {
      try {
        server.close(() => {});
      } catch {
        // The bind may not have reached `listening` yet.
      }
    };
    timer = setTimeout(() => {
      // An inconclusive probe must be treated as occupied so callers never
      // launch another worker while the port state is unknown.
      settle(true);
      closeServer();
    }, Math.max(1, deadline - Date.now()));
    server.once('error', (err: NodeJS.ErrnoException) => {
      settle(err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      if (settled) {
        closeServer();
        return;
      }
      server.close(() => settle(false));
    });
    server.listen(port, workerHost);
  });
}

async function pollEndpointUntilOk(
  port: number,
  endpointPath: string,
  timeoutMs: number,
  retryLogMessage: string
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await httpRequestToWorker(port, endpointPath);
      if (result.ok) return true;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', retryLogMessage, {}, error);
      } else {
        logger.debug('SYSTEM', retryLogMessage, { error: String(error) });
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/health', timeoutMs, 'Service not ready yet, will retry');
}

export function waitForReadiness(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/readiness', timeoutMs, 'Worker not ready yet, will retry');
}

export async function waitForPortFree(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (!(await isPortInUse(port, remainingMs))) return true;
    const retryDelayMs = Math.min(500, deadline - Date.now());
    if (retryDelayMs > 0) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}

export async function httpShutdown(port: number, reason: 'stop' | 'restart' = 'stop'): Promise<boolean> {
  try {
    // The CLI restart path stops the worker through this same endpoint; the
    // reason tag lets the worker report shutdown_reason: 'restart' on its
    // worker_stopped telemetry instead of a generic 'stop'.
    const endpointPath = reason === 'restart' ? '/api/admin/shutdown?reason=restart' : '/api/admin/shutdown';
    const result = await httpRequestToWorker(port, endpointPath, 'POST');
    if (!result.ok) {
      logger.warn('SYSTEM', 'Shutdown request returned error', { status: result.statusCode });
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.message?.includes('ECONNREFUSED')) {
      logger.debug('SYSTEM', 'Worker already stopped', {}, error);
      return false;
    }
    logger.error('SYSTEM', 'Shutdown request failed unexpectedly', {}, error as Error);
    return false;
  }
}

export function getInstalledPluginVersion(): string {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error: unknown) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EBUSY') {
        logger.debug('SYSTEM', 'Could not read plugin version (shutdown race)', { code });
        return 'unknown';
      }
      throw error;
    }
    throw error;
  }
}

export async function getRunningWorkerVersion(port: number): Promise<string | null> {
  try {
    const result = await httpRequestToWorker(port, '/api/health');
    if (!result.ok) return null;
    const data = JSON.parse(result.body) as { version: string };
    return data.version;
  } catch {
    logger.debug('SYSTEM', 'Could not fetch worker version', {});
    return null;
  }
}

export interface VersionCheckResult {
  matches: boolean;
  pluginVersion: string;
  workerVersion: string | null;
}

export async function checkVersionMatch(port: number): Promise<VersionCheckResult> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(port);

  if (!workerVersion || pluginVersion === 'unknown') {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}
