
import path from 'path';
import net from 'net';
import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';
import { getWorkerHost } from '../../shared/worker-utils.js';

function formatHostForUrl(host: string): string {
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

export async function isPortInUse(port: number): Promise<boolean> {
  if (process.platform === 'win32') {
    // First check: try the health endpoint (happy path - worker is alive and well)
    try {
      // #2996: bound the health probe with a 3s timeout so a wedged process
      // that accepts but never responds does not block the recovery path.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
      } finally {
        clearTimeout(timeoutId);
      }
      // #2996: if fetch() succeeds (no exception), the port is in use regardless of HTTP status.
      // A 404/500 from a wedged worker or unrelated local server still means the port is bound.
      return true;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Windows health endpoint check failed, falling back to TCP probe', {}, error);
      } else {
        logger.debug('SYSTEM', 'Windows health endpoint check failed, falling back to TCP probe', { error: String(error) });
      }
    }

    // Second check (#2996): health endpoint didn't respond, but the port may
    // still be bound by a zombie/stale worker process. On Windows with multiple
    // concurrent Claude Code sessions, this is the common failure mode: the
    // worker process holds the port but no longer serves health checks. Without
    // this TCP probe, isPortInUse returns false, the spawner proceeds, bind
    // fails, and the 2-minute cooldown kicks in - paralyzing all sessions.
    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        logger.warn('SYSTEM', 'Port is TCP-bound but health endpoint unresponsive - likely a zombie worker', { port });
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'EUNKNOWN'));
    probe.once('listening', () => {
      probe.close(() => resolve(null));
    });
    probe.listen(port, host);
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function httpShutdown(port: number, reason: 'stop' | 'restart' = 'stop'): Promise<boolean> {
  try {
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
    const result = await httpRequestToWorker(port, '/api/version');
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
