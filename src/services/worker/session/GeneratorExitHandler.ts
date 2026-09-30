import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
}

/**
 * Post-generator-exit handler.
 *
 * The generator's message iterator only ends on abort (idle / shutdown) or when
 * the SDK stream throws, so most exits mean this session is done. Quota exits
 * are different: claimed work has already been reset to pending, so leave the
 * session and in-RAM buffer alive for a later generator start.
 *
 * For non-quota exits we do NOT respawn on remaining buffered work: the old
 * respawn-on-pending loop, driven by the durable pending_messages queue, was the
 * retry storm. Buffered work lives only in RAM now; anything still buffered is
 * dropped here and recovered, if needed, by replaying the Claude Code
 * transcript. Continuation of a session that is still live happens naturally —
 * the next observation ingest calls ensureGeneratorRunning, which starts a
 * fresh generator that drains whatever is buffered.
 */
export async function handleGeneratorExit(
  session: ActiveSession,
  reason: ActiveSession['abortReason'],
  deps: GeneratorExitDependencies
): Promise<void> {
  const { sessionManager, completionHandler } = deps;
  const sessionDbId = session.sessionDbId;

  const tracked = getSdkProcessForSession(sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  // 'overflow' joins quota/auth as a pause-and-preserve exit: ResponseProcessor
  // has already reset the claimed batch to pending and (on a recycle) cleared
  // the conversation, so the session must survive for the next ingest to open a
  // fresh generator and drain it. Finalizing here would drop that work (#3800).
  // 'provider_switch' (#2756) is the same shape for a different reason:
  // SessionRoutes aborted a generator that was PARKED in waitForSlot (never
  // acquired a slot / never spawned) to switch providers, and is about to
  // start a fresh generator for the newly-selected provider on this same
  // session — finalizeSession + removeSessionImmediate would dispose the
  // in-RAM buffer (SessionManager.removeSessionImmediate -> buffer.dispose),
  // wiping the very queue/conversationHistory the switch is meant to preserve.
  const abortCategory = (reason ?? '').split(':')[0];
  // Every category listed here has ALREADY called resetProcessingToPending
  // (except provider_switch, which parks a live buffer for a provider change).
  // Falling through to finalizeSession would remove the session and undo that
  // preservation — the second half of #3752.
  const PRESERVES_CLAIMED_WORK = ['quota', 'auth', 'overflow', 'provider_switch', 'transport'];
  if (PRESERVES_CLAIMED_WORK.includes(abortCategory)) {
    logger.warn('SESSION', `Generator paused for ${abortCategory}; preserving buffered work`, {
      sessionId: sessionDbId,
      pendingCount: sessionManager.getMessageBuffer().getPendingCount(sessionDbId),
    });
    return;
  }

  logger.info('SESSION', 'Generator exited — finalizing session', { sessionId: sessionDbId, reason });

  try {
    await completionHandler.finalizeSession(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    logger.error('SESSION', 'Finalization failed; forcing in-memory session removal', {
      sessionId: sessionDbId,
      reason
    }, normalized);
  } finally {
    sessionManager.removeSessionImmediate(sessionDbId);
  }
}
