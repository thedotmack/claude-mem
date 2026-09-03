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
 * the SDK stream throws, so most exits mean this session is done. Quota, auth
 * and transport exits are different: claimed work has already been reset to
 * pending, so leave the session and in-RAM buffer alive for a later generator
 * start.
 *
 * For every other exit we do NOT respawn on remaining buffered work: the old
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
  const abortCategory = (reason ?? '').split(':')[0];
  // Every category listed here has ALREADY called resetProcessingToPending.
  // Falling through to finalizeSession would remove the session and undo that
  // preservation, so a new preserving abortReason must be added here too — this
  // is the half of #3752 that the requeue alone does not buy.
  const PRESERVES_CLAIMED_WORK = ['quota', 'auth', 'overflow', 'transport'];
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
