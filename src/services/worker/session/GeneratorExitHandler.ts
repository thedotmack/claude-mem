import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
  restartGenerator?: (sessionDbId: number, source: string) => Promise<void>;
}

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
 * start its replacement generator immediately so a final summarize request
 * cannot remain stranded waiting for another ingest event.
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
      if (!restartGenerator) {
        logger.warn('SESSION', 'Claude context rollover has queued work but no restart callback', {
          sessionId: sessionDbId,
          pendingCount,
        });
        return;
      }

      try {
        await restartGenerator(sessionDbId, 'context-bound');
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        logger.error('SESSION', 'Failed to restart Claude after context rollover; buffered work preserved', {
          sessionId: sessionDbId,
          pendingCount,
        }, normalized);
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
