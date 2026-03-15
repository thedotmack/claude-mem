/**
 * HealthMonitor - Port monitoring, health checks, and version checking
 *
 * Extracted from worker-service.ts monolith to provide centralized health monitoring.
 * Handles:
 * - Port availability checking
 * - Worker health/readiness polling
 * - Version mismatch detection (critical for plugin updates)
 * - HTTP-based shutdown requests
 *
 * Supports both TCP and Unix domain socket transports (#1346).
 */

import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';
import type { WorkerAddress } from '../../supervisor/socket-manager.js';

/**
 * Make an HTTP request to the worker, supporting both socket and TCP addresses.
 * Returns { ok, statusCode, body } or throws on transport error.
 */
async function httpRequestToWorker(
  address: WorkerAddress | number,
  endpointPath: string,
  method: string = 'GET'
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  // Backwards compatibility: if a raw port number is passed, wrap as TCP address
  const addr: WorkerAddress = typeof address === 'number'
    ? { type: 'tcp', host: '127.0.0.1', port: address }
    : address;

  if (addr.type === 'socket') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: addr.socketPath,
        path: endpointPath,
        method,
        headers: { Host: 'localhost' }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const statusCode = res.statusCode ?? 500;
          resolve({ ok: statusCode >= 200 && statusCode < 300, statusCode, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // TCP mode — use global fetch
  const response = await fetch(`http://${addr.host}:${addr.port}${endpointPath}`, { method });
  // Gracefully handle cases where response body isn't available (e.g., test mocks)
  let body = '';
  try {
    body = await response.text();
  } catch {
    // Body unavailable — health/readiness checks only need .ok
  }
  return { ok: response.ok, statusCode: response.status, body };
}

/**
 * Check if a port is in use by querying the health endpoint
 */
export async function isPortInUse(port: number): Promise<boolean> {
  try {
    // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok;
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Health check polls every 500ms, logging would flood
    return false;
  }
}

/**
 * Check if the worker is reachable at the given address (socket or TCP).
 */
export async function isWorkerReachable(address: WorkerAddress): Promise<boolean> {
  try {
    const result = await httpRequestToWorker(address, '/api/health');
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Poll a worker endpoint until it returns 200 OK or timeout.
 * Shared implementation for liveness and readiness checks.
 * Supports both TCP port and WorkerAddress.
 */
async function pollEndpointUntilOk(
  address: WorkerAddress | number,
  endpointPath: string,
  timeoutMs: number,
  retryLogMessage: string
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await httpRequestToWorker(address, endpointPath);
      if (result.ok) return true;
    } catch (error) {
      // [ANTI-PATTERN IGNORED]: Retry loop - expected failures during startup, will retry
      logger.debug('SYSTEM', retryLogMessage, {}, error as Error);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Wait for the worker HTTP server to become responsive (liveness check).
 * Uses /api/health which returns 200 as soon as the HTTP server is listening.
 * For full initialization (DB + search), use waitForReadiness() instead.
 *
 * Accepts either a port number (backwards compat) or a WorkerAddress.
 */
export function waitForHealth(address: WorkerAddress | number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(address, '/api/health', timeoutMs, 'Service not ready yet, will retry');
}

/**
 * Wait for the worker to be fully initialized (DB + search ready).
 * Uses /api/readiness which returns 200 only after core initialization completes.
 * Now that initializationCompleteFlag is set after DB/search init (not MCP),
 * this typically completes in a few seconds.
 *
 * Accepts either a port number (backwards compat) or a WorkerAddress.
 */
export function waitForReadiness(address: WorkerAddress | number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(address, '/api/readiness', timeoutMs, 'Worker not ready yet, will retry');
}

/**
 * Wait for a port to become free (no longer responding to health checks)
 * Used after shutdown to confirm the port is available for restart
 */
export async function waitForPortFree(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Wait for a worker address (socket or TCP) to become unreachable.
 * Used after shutdown to confirm the worker is fully stopped.
 */
export async function waitForWorkerStopped(address: WorkerAddress, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isWorkerReachable(address))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Send HTTP shutdown request to a running worker
 * Supports both TCP port and WorkerAddress.
 * @returns true if shutdown request was acknowledged, false otherwise
 */
export async function httpShutdown(address: WorkerAddress | number): Promise<boolean> {
  try {
    const result = await httpRequestToWorker(address, '/api/admin/shutdown', 'POST');
    if (!result.ok) {
      logger.warn('SYSTEM', 'Shutdown request returned error', { status: result.statusCode });
      return false;
    }
    return true;
  } catch (error) {
    // Connection refused is expected if worker already stopped
    if (error instanceof Error && error.message?.includes('ECONNREFUSED')) {
      logger.debug('SYSTEM', 'Worker already stopped', {}, error);
      return false;
    }
    // Unexpected error - log full details
    logger.error('SYSTEM', 'Shutdown request failed unexpectedly', {}, error as Error);
    return false;
  }
}

/**
 * Get the plugin version from the installed marketplace package.json
 * This is the "expected" version that should be running.
 * Returns 'unknown' on ENOENT/EBUSY (shutdown race condition, fix #1042).
 */
export function getInstalledPluginVersion(): string {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EBUSY') {
      logger.debug('SYSTEM', 'Could not read plugin version (shutdown race)', { code });
      return 'unknown';
    }
    throw error;
  }
}

/**
 * Get the running worker's version via API
 * This is the "actual" version currently running.
 * Supports both TCP port and WorkerAddress.
 */
export async function getRunningWorkerVersion(address: WorkerAddress | number): Promise<string | null> {
  try {
    const result = await httpRequestToWorker(address, '/api/version');
    if (!result.ok) return null;
    const data = JSON.parse(result.body) as { version: string };
    return data.version;
  } catch {
    // Expected: worker not running or version endpoint unavailable
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
 * Check if worker version matches plugin version
 * Critical for detecting when plugin is updated but worker is still running old code
 * Returns true if versions match or if we can't determine (assume match for graceful degradation)
 *
 * Supports both TCP port and WorkerAddress.
 */
export async function checkVersionMatch(address: WorkerAddress | number): Promise<VersionCheckResult> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(address);

  // If either version is unknown/null, assume match (graceful degradation, fix #1042)
  if (!workerVersion || pluginVersion === 'unknown') {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}
