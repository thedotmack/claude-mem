
import net from 'net';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

// A hook asks for the worker's version while it is spending a bounded
// session-init budget, so the probe must never outlive that budget: a worker
// that answers the liveness check and then stalls on the version request used
// to hold the hook open past its host deadline (#3434). Callers inside a
// budget pass their remaining time; everyone else gets the liveness bound.
const WORKER_VERSION_PROBE_TIMEOUT_MS = HOOK_TIMEOUTS.HEALTH_CHECK;

const HTTP_GET = 'GET';

function getWorkerHost(): string {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_WORKER_HOST;
}

// Bracket IPv6 literals so a `CLAUDE_MEM_WORKER_HOST` of `::1` yields a valid
// `http://[::1]:port` URL instead of the malformed `http://::1:port`.
function formatHostForUrl(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

async function httpRequestToWorker(
  port: number,
  endpointPath: string,
  method: string = HTTP_GET,
  timeoutMs?: number
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const init: RequestInit = { method };
  if (timeoutMs !== undefined) init.signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`http://${formatHostForUrl(getWorkerHost())}:${port}${endpointPath}`, init);
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
    // Fast path: HTTP health check. A live claude-mem worker responds to
    // /api/health, so this is the cheapest non-disruptive probe for the
    // common case (worker is running and healthy).
    try {
      const response = await fetch(`http://${formatHostForUrl(getWorkerHost())}:${port}/api/health`);
      if (response.ok) return true;
      // Non-ok response: port is reachable but the worker is unhealthy.
      // Fall through to the net.createServer check below so we still report
      // the port as in-use rather than falsely claiming it is free.
      logger.debug('SYSTEM', 'Windows health check returned non-ok; falling through to socket probe', {
        port,
        status: response.status,
      });
    } catch (error) {
      // fetch threw (ECONNREFUSED, timeout, etc.): the port may still be in
      // use by a non-HTTP process (zombie worker, foreign service, etc.).
      // Fall through to the net.createServer probe — only a definitive bind
      // attempt can tell whether the port is truly free.
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Windows health check threw; falling through to socket probe', {
          port,
          message: error.message,
        });
      } else {
        logger.debug('SYSTEM', 'Windows health check threw; falling through to socket probe', {
          port,
          error: String(error),
        });
      }
    }
    // Fall through: the HTTP probe was inconclusive. Use the POSIX
    // net.createServer() approach to definitively check port occupancy.
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    const workerHost = getWorkerHost();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
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

export async function getRunningWorkerVersion(
  port: number,
  timeoutMs: number = WORKER_VERSION_PROBE_TIMEOUT_MS
): Promise<string | null> {
  try {
    const result = await httpRequestToWorker(port, '/api/health', HTTP_GET, timeoutMs);
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

/**
 * Compare the live worker's self-reported version against expectedVersion —
 * the version of the script the caller's resolveWorkerScript() oracle would
 * spawn. The caller supplies it so detection and respawn can never consult
 * different oracles (the 2026-07-22 restart storm). Either side unknown →
 * matches, since a recycle could not change the outcome deterministically.
 *
 * timeoutMs bounds the version probe so a wedged worker cannot stall a caller
 * that is spending a deadline (#3434); an expired probe reads as "unknown",
 * which is the existing no-recycle fallback.
 */
export async function checkVersionMatch(
  port: number,
  expectedVersion: string | null,
  timeoutMs: number = WORKER_VERSION_PROBE_TIMEOUT_MS
): Promise<VersionCheckResult> {
  const pluginVersion = expectedVersion ?? 'unknown';
  const workerVersion = await getRunningWorkerVersion(port, timeoutMs);

  if (!workerVersion || pluginVersion === 'unknown') {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}
