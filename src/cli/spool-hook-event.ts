import { HookSpool, type HookSpoolKind, type HookSpoolPayloadByKind } from '../shared/hook-spool.js';
import { workerHttpRequest } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

export const SPOOL_NUDGE_TIMEOUT_MS = 250;

const nudgesInFlight = new Set<Promise<void>>();

/**
 * Best-effort poke so a running worker drains now rather than on its fs.watch
 * event or safety sweep. Never spawns a worker, never rejects, and its outcome
 * is irrelevant: the spool file is already durable. Started as soon as the
 * event is spooled; hookCommand awaits it (bounded by the 250 ms request
 * timeout) before process.exit, which would otherwise cut it off mid-flight.
 */
export function nudgeWorkerToDrainHookSpool(): Promise<void> {
  const nudge = (async () => {
    try {
      const response = await workerHttpRequest('/api/spool/nudge', { method: 'POST', timeoutMs: SPOOL_NUDGE_TIMEOUT_MS });
      await response.body?.cancel();
    } catch (error: unknown) {
      logger.debug('HOOK', 'Hook spool nudge not delivered (worker will pick the entry up on its own)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  nudgesInFlight.add(nudge);
  void nudge.finally(() => nudgesInFlight.delete(nudge));
  return nudge;
}

/** Resolves once every nudge this process started has been delivered or timed out (≤ 250 ms). */
export async function settleHookSpoolNudges(): Promise<void> {
  await Promise.all([...nudgesInFlight]);
}

/**
 * Write-hook hand-off: persist the event to the hook spool, start the poke to
 * the worker, return. The handler makes no awaited worker call and no
 * readiness wait; only hookCommand's exit waits (≤ 250 ms) for the poke.
 */
export function spoolHookEvent<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]): string {
  const entryPath = new HookSpool().enqueue(kind, payload);
  logger.debug('HOOK', 'Hook event spooled for the worker', { kind, entryPath });
  void nudgeWorkerToDrainHookSpool();
  return entryPath;
}
