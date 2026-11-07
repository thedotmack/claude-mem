import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';
import { abortCategoryOf, PRESERVED_ABORT_CATEGORIES } from './abort-reason.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
  /**
   * Start a fresh generator for this session on the next tick (the runner's
   * resumeGeneratorLater). Used only for buffered work that finalizing would
   * otherwise dispose of: work that arrived while an idle generator was
   * stopping, and one rescue of a summarize after an unclassified failure.
   */
  resumeGenerator?: (source: string) => void;
}

/**
 * End one observer generation. Quota/auth failures discard pending inputs;
 * only fresh activity may try again through provider admission. Other pauses
 * retain the bounded RAM buffer, never a durable inference queue.
 *
 * The idle-teardown and one-shot summary rescues below cover work that arrived
 * during a live generation. They do not reconstruct an old observer session.
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

  // Recoverable transitions can reuse only the current bounded live buffer.
  // They do not make an observer checkpoint or extend an input's lifetime.
  const abortCategory = abortCategoryOf(reason);
  const resumesOnTransportBackoff = abortCategory === 'transport' && reason !== 'transport:response_stall';
  // A later run may finish for a different reason before an earlier transport
  // timer fires. Its old timer must not bypass the new pause decision.
  if (!resumesOnTransportBackoff) {
    sessionManager.clearTransportResume?.(sessionDbId);
  }
  if (abortCategory === 'quota' || abortCategory === 'auth') {
    sessionManager.discardBufferedWork(sessionDbId);
    session.pendingAgentId = null;
    session.pendingAgentType = null;
    session.paidSendBudget = undefined;
    session.pausedReason = abortCategory;
    logger.warn('SESSION', 'Observer unavailable; skipped pending inputs, awaiting fresh activity', {
      sessionId: sessionDbId,
      reason: abortCategory,
    });
    return;
  }
  if (PRESERVED_ABORT_CATEGORIES.has(abortCategory)) {
    // A claim left behind by this dead run is orphaned: no run will confirm
    // and none is in flight, so pruning could never expire it (claimed items
    // are exempt while a live send owns them). Releasing is the live-only
    // move — the fragment keeps its original buffered age and a later
    // generator (transport backoff or fresh activity) starts from pending.
    // It gains nothing by changing its path, and unclaimed work of this
    // buffer stays fresh for its normal expiry window.
    const released = (await sessionManager.resetProcessingToPending?.(sessionDbId)) ?? 0;
    session.pausedReason = abortCategory;
    logger.warn('SESSION', `Generator paused for ${abortCategory}; preserving buffered work`, {
      sessionId: sessionDbId,
      pendingCount: sessionManager.getMessageBuffer().getPendingCount(sessionDbId),
      released,
    });
    if (resumesOnTransportBackoff) {
      sessionManager.scheduleTransportResume?.(sessionDbId);
    }
    return;
  }

  if (deps.resumeGenerator) {
    const pendingCount = reason === 'idle'
      ? sessionManager.getMessageBuffer?.()?.getPendingCount(sessionDbId) ?? 0
      : 0;
    if (pendingCount > 0) {
      logger.info('SESSION', 'Work arrived while the idle generator was stopping; starting a fresh one instead of finalizing', {
        sessionId: sessionDbId,
        pendingCount,
      });
      deps.resumeGenerator('idle-teardown');
      return;
    }
    if (reason === null && sessionManager.hasPendingSummarize?.(sessionDbId)) {
      if (sessionManager.claimSummarizeRescue(sessionDbId)) {
        await sessionManager.resetProcessingToPending(sessionDbId);
        logger.warn('SESSION', 'Generator failed with a summarize buffered; starting one rescue pass', {
          sessionId: sessionDbId,
        });
        deps.resumeGenerator('summarize-rescue');
        return;
      }
      logger.warn('SESSION', 'Dropping the buffered summarize after its one rescue pass', { sessionId: sessionDbId });
    }
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
