/**
 * Restarting the local worker so it picks up a changed Cloud Sync connection.
 * The worker reads the sync connection when it starts, so `teambrain join`/`leave`
 * and the installer (after Cloud Sync is approved) share this one restart path.
 */
import { isConnectionRefusedError } from '../../shared/connection-errors.js';
import { relayedLine } from '../../shared/relayed-text.js';
import { clearPortCache, getWorkerBaseUrl, workerAuthHeaders, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { waitForBackgroundWorkToFinish, WORKER_REQUEST_TIMEOUT_MS } from './browser-setup.js';

/** How long a sync change waits for the restarted worker to report its sync state. */
const WORKER_RESTART_WAIT_MS = 30_000;
const WORKER_RESTART_POLL_MS = 1_000;
/**
 * How long the installer waits for extraction or a history import before it gives up on restarting the worker onto
 * Cloud Sync. The worker counts a scan that waits for the person's upload answer as running, so the wait can last.
 */
export const CLOUD_SYNC_RESTART_MAX_WAIT_MS = 5 * 60_000;

export interface WorkerRestartLog {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
}

export async function readWorkerJson(response: Response, what: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; reason: string }> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', `The worker's ${what} answer is not JSON`, { status: response.status }, cause);
    return { ok: false, reason: `the worker's ${what} answer is not JSON` };
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ok: true, value: value as Record<string, unknown> }
    : { ok: false, reason: `the worker's ${what} answer is not a JSON object` };
}

type WorkerHealth =
  | { state: 'running'; pid: number | null }
  | { state: 'not_running' }
  | { state: 'unknown'; reason: string };

/** Whether the worker answers its health check: a refused connection means it is not running. */
async function workerHealth(): Promise<WorkerHealth> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/health', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch (error: unknown) {
    if (isConnectionRefusedError(error)) return { state: 'not_running' };
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Worker health check failed', {}, cause);
    return { state: 'unknown', reason: relayedLine(cause.message) || cause.name };
  }
  // 503 is a degraded worker, which still reports its pid.
  if (!response.ok && response.status !== 503) {
    logger.warn('SYSTEM', 'Worker health check answered with an error status', { status: response.status });
    return { state: 'unknown', reason: `the worker answered its health check with HTTP ${response.status}` };
  }
  const body = await readWorkerJson(response, 'health');
  if (!body.ok) return { state: 'unknown', reason: body.reason };
  return { state: 'running', pid: typeof body.value.pid === 'number' ? body.value.pid : null };
}

/** The worker's own sync report: whether it runs with a sync connection, and why the hub did not answer. Null while it cannot say. */
export async function workerSyncStatus(): Promise<{ configured: boolean; hubError: string | null } | null> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/sync/status', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch (error: unknown) {
    // Expected while the worker restarts; the caller asks again.
    logger.debug('SYSTEM', 'Sync status not answered yet', {}, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  if (!response.ok) return null;
  const body = await readWorkerJson(response, 'sync status');
  if (!body.ok || typeof body.value.configured !== 'boolean') return null;
  const hub = body.value.hub as { reachable?: unknown; error?: unknown } | undefined;
  const hubError = hub && hub.reachable === false
    ? (typeof hub.error === 'string' && hub.error ? relayedLine(hub.error) : 'unreachable')
    : null;
  return { configured: body.value.configured, hubError };
}

async function requestWorkerRestart(): Promise<string | null> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/admin/restart', { method: 'POST', timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Worker restart request failed', {}, cause);
    return relayedLine(cause.message) || cause.name;
  }
  return response.ok ? null : `HTTP ${response.status}`;
}

/**
 * The worker reads the sync connection when it starts, so a changed one needs
 * a restart (the cloud-sync skill's step 3: POST /api/admin/restart, then
 * poll /api/sync/status until it reports the new state). A worker that is not
 * running picks it up when it starts; one whose state cannot be read is
 * reported as such, never assumed.
 *
 * Callers that may have extraction or a history import running wait for it
 * first (`waitForBackgroundWorkToFinish`), so the restart cannot kill it.
 *
 * Resolves true when a restarted worker reports the wanted sync state, false
 * otherwise; every outcome is already worded through `log`.
 */
export async function restartWorkerForSyncChange(
  syncOn: boolean,
  log: WorkerRestartLog,
  timing: { waitMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const waitMs = timing.waitMs ?? WORKER_RESTART_WAIT_MS;
  const before = await workerHealth();
  if (before.state === 'not_running') {
    log.info(syncOn
      ? 'The claude-mem worker is not running; cloud sync starts with it (npx claude-mem start).'
      : 'The claude-mem worker is not running; it starts without cloud sync.');
    return false;
  }
  if (before.state === 'unknown') {
    log.warn(`Could not check the claude-mem worker (${before.reason}). Restart it so the change applies: npx claude-mem restart`);
    return false;
  }
  const restartProblem = await requestWorkerRestart();
  if (restartProblem) {
    log.warn(`Could not restart the claude-mem worker (${restartProblem}). Restart it so the change applies: npx claude-mem restart`);
    return false;
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, timing.pollMs ?? WORKER_RESTART_POLL_MS));
    const health = await workerHealth();
    if (health.state !== 'running' || (before.pid !== null && health.pid === before.pid)) continue;
    const sync = await workerSyncStatus();
    if (!sync || sync.configured !== syncOn) continue;
    if (!syncOn) log.success('The worker restarted without cloud sync.');
    else if (sync.hubError) log.warn(`Cloud sync is set up, but the sync hub did not answer yet: ${sync.hubError}`);
    else log.success('Cloud sync is on: this install syncs to your account.');
    return true;
  }
  log.warn(`The worker restart could not be confirmed within ${waitMs / 1000}s. Check it with: npx claude-mem doctor`);
  return false;
}

/** Printed when the installer could not get the worker onto the approved sync connection. */
export const CLOUD_SYNC_NOT_PICKED_UP_WARNING = 'Cloud sync: worker has not picked up the sync settings yet — it will on its next restart.';

/**
 * After Cloud Sync is approved during install, a worker that still reports `configured: false` booted before the
 * sync settings were saved. Wait (at most `maxWaitMs`) until it runs no extraction or history import, then restart it
 * onto the new connection. Both talk to the one worker address and local API token the settings name now. Exactly one
 * warning says so when the wait or the restart does not succeed.
 */
export async function restartWorkerToPickUpCloudSync(deps: {
  log: WorkerRestartLog;
  maxWaitMs?: number;
  waitForBackgroundWork?: typeof waitForBackgroundWorkToFinish;
  restart?: typeof restartWorkerForSyncChange;
}): Promise<boolean> {
  // Read the worker host, port and local API token again: this install may have written them after they were cached.
  clearPortCache();
  try {
    await (deps.waitForBackgroundWork ?? waitForBackgroundWorkToFinish)({
      workerBaseUrl: getWorkerBaseUrl(),
      headers: workerAuthHeaders(),
      log: deps.log,
      maxWaitMs: deps.maxWaitMs ?? CLOUD_SYNC_RESTART_MAX_WAIT_MS,
    });
  } catch (error: unknown) {
    deps.log.warn(`${CLOUD_SYNC_NOT_PICKED_UP_WARNING} (${relayedLine(error instanceof Error ? error.message : String(error))})`);
    return false;
  }
  // The restart words its own failure (with what to run); the installer's warning stands in only when it said none.
  let restartWarned = false;
  const log: WorkerRestartLog = { ...deps.log, warn: (message) => { restartWarned = true; deps.log.warn(message); } };
  if (await (deps.restart ?? restartWorkerForSyncChange)(true, log)) return true;
  if (!restartWarned) deps.log.warn(CLOUD_SYNC_NOT_PICKED_UP_WARNING);
  return false;
}
