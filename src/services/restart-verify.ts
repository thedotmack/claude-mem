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
 * the old worker serving is worse than a failed one.
 * Verification reads only the `pid` and `version` fields of GET /api/health
 * (src/services/server/Server.ts), which the worker reports from its own
 * baked __DEFAULT_PACKAGE_VERSION__ constant.
 *
 * The auto-updater needs more than an answering worker: one that finished
 * starting. verifyWorkerFinishedStarting reads GET /api/ready for that.
 */

import { readSseEvents } from '../shared/sse-reader.js';
import {
  fetchStreamWithIdleTimeout,
  fetchWithTimeout,
  formatHostForUrl,
  getWorkerHost,
  READY_STREAM_IDLE_TIMEOUT_MS,
  type IdleFetchStreamResult,
} from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

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
  const url = `http://${formatHostForUrl(getWorkerHost())}:${port}/api/health`;
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
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug('SYSTEM', 'No reachable worker while capturing pre-restart pid', { port }, err);
    return null;
  }
}

/**
 * One verification poll: fetch the health snapshot and check it against the
 * old pid and expected version. Returns the observed payload summary plus the
 * verified pid/version when the new worker proved itself, or null otherwise.
 */
async function pollHealthOnce(
  port: number,
  timeoutMs: number,
  oldPid: number | null,
  expectedVersion: string
): Promise<{ lastObserved: string; verified: { pid: number; version: string } | null }> {
  const health = await fetchHealthSnapshot(port, timeoutMs);
  const lastObserved = `last health payload: ${JSON.stringify({ pid: health.pid, version: health.version })}`;
  if (
    typeof health.pid === 'number' &&
    health.pid !== oldPid &&
    typeof health.version === 'string' &&
    health.version === expectedVersion
  ) {
    return { lastObserved, verified: { pid: health.pid, version: health.version } };
  }
  return { lastObserved, verified: null };
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
      const poll = await pollHealthOnce(port, requestTimeoutMs, oldPid, expectedVersion);
      lastObserved = poll.lastObserved;
      lastPollSawHealth = true;
      if (poll.verified) {
        return { ok: true, pid: poll.verified.pid, version: poll.verified.version };
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.debug('SYSTEM', 'Health poll failed while verifying restarted worker', { port }, err);
      lastObserved = `connection error: ${err.message}`;
      lastPollSawHealth = false;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return { ok: false, lastObserved, lastPollSawHealth };
}

export type WorkerStartupProof =
  | { ok: true; pid: number; version: string }
  /** The expected worker reported that its startup failed: phase `failed`, with its message. */
  | { ok: false; startupFailed: true; pid: number; message: string }
  /** No such worker reported `ready` before the ceiling; `lastObserved` says what answered last. */
  | { ok: false; startupFailed: false; lastObserved: string };

export interface WorkerStartupProofOptions {
  /** Pause between two reads of the stream (ms). Default 500, the restart proof's poll interval. */
  pollIntervalMs?: number;
  /** Silence that ends one read of the stream (ms). Default READY_STREAM_IDLE_TIMEOUT_MS, the hooks' own. */
  idleTimeoutMs?: number;
}

/** The pause verifyRestartedWorker takes between health polls by default (its pollIntervalMs). */
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Wait until a worker other than `oldPid` reports `expectedVersion` and that
 * it finished starting. GET /api/ready sends the worker's startup phase with
 * its pid and baked version at once, then each change, and ends after `ready`
 * or `failed` (Server.ts handleReadyStream, phases in server/init-phase.ts):
 *  - `ready` from the expected worker proves it;
 *  - `failed` from it ends the wait at once, with the worker's message: its
 *    startup died and it never becomes ready;
 *  - a starting phase (starting, db_ready, routes_ready) keeps the read open
 *    for the next one.
 * Nothing else ends the wait before `ceilingMs`: a refused connection (the
 * worker has not bound yet), silence past `idleTimeoutMs` (a synchronous
 * migration holds its event loop), or another worker answering (the old pid,
 * or another version) only start the next read. The worker's pid on the
 * stream is the process that answers, so a worker that restarts mid-wait is
 * judged by its own phases.
 */
export async function verifyWorkerFinishedStarting(
  port: number,
  oldPid: number | null,
  expectedVersion: string,
  ceilingMs: number,
  options: WorkerStartupProofOptions = {},
): Promise<WorkerStartupProof> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? READY_STREAM_IDLE_TIMEOUT_MS;
  const url = `http://${formatHostForUrl(getWorkerHost())}:${port}/api/ready`;
  const deadline = Date.now() + ceilingMs;
  let lastObserved = 'no /api/ready answer before the ceiling';
  while (Date.now() < deadline) {
    const read = await readStartupPhase(url, oldPid, expectedVersion, idleTimeoutMs, deadline - Date.now());
    if (read.kind === 'ready') return { ok: true, pid: read.pid, version: expectedVersion };
    if (read.kind === 'failed') return { ok: false, startupFailed: true, pid: read.pid, message: read.message };
    lastObserved = read.observed;
    const pauseMs = Math.min(pollIntervalMs, deadline - Date.now());
    if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return { ok: false, startupFailed: false, lastObserved };
}

type StartupPhaseRead =
  | { kind: 'ready'; pid: number }
  | { kind: 'failed'; pid: number; message: string }
  | { kind: 'not-yet'; observed: string };

/** One read of GET /api/ready, capped at what is left of the ceiling. */
async function readStartupPhase(
  url: string,
  oldPid: number | null,
  expectedVersion: string,
  idleTimeoutMs: number,
  budgetMs: number,
): Promise<StartupPhaseRead> {
  let stream: IdleFetchStreamResult;
  try {
    // The cap is applied only when positive (worker-utils.ts createIdleWatchdog), so the last read keeps a 1 ms one.
    stream = await fetchStreamWithIdleTimeout(url, { method: 'GET' }, { idleTimeoutMs, absoluteCapMs: Math.max(1, budgetMs) });
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'No /api/ready answer while waiting for a worker to finish starting', { url }, error instanceof Error ? error : new Error(String(error)));
    return { kind: 'not-yet', observed: `connection error: ${errorMessageOf(error)}` };
  }
  // Releasing the body once the answer is known must not change the answer.
  const releaseStream = (): Promise<void> => stream.cancel().catch((error: unknown) => {
    logger.debug('SYSTEM', 'Releasing the /api/ready body failed', { url }, error instanceof Error ? error : new Error(String(error)));
  });
  const contentType = stream.headers.get('content-type') ?? '';
  if (!stream.ok || !contentType.includes('text/event-stream')) {
    await releaseStream();
    return { kind: 'not-yet', observed: `HTTP ${stream.status} without the /api/ready stream` };
  }

  let observed = 'the /api/ready stream sent no phase';
  try {
    for await (const event of readSseEvents(stream.chunks)) {
      if (event.event !== 'phase') continue;
      const payload = JSON.parse(event.data) as { phase?: unknown; message?: unknown; version?: unknown; pid?: unknown };
      const pid = payload.pid;
      observed = `last /api/ready phase: ${JSON.stringify({ phase: payload.phase, pid, version: payload.version })}`;
      if (typeof pid !== 'number' || pid === oldPid || payload.version !== expectedVersion) {
        await releaseStream();
        return { kind: 'not-yet', observed };
      }
      if (payload.phase === 'ready') {
        await releaseStream();
        return { kind: 'ready', pid };
      }
      if (payload.phase === 'failed') {
        await releaseStream();
        return { kind: 'failed', pid, message: typeof payload.message === 'string' ? payload.message : 'the worker sent no message' };
      }
    }
    return { kind: 'not-yet', observed: `${observed}, then the stream ended` };
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'The /api/ready stream stopped while waiting for a worker to finish starting', { url, observed }, error instanceof Error ? error : new Error(String(error)));
    return { kind: 'not-yet', observed: `${observed}, then ${errorMessageOf(error)}` };
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
