/**
 * HealthMonitor - Port monitoring, health checks, and version checking
 *
 * Extracted from worker-service.ts monolith to provide centralized health monitoring.
 * Handles:
 * - Port availability checking
 * - Worker health/readiness polling
 * - Version mismatch detection (critical for plugin updates)
 * - HTTP-based shutdown requests
 */

import path from 'path';
import net from 'net';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

/**
 * Make an HTTP request to the worker via TCP.
 * Returns { ok, statusCode, body } or throws on transport error.
 */
async function httpRequestToWorker(
  port: number,
  endpointPath: string,
  method: string = 'GET'
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${endpointPath}`, { method });
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
 * Check if a port is in use by attempting an atomic socket bind.
 * More reliable than HTTP health check for daemon spawn guards —
 * prevents TOCTOU race where two daemons both see "port free" via
 * HTTP and then both try to listen() (upstream bug workaround).
 *
 * Falls back to HTTP health check on Windows where socket bind
 * behavior differs.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  if (process.platform === 'win32') {
    // First: try HTTP health check (fast path — worker is alive and responding)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // Worker not responding — but port might still be occupied
    }

    // Second: check OS-level TCP state via PowerShell.
    // This catches zombie ports: the worker process crashed but Windows TCP
    // stack still holds the port in LISTEN/TIME_WAIT/CLOSE_WAIT state.
    // Without this check, spawn() succeeds but the new worker fails to bind.
    return isPortOccupiedWindows(port);
  }

  // Unix: atomic socket bind check — no TOCTOU race
  return new Promise((resolve) => {
    const server = net.createServer();
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
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Windows-specific: check if a port is occupied at the OS level using
 * Get-NetTCPConnection. This catches zombie ports where the process
 * crashed but TCP state lingers (TIME_WAIT, CLOSE_WAIT, or orphaned LISTEN).
 *
 * Returns true if the port has any active TCP connection (regardless of state).
 */
function isPortOccupiedWindows(port: number): boolean {
  try {
    const output = execSync(
      `powershell -NoProfile -NonInteractive -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Measure-Object).Count"`,
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
    ).trim();
    return parseInt(output, 10) > 0;
  } catch {
    // If PowerShell fails, assume port is free
    return false;
  }
}

/**
 * Windows-specific: find the PID of the process holding a port in LISTEN state.
 * Returns the PID, or null if no process found or if the port is only in TIME_WAIT.
 *
 * Only returns PIDs in Listen state — TIME_WAIT connections have no owning process
 * that can be killed (they are handled by the OS TCP stack).
 */
export function getPortOwnerPidWindows(port: number): number | null {
  if (process.platform !== 'win32') return null;

  try {
    const output = execSync(
      `powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"`,
      { encoding: 'utf-8', timeout: 5000, windowsHide: true }
    ).trim();

    if (!output) return null;

    const pid = parseInt(output.split('\n')[0].trim(), 10);
    return (Number.isInteger(pid) && pid > 0) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Poll a worker endpoint until it returns 200 OK or timeout.
 * Shared implementation for liveness and readiness checks.
 */
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
 */
export function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/health', timeoutMs, 'Service not ready yet, will retry');
}

/**
 * Wait for the worker to be fully initialized (DB + search ready).
 * Uses /api/readiness which returns 200 only after core initialization completes.
 * Now that initializationCompleteFlag is set after DB/search init (not MCP),
 * this typically completes in a few seconds.
 */
export function waitForReadiness(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/readiness', timeoutMs, 'Worker not ready yet, will retry');
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
 * Send HTTP shutdown request to a running worker
 * @returns true if shutdown request was acknowledged, false otherwise
 */
export async function httpShutdown(port: number): Promise<boolean> {
  try {
    const result = await httpRequestToWorker(port, '/api/admin/shutdown', 'POST');
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
 */
export async function getRunningWorkerVersion(port: number): Promise<string | null> {
  try {
    const result = await httpRequestToWorker(port, '/api/version');
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
 */
export async function checkVersionMatch(port: number): Promise<VersionCheckResult> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(port);

  // If either version is unknown/null, assume match (graceful degradation, fix #1042)
  if (!workerVersion || pluginVersion === 'unknown') {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}
