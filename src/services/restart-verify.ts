/**
 * Restart verification helpers for the CLI `restart` command (worker-service.ts).
 *
 * This lives in its own module rather than inside worker-service.ts so tests
 * can import it directly: worker-service.ts drags in a very large dependency
 * graph (bun:sqlite, MCP SDK, telemetry, supervisor) and ends with an
 * isMainModule bootstrap, which makes it unsafe to import from `bun test`.
 *
 * `restart` must prove the NEW worker is up (different pid than the old
 * worker, and self-reporting the same baked version as the CLI process that
 * initiated the restart) or exit non-zero — a restart that silently leaves
 * the old worker serving is worse than a failed one
 * (plans/2026-06-10-worker-restart-single-source-of-truth.md).
 * Verification reads only the `pid` and `version` fields of GET /api/health
 * (src/services/server/Server.ts), which the worker reports from its own
 * baked __DEFAULT_PACKAGE_VERSION__ constant.
 */

import { getWorkerHost, fetchWithTimeout } from '../shared/worker-utils.js';

interface HealthSnapshot {
  pid?: unknown;
  version?: unknown;
}

export interface RestartVerifyOptions {
  /** Delay between health polls (ms). Default 500. */
  pollIntervalMs?: number;
  /** Per-request timeout for each health poll (ms). Default 2000. */
  requestTimeoutMs?: number;
}

export type RestartVerifyResult =
  | { ok: true; pid: number; version: string }
  | {
      ok: false;
      lastObserved: string;
      /**
       * True when the most recent poll received a health payload — i.e. a
       * live (but unverifiable) worker is serving on the port. Callers use
       * this to skip waiting for the port to free: it will not free while
       * that worker lives.
       */
      lastPollSawHealth: boolean;
    };

async function fetchHealthSnapshot(port: number, timeoutMs: number): Promise<HealthSnapshot> {
  const url = `http://${getWorkerHost()}:${port}/api/health`;
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  // /api/health answers 503 when the queue is degraded but still includes
  // pid/version — a degraded-but-booted worker still proves the restart.
  return await response.json() as HealthSnapshot;
}

/**
 * Capture the pid of the currently-running worker before shutting it down.
 * Returns null when no worker is reachable (nothing listening, timeout, or a
 * malformed health payload) — verification then only requires that a worker
 * with the expected version appears.
 */
export async function getCurrentWorkerPid(port: number, timeoutMs: number = 2000): Promise<number | null> {
  try {
    const health = await fetchHealthSnapshot(port, timeoutMs);
    return typeof health.pid === 'number' ? health.pid : null;
  } catch {
    return null;
  }
}

/**
 * Poll GET /api/health until the worker reports a pid different from
 * `oldPid` AND a version equal to `expectedVersion` (the caller's own baked
 * __DEFAULT_PACKAGE_VERSION__ constant — never package.json read from disk).
 *
 * Hard-capped by `deadlineMs`; on expiry returns `{ ok: false }` carrying the
 * last observed health payload (or connection error) so the caller can report
 * it and exit 1.
 */
export async function verifyRestartedWorker(
  port: number,
  oldPid: number | null,
  expectedVersion: string,
  deadlineMs: number,
  options: RestartVerifyOptions = {}
): Promise<RestartVerifyResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2000;
  const deadline = Date.now() + deadlineMs;
  let lastObserved = 'no health response observed before deadline';
  let lastPollSawHealth = false;

  while (Date.now() < deadline) {
    try {
      const health = await fetchHealthSnapshot(port, requestTimeoutMs);
      lastObserved = `last health payload: ${JSON.stringify({ pid: health.pid, version: health.version })}`;
      lastPollSawHealth = true;
      if (
        typeof health.pid === 'number' &&
        health.pid !== oldPid &&
        typeof health.version === 'string' &&
        health.version === expectedVersion
      ) {
        return { ok: true, pid: health.pid, version: health.version };
      }
    } catch (error) {
      lastObserved = `connection error: ${error instanceof Error ? error.message : String(error)}`;
      lastPollSawHealth = false;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return { ok: false, lastObserved, lastPollSawHealth };
}
