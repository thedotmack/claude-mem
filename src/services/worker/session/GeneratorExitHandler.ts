import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';

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
 *
 * Two bounded exceptions, neither of them a retry loop (#3419, plan-21):
 *  - an idle exit that finds work buffered: the idle timeout only fires after
 *    the queue sat empty, so that work arrived while the generator was
 *    stopping — typically the turn's summarize, whose own start request found
 *    the old generator still in place. It is new work, handed to a fresh
 *    generator instead of being disposed of with the buffer;
 *  - an unclassified failure with a summarize buffered: the summary is the
 *    session's last and most valuable event, so it gets one rescue pass per
 *    session before the session finalizes.
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
  // wiping the very queue the switch is meant to preserve. The transcript is
  // not carried over: every generator start opens a new generation seeded from
  // the session's memory (#3800, #3479), so the queue is what must survive.
  const abortCategory = (reason ?? '').split(':')[0];
  // Every category listed here has ALREADY called resetProcessingToPending
  // (except provider_switch, which parks a live buffer for a provider change).
  // Falling through to finalizeSession would remove the session and undo that
  // preservation — the second half of #3752.
  const PRESERVES_CLAIMED_WORK = ['quota', 'rate_limit', 'auth', 'overflow', 'provider_switch', 'transport'];
  // Every transport pause resumes on the transport backoff — a deadline or an
  // upstream fault that outlived the provider's retries, whatever code it
  // carries, and a transport failure the Claude CLI returned as text — except a
  // response stall, which the runner resumes on its own bounded schedule.
  const resumesOnTransportBackoff = abortCategory === 'transport' && reason !== 'transport:response_stall';
  // A later run may finish for a different reason before an earlier transport
  // timer fires. Its old timer must not bypass the new pause decision.
  if (!resumesOnTransportBackoff) {
    sessionManager.clearTransportResume?.(sessionDbId);
  }
  if (PRESERVES_CLAIMED_WORK.includes(abortCategory)) {
    session.pausedReason = abortCategory;
    logger.warn('SESSION', `Generator paused for ${abortCategory}; preserving buffered work`, {
      sessionId: sessionDbId,
      pendingCount: sessionManager.getMessageBuffer().getPendingCount(sessionDbId),
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
