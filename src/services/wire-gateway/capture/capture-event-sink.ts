// SPDX-License-Identifier: Apache-2.0
//
// Where the wire gateway's neutral events go (plan D5, Phase 5 task 5): the
// hook spool, one durable file per event, then a fire-and-forget nudge so a
// running worker drains now. The gateway never waits on the worker: the
// worker's own drainer (fs.watch, nudge, safety sweep) calls the same ingest
// functions as its HTTP routes, exactly once.

import { HookSpool, type HookSpoolKind, type HookSpoolPayloadByKind } from '../../../shared/hook-spool.js';
import { workerHttpRequest } from '../../../shared/worker-utils.js';
import { logger } from '../../../utils/logger.js';

/** The nudge is a hint; the spool file is already durable (copied from src/cli/spool-hook-event.ts SPOOL_NUDGE_TIMEOUT_MS). */
const WORKER_NUDGE_TIMEOUT_MS = 250;

export interface WireCaptureEventSink {
  /** Never throws and never waits on the worker. */
  emit<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]): void;
}

export interface HookSpoolCaptureEventSinkOptions {
  /** Test seam; defaults to <DATA_DIR>/state/hook-spool. */
  spool?: HookSpool;
  /** Test seam: replaces the worker nudge. */
  nudgeWorker?: () => void;
}

/**
 * One nudge in flight at a time; events spooled meanwhile are drained by the
 * same pass (the nudge pattern of src/cli/spool-hook-event.ts
 * `nudgeWorkerToDrainHookSpool`).
 */
function createWorkerNudger(): () => void {
  let nudgeInFlight = false;
  return () => {
    if (nudgeInFlight) return;
    nudgeInFlight = true;
    void (async () => {
      try {
        const response = await workerHttpRequest('/api/spool/nudge', { method: 'POST', timeoutMs: WORKER_NUDGE_TIMEOUT_MS });
        await response.body?.cancel();
      } catch (error: unknown) {
        logger.debug('WIRE', 'Hook spool nudge not delivered (the worker picks the entry up on its own)', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        nudgeInFlight = false;
      }
    })();
  };
}

export function createHookSpoolCaptureEventSink(options: HookSpoolCaptureEventSinkOptions = {}): WireCaptureEventSink {
  const spool = options.spool ?? new HookSpool();
  const nudgeWorker = options.nudgeWorker ?? createWorkerNudger();
  return {
    emit(kind, payload) {
      try {
        const entryPath = spool.enqueue(kind, payload);
        logger.debug('WIRE', 'Wire capture event spooled for the worker', { kind, entryPath });
      } catch (error) {
        logger.error('WIRE', 'Wire capture event could not be spooled; it is lost', {
          kind,
          contentSessionId: payload.contentSessionId,
        }, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      nudgeWorker();
    },
  };
}
