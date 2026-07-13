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
 * Any exit that leaves buffered work behind (quota, exec timeout, spawn
 * failure, idle race) preserves the session and its in-RAM buffer instead of
 * finalizing: buffered work lives only in RAM, so finalize → dispose would
 * silently delete it. We still do NOT respawn here — the old respawn-on-pending
 * loop was the retry storm. Continuation happens naturally: the next
 * observation ingest (or /api/sessions/init) calls ensureGeneratorRunning,
 * which starts a fresh generator that drains whatever is buffered. Only a
 * clean exit with an empty buffer finalizes and removes the session.
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

  if ((reason ?? '').split(':')[0] === 'quota') {
    logger.warn('SESSION', 'Generator paused for quota; preserving buffered work', {
      sessionId: sessionDbId,
      pendingCount: sessionManager.getMessageBuffer().getPendingCount(sessionDbId),
    });
    return;
  }

  // Claimed-but-unconfirmed messages count as buffered work too.
  await sessionManager.resetProcessingToPending(sessionDbId);
  const pendingCount = sessionManager.getMessageBuffer().getPendingCount(sessionDbId);
  if (pendingCount > 0) {
    logger.warn('SESSION', 'Generator exited with buffered work; preserving session (finalize would dispose it)', {
      sessionId: sessionDbId,
      reason,
      pendingCount,
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
