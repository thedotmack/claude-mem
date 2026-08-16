import { logger } from '../../utils/logger.js';
import {
  captureProcessStartToken,
  isPidAlive,
  readPersistedRegistryRecords,
  verifyManagedProcessIdentity,
  verifyPidFileOwnership,
  type ManagedProcessRecord,
  type PidInfo,
} from '../../supervisor/process-registry.js';
import net from 'net';
import { signalProcess } from '../../supervisor/shutdown.js';

/**
 * Worker-port reclaim (#3073, #3450) under the lifecycle contract from #3138:
 * health is the oracle, ownership is proven by start token, and there are no
 * arbitrary kills.
 *
 * The previous implementation asked the OS "which PID owns this port?" and
 * killed that process tree. That is unsound: the answer may be an unrelated
 * service, which is precisely what review reproduced against PR #3405. This
 * module never asks who owns the port. It only asks claude-mem's own records
 * (the PID file and supervisor.json) what claude-mem itself started, and it
 * refuses to signal anything it cannot tie to those records by start token.
 *
 * The ladder, in order:
 *
 *   1. PID file names a VERIFIED live owner (alive + readable, matching token
 *      + same port) that does not answer /api/health -> it is our wedged
 *      worker. SIGTERM, bounded wait, re-verify the SAME token, SIGKILL.
 *      Tokenless or unreadable is not verified: nothing is signalled.
 *   2. That verified owner DOES answer /api/health (readiness merely false)
 *      -> it is initializing. Never reclaimed.
 *   3a. The owner is dead but the port is still bound: the ghost socket. The
 *      socket is held by a child that inherited the handle (#3450 traces it to
 *      the uvx -> uv -> chroma-mcp -> python chain). Reap the registry records
 *      claude-mem wrote when it spawned those children, each one identity-
 *      verified before it is signalled AND linked (ownerPid/ownerStartToken)
 *      to a worker generation that is provably gone. A live worker's own
 *      children share the same registry file and are never touched.
 *   3b. Ownership cannot be proven: no PID file, tokenless, token mismatch,
 *      a foreign listener, or 3a did not recover the port. Signal NOTHING and
 *      tell the caller to fail over to a different port.
 *
 * Rungs 1, 2 and the once-per-invocation bound are the policy proposed by
 * @greghughespdx in #3448, adopted here rather than reinvented. Rung 3a is the
 * addition that actually clears the inherited socket, which verified-owner
 * reclaim alone cannot reach because by then the owner is already gone.
 */

/** How long to wait for a SIGTERM'd worker to exit before escalating. */
const OWNER_SIGTERM_GRACE_MS = 5_000;

/** How long to wait for a SIGKILL'd worker to actually disappear. */
const OWNER_SIGKILL_CONFIRM_MS = 2_000;

/** How long to wait for the port to come back after a reclaim. */
const PORT_RECOVERY_WAIT_MS = 5_000;

/**
 * Health probe used to separate "initializing" (rung 2) from "wedged" (rung 1).
 * Short on purpose: the caller has already waited out the full health window
 * before reaching reclaim, so this only needs to catch a worker that started
 * answering in the interim.
 */
const OWNER_HEALTH_PROBE_MS = 1_000;

export type ReclaimOutcome =
  /** Port recovered. The caller should proceed to spawn on the same port. */
  | { kind: 'reclaimed'; via: 'verified-owner' | 'registered-children' }
  /** A verified owner is alive and answering health; leave it alone. */
  | { kind: 'owner-initializing' }
  /** Ownership unprovable. The caller MUST fail over; nothing was signalled. */
  | { kind: 'unprovable'; reason: string }
  /** We owned it and tried, but the port did not come back. */
  | { kind: 'failed'; reason: string };

/**
 * Can we bind `port` right now? Definitive, and (unlike an HTTP probe)
 * incapable of hanging.
 */
function isPortBindable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Bounded health probe.
 *
 * Deliberately NOT HealthMonitor.waitForHealth: its fetch has no deadline, and
 * the exact thing we are recovering from is a socket that completes the TCP
 * handshake and then answers nothing (#3450). Against that listener an
 * unbounded fetch never settles, so a reclaim built on it would hang the hook
 * it is supposed to be rescuing. Every probe here carries its own abort.
 */
async function probeHealthBounded(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Has the port recovered?
 *
 * "The port is free" is the wrong question on its own, and #3450 documents
 * why: a concurrently-spawned worker can claim the port before we look, so it
 * may never be observed idle even on a fully successful recovery. Recovery
 * therefore means EITHER the port is genuinely bindable (ours to take) OR
 * something healthy is now answering on it.
 */
async function confirmPortRecovered(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortBindable(port)) return true;
    if (await probeHealthBounded(port, OWNER_HEALTH_PROBE_MS)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Is this record's owning worker generation provably gone?
 *
 * supervisor.json is shared across generations, so a live, identity-verified
 * child record may belong to the CURRENT worker (an active SDK session, the
 * live chroma launcher) rather than to the dead one whose socket we are
 * reclaiming. Being verified-live is therefore not enough to signal it; its
 * owner has to be the worker we know is gone. That is true when the owner is
 * exactly the one rung 1 just terminated, or when the owner pid is dead or
 * has been recycled onto a different process. A record with no owner linkage
 * (persisted by an older claude-mem) cannot be tied to any generation and is
 * left alone; the caller fails over instead.
 */
function ownerIsGone(record: ManagedProcessRecord, terminatedOwner: PidInfo | null): boolean {
  if (typeof record.ownerPid !== 'number' || !record.ownerStartToken) return false;

  if (
    terminatedOwner !== null &&
    record.ownerPid === terminatedOwner.pid &&
    record.ownerStartToken === terminatedOwner.startToken
  ) {
    return true;
  }

  if (!isPidAlive(record.ownerPid)) return true;

  const currentOwnerToken = captureProcessStartToken(record.ownerPid);
  // Unreadable token: the owner may still be running. Resolve toward leaving
  // its children alone.
  if (currentOwnerToken === null) return false;
  return currentOwnerToken !== record.ownerStartToken;
}

/**
 * Reap the children a dead worker generation left behind, according to
 * claude-mem's own registry.
 *
 * Every PID here comes from a record claude-mem wrote at spawn time. A record
 * is signalled only when BOTH hold: its owner worker is provably gone
 * (ownerIsGone), and the record itself is re-verified by start token
 * immediately beforehand, so a PID recycled onto an unrelated process is
 * skipped rather than killed. Records that are dead, tokenless, mismatched,
 * unlinked to an owner, or owned by a live worker are left alone.
 *
 * The 'worker' record is excluded: the worker is rung 1's business, reached
 * through the PID file. This reaps what it left behind.
 *
 * Name-based matching is deliberately not used: #3450 notes the last two
 * links in the chroma chain run as plain `python.exe`, so a name filter both
 * misses the actual handle holders and risks unrelated processes.
 */
async function reapRegisteredChildren(currentPid: number, terminatedOwner: PidInfo | null): Promise<number> {
  const candidates = readPersistedRegistryRecords().filter(
    record => record.pid !== currentPid && record.type !== 'worker' && record.id !== 'worker'
  );

  const orphans: ManagedProcessRecord[] = [];
  for (const record of candidates) {
    if (!ownerIsGone(record, terminatedOwner)) {
      logger.debug('SYSTEM', 'Skipping registered child during port reclaim: owner generation not proven gone', {
        id: record.id,
        pid: record.pid,
        ownerPid: record.ownerPid ?? null,
      });
      continue;
    }
    if (verifyManagedProcessIdentity(record)) {
      orphans.push(record);
    }
  }

  if (orphans.length === 0) return 0;

  logger.warn('SYSTEM', 'Reaping identity-verified child processes left behind by a dead worker', {
    count: orphans.length,
    records: orphans.map(record => ({ id: record.id, pid: record.pid, type: record.type })),
  });

  let signalled = 0;
  for (const record of orphans) {
    // Re-verify immediately before THIS signal: an earlier iteration awaited,
    // and in that window this record's PID may have exited and been recycled.
    // The batch check above decides what is an orphan; this one decides
    // whether the PID is still that orphan right now.
    if (!verifyManagedProcessIdentity(record)) {
      logger.debug('SYSTEM', 'Registered child changed identity before it could be signalled; skipping', {
        id: record.id,
        pid: record.pid,
      });
      continue;
    }
    // SIGKILL directly: these are orphans of a worker that is already gone, so
    // there is no graceful-shutdown path left for them to take. On Windows
    // signalProcess uses `taskkill /T`, which is what reaches the grandchildren
    // (`python.exe`) actually holding the inherited handle.
    try {
      await signalProcess(record, 'SIGKILL');
      signalled += 1;
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Failed to signal registered child during port reclaim', {
        id: record.id,
        pid: record.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return signalled;
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

/**
 * Rung 1: terminate a worker we have positively identified as ours.
 *
 * The start token is re-verified, strictly, immediately before SIGKILL so
 * that a PID recycled during the SIGTERM grace window is never the thing we
 * force-kill. Anything short of a readable, matching token means no SIGKILL.
 *
 * Returns true only when the owner is conclusively gone (observed dead after
 * SIGTERM or after SIGKILL). The caller uses that to decide whether the
 * owner's linked children may be reaped as orphans: a worker that survived
 * (escalation refused, SIGKILL failed, or still alive after it) is still a
 * live generation and its children are not orphans.
 */
async function terminateVerifiedOwner(info: PidInfo): Promise<boolean> {
  const record: ManagedProcessRecord = {
    id: 'worker',
    pid: info.pid,
    type: 'worker',
    startedAt: info.startedAt,
    startToken: info.startToken,
  };

  logger.warn('SYSTEM', 'Reclaiming the worker port from our own wedged worker', {
    pid: info.pid,
    port: info.port,
  });

  try {
    await signalProcess(record, 'SIGTERM');
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'SIGTERM to wedged worker failed', {
      pid: info.pid,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (await waitUntilDead(info.pid, OWNER_SIGTERM_GRACE_MS)) return true;

  // Still alive. Escalate, but only after proving it is still the SAME
  // process. This is a kill decision, so it fails closed like
  // verifyManagedProcessIdentity: no persisted token, an unreadable current
  // token, or a mismatch all mean we cannot re-prove identity, and a PID
  // recycled during the grace window would otherwise take the SIGKILL meant
  // for our worker. (SIGTERM above was sent under verifyPidFileOwnership's
  // more permissive "may keep running" rule; escalation gets the strict one.)
  const currentToken = captureProcessStartToken(info.pid);
  if (!info.startToken || currentToken === null || currentToken !== info.startToken) {
    logger.warn('SYSTEM', 'Cannot re-prove the wedged worker\'s identity after the SIGTERM grace window; not escalating to SIGKILL', {
      pid: info.pid,
      reason: !info.startToken
        ? 'pid file has no start token'
        : currentToken === null
          ? 'current start token unreadable'
          : 'start token mismatch (PID recycled)',
    });
    return false;
  }

  try {
    await signalProcess(record, 'SIGKILL');
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'SIGKILL to wedged worker failed', {
      pid: info.pid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  return waitUntilDead(info.pid, OWNER_SIGKILL_CONFIRM_MS);
}

/**
 * Attempt to reclaim `port` for a new worker.
 *
 * Callers MUST have already established that no healthy worker answers on the
 * port. Nothing here is signalled without start-token-proven ownership; an
 * `unprovable` outcome guarantees no signal was sent to anything.
 */
export async function reclaimWorkerPort(
  port: number,
  pidInfo: PidInfo | null,
  currentPid: number = process.pid
): Promise<ReclaimOutcome> {
  const ownsThisPort = pidInfo !== null && pidInfo.port === port;

  if (ownsThisPort && pidInfo.pid === currentPid) {
    return { kind: 'unprovable', reason: 'pid-file names the current process' };
  }

  if (ownsThisPort && verifyPidFileOwnership(pidInfo)) {
    // Rung 2: a verified owner that still answers health is initializing, not
    // wedged. Readiness being false is normal during migrations/cold boot.
    if (await probeHealthBounded(port, OWNER_HEALTH_PROBE_MS)) {
      logger.info('SYSTEM', 'Verified worker owns the port and answers health, so it is initializing, not wedged', {
        pid: pidInfo.pid,
        port,
      });
      return { kind: 'owner-initializing' };
    }

    // verifyPidFileOwnership answers "may this worker keep running?" and so
    // tolerates a tokenless pid file or an unreadable current token. Rung 1
    // is a kill decision and gets the strict rule instead: no readable,
    // matching start token means we cannot prove the live PID is our worker
    // rather than a recycled one, so nothing is signalled and we fail over.
    if (!verifyManagedProcessIdentity({
      pid: pidInfo.pid,
      type: 'worker',
      startedAt: pidInfo.startedAt,
      startToken: pidInfo.startToken,
    })) {
      const reason = 'pid-file owner is alive but its identity cannot be proven by start token';
      logger.warn('SYSTEM', 'Cannot prove the live pid-file owner is our worker: leaving it untouched and failing over', {
        pid: pidInfo.pid,
        port,
        reason,
      });
      return { kind: 'unprovable', reason };
    }

    // Rung 1.
    const ownerGone = await terminateVerifiedOwner(pidInfo);
    // The worker's own children outlive it and are what pin the socket, so
    // clear them too; otherwise rung 1 recreates the ghost socket it just fixed.
    // Only ITS children, and only once it is conclusively gone: if the owner
    // survived, its children are a live generation's and ownerIsGone's normal
    // liveness/token rule decides (i.e. leaves them alone).
    await reapRegisteredChildren(currentPid, ownerGone ? pidInfo : null);

    if (await confirmPortRecovered(port, PORT_RECOVERY_WAIT_MS)) {
      return { kind: 'reclaimed', via: 'verified-owner' };
    }
    return { kind: 'failed', reason: 'port still held after terminating the verified owner' };
  }

  // Rung 3a: no verified live owner. If the port is still bound, the holder is
  // something a dead worker left behind. Reap only what our registry vouches
  // for AND can tie to a worker generation that is provably gone; a child of
  // the live worker, or an unlinked record, is never signalled from here.
  const reaped = await reapRegisteredChildren(currentPid, null);
  if (reaped > 0 && (await confirmPortRecovered(port, PORT_RECOVERY_WAIT_MS))) {
    logger.info('SYSTEM', 'Worker port recovered by reaping registered orphans of a dead worker', { port, reaped });
    return { kind: 'reclaimed', via: 'registered-children' };
  }

  // Rung 3b: we cannot prove who holds this port. Signal nothing; fail over.
  const reason = reaped > 0
    ? 'port still held after reaping registered orphans'
    : 'no identity-verified claude-mem process holds this port';
  logger.warn('SYSTEM', 'Cannot prove ownership of the occupied worker port: leaving it untouched and failing over', {
    port,
    reason,
  });
  return { kind: 'unprovable', reason };
}
