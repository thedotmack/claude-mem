import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
  restartGenerator?: (sessionDbId: number, source: string) => Promise<boolean | void>;
}

/** Initial replacement start plus two bounded recovery attempts. */
export const CONTEXT_BOUND_MAX_RESTART_ATTEMPTS = 3;

/**
 * Post-generator-exit handler.
 *
 * The generator's message iterator only ends on abort (idle / shutdown) or when
 * the SDK stream throws, so most exits mean this session is done. Quota exits
 * are different: claimed work has already been reset to pending, so leave the
 * session and in-RAM buffer alive for a later generator start. A proactive
 * Claude context rollover also preserves the buffer: the completed turn was
 * confirmed before the finalized usage frame requested the rollover, while
 * later turns may still be waiting in memory. If later work is already queued,
 * start its replacement generator immediately and bound recovery to three
 * start attempts so a transient failure cannot strand a final summarize
 * request or recreate the old unbounded retry storm.
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
  const { sessionManager, completionHandler, restartGenerator } = deps;
  const sessionDbId = session.sessionDbId;

  const tracked = getSdkProcessForSession(sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  const abortCategory = (reason ?? '').split(':')[0];
  if (abortCategory === 'quota' || abortCategory === 'auth' || abortCategory === 'context-bound') {
    const pendingCount = sessionManager.getMessageBuffer().getPendingCount(sessionDbId);
    logger.warn('SESSION', `Generator paused for ${abortCategory}; preserving buffered work`, {
      sessionId: sessionDbId,
      pendingCount,
    });

    if (abortCategory === 'context-bound' && pendingCount > 0) {
      if (reason === 'context-bound') {
        session.contextRolloverRestartAttempts = 0;
      }

      if (!restartGenerator) {
        logger.warn('SESSION', 'Claude context rollover has queued work but no restart callback', {
          sessionId: sessionDbId,
          pendingCount,
        });
        return;
      }

      const restartAttempt = (session.contextRolloverRestartAttempts ?? 0) + 1;
      session.contextRolloverRestartAttempts = restartAttempt;

      try {
        const started = await restartGenerator(sessionDbId, 'context-bound');
        if (started === false) {
          throw new Error('Replacement generator did not start');
        }
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const willRetry = restartAttempt < CONTEXT_BOUND_MAX_RESTART_ATTEMPTS;
        logger.error('SESSION', willRetry
          ? 'Failed to restart Claude after context rollover; retrying with buffered work preserved'
          : 'Failed to restart Claude after context rollover; buffered work preserved', {
          sessionId: sessionDbId,
          pendingCount,
          restartAttempt,
          maxRestartAttempts: CONTEXT_BOUND_MAX_RESTART_ATTEMPTS,
        }, normalized);

        if (willRetry) {
          await handleGeneratorExit(session, 'context-bound:restart-failed', deps);
        } else {
          logger.error('SESSION', 'Claude context rollover restart attempts exhausted; buffered work remains available', {
            sessionId: sessionDbId,
            pendingCount,
            restartAttempts: restartAttempt,
          });
        }
      }
    }
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
