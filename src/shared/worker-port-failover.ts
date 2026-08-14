import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import net from 'net';
import { logger } from '../utils/logger.js';
import { resolveDataDir } from './paths.js';
import { writeJsonFileAtomic } from './atomic-json.js';

/**
 * Worker-port failover (#3073, #3450, and the rung-3b half of PortReclaim).
 *
 * When the configured worker port is held by something we cannot prove is
 * ours (a ghost socket we could not clear, or an unrelated local service), the
 * safe move is to leave it alone and run somewhere else. This module owns the
 * record of "somewhere else" and, importantly, its expiry.
 *
 * Two design constraints, both learned from existing bugs:
 *
 * 1. It does NOT write settings.json. Concurrent hooks rewriting that file is
 *    how it ends up truncated to a single key (#3080). The record lives in its
 *    own small file, written atomically.
 *
 * 2. The record is ADVISORY and self-expiring, never authoritative. #3484 is
 *    what happens when a failover port outlives its worker: hooks kept talking
 *    to port 38888 while the worker was on 37777, permanently desynced. So a
 *    recorded port is honoured only while a worker actually answers there; the
 *    moment it does not, callers fall back to the configured port and the
 *    record is discarded.
 */

const FAILOVER_FILENAME = 'worker-port.json';

/**
 * How long a failover record may be honoured without any successful health
 * check against it. A record older than this is discarded on read even if we
 * cannot probe, so a stale file can never wedge resolution permanently.
 */
const FAILOVER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Ports to try, in order, when failing over away from `preferredPort`. */
const FAILOVER_OFFSETS: ReadonlyArray<number> = [1, 2, 3, 5, 8, 13, 21, 34];

interface FailoverRecord {
  port: number;
  preferredPort: number;
  recordedAt: string;
  reason: string;
}

function getFailoverPath(): string {
  return join(resolveDataDir(), FAILOVER_FILENAME);
}

function readFailoverRecord(): FailoverRecord | null {
  const path = getFailoverPath();
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<FailoverRecord>;
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port) || parsed.port <= 0) {
      return null;
    }
    if (typeof parsed.preferredPort !== 'number' || typeof parsed.recordedAt !== 'string') {
      return null;
    }
    return parsed as FailoverRecord;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Could not read worker port failover record', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function clearFailoverPort(): void {
  const path = getFailoverPath();
  try {
    if (existsSync(path)) {
      rmSync(path, { force: true });
      logger.info('SYSTEM', 'Discarded worker port failover record', { path });
    }
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Could not remove worker port failover record', {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function recordFailoverPort(port: number, preferredPort: number, reason: string): void {
  const record: FailoverRecord = {
    port,
    preferredPort,
    recordedAt: new Date().toISOString(),
    reason,
  };
  try {
    writeJsonFileAtomic(getFailoverPath(), record);
    logger.warn('SYSTEM', 'Worker failed over to an alternate port', { port, preferredPort, reason });
  } catch (error: unknown) {
    // Best-effort: without the record other clients keep using the configured
    // port and simply fail to reach this worker, which self-heals on the next
    // spawn. That is strictly better than throwing inside a hook.
    logger.warn('SYSTEM', 'Could not persist worker port failover record', {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The port callers should actually use, given the configured preference.
 *
 * Returns `preferredPort` unless a failover record exists AND is still fresh.
 * A record whose preference no longer matches the configured port (the user
 * changed CLAUDE_MEM_WORKER_PORT) or which has aged out is discarded here, so
 * resolution converges back on the configured port by itself.
 *
 * This is intentionally cheap and synchronous; it is on the hook path. It
 * does not probe health; liveness is enforced by the caller that owns the
 * connection attempt (see reconcileFailoverPort).
 */
export function resolveEffectiveWorkerPort(preferredPort: number): number {
  const record = readFailoverRecord();
  if (!record) return preferredPort;

  if (record.preferredPort !== preferredPort) {
    logger.info('SYSTEM', 'Failover record was for a different configured port: discarding', {
      recordedPreferred: record.preferredPort,
      configured: preferredPort,
    });
    clearFailoverPort();
    return preferredPort;
  }

  const ageMs = Date.now() - Date.parse(record.recordedAt);
  if (!Number.isFinite(ageMs) || ageMs > FAILOVER_MAX_AGE_MS) {
    logger.info('SYSTEM', 'Failover record aged out: discarding', { recordedAt: record.recordedAt });
    clearFailoverPort();
    return preferredPort;
  }

  return record.port;
}

/**
 * Drop the failover record if the configured port is usable again.
 *
 * This is what stops #3484 from recurring: without it a failover is permanent,
 * and the fleet drifts onto a port the user never configured. Call it when the
 * preferred port is observed free; the next spawn then goes home.
 */
export function reconcileFailoverPort(preferredPort: number, preferredPortIsFree: boolean): void {
  if (!preferredPortIsFree) return;
  if (readFailoverRecord() === null) return;
  logger.info('SYSTEM', 'Configured worker port is free again: dropping failover record', { preferredPort });
  clearFailoverPort();
}

/**
 * Find a bindable port near `preferredPort`.
 *
 * Fixed offsets rather than an OS-assigned ephemeral port: every client has to
 * independently agree on where the worker is, and a deterministic short list
 * keeps that discoverable (and keeps the chosen port stable across restarts)
 * where an arbitrary high port would not.
 */
export async function findFailoverPort(preferredPort: number): Promise<number | null> {
  for (const offset of FAILOVER_OFFSETS) {
    const candidate = preferredPort + offset;
    if (candidate > 65535) break;
    if (await isBindable(candidate)) return candidate;
  }
  return null;
}

function isBindable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
