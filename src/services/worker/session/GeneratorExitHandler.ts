import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { logger } from '../../../utils/logger.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';
import { RestartGuard } from '../RestartGuard.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
  restartGenerator: (session: ActiveSession, source: string) => void;
}

/**
 * Unified post-generator-exit handler. Both `worker-service.ts:startSessionProcessor`
 * and `SessionRoutes.ts:startGeneratorWithProvider` finally blocks delegate here.
 *
 * Behavior contract (matches Phase 5 of `kill-the-asshole-gates.md`):
 *   1. Always: ensure SDK subprocess is dead (kill with timeout if alive).
 *   2. Always: drain `processingMessageIds` via `sessionManager.markMessageFailed`
 *      (which now wakes the iterator — Phase 1.2).
 *   3. If `reason === 'shutdown'` or `'restart-guard'`:
 *        - Drain pending rows via `transitionMessagesTo('failed', { sessionDbId })`.
 *        - Finalize session (marks sdk_sessions complete) and remove from Map.
 *        - This fixes the L16 worker-service bug where rows were orphaned.
 *   4. If `pendingCount === 0`:
 *        - Record restart-guard success.
 *        - Finalize session normally (mark sdk_sessions complete, remove from Map).
 *   5. If `pendingCount > 0`:
 *        - Increment restart guard.
 *        - If guard allows: schedule respawn with exponential backoff via
 *          `session.respawnTimer` (per-session timer, no global Set).
 *        - If guard tripped: drain to 'abandoned' and remove from Map.
 */
export async function handleGeneratorExit(
  session: ActiveSession,
  reason: ActiveSession['abortReason'],
  deps: GeneratorExitDependencies
): Promise<void> {
  const { sessionManager, completionHandler, restartGenerator } = deps;
  const sessionDbId = session.sessionDbId;

  // 1. Ensure SDK subprocess is dead.
  const tracked = getSdkProcessForSession(sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  // 2. Drain processingMessageIds (re-pend or fail per markFailed retry policy).
  const inflightIds = session.processingMessageIds.slice();
  session.processingMessageIds = [];
  for (const messageId of inflightIds) {
    try {
      sessionManager.markMessageFailed(sessionDbId, messageId);
    } catch (markErr) {
      const normalized = markErr instanceof Error ? markErr : new Error(String(markErr));
      logger.error('SESSION', 'Failed to requeue in-flight message after generator exit', {
        sessionId: sessionDbId,
        messageId,
      }, normalized);
    }
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  const pendingStore = sessionManager.getPendingMessageStore();

  // 3. Hard-stop reasons: shutdown / restart-guard. Drain and remove from Map.
  if (reason === 'shutdown' || reason === 'restart-guard') {
    logger.info('SESSION', `Generator exited with hard-stop reason — draining pending rows and finalizing`, {
      sessionId: sessionDbId,
      reason
    });
    try {
      const drained = pendingStore.transitionMessagesTo('failed', { sessionDbId });
      if (drained > 0) {
        logger.error('SESSION', 'Drained pending rows after hard-stop generator exit', {
          sessionId: sessionDbId,
          reason,
          drained,
        });
      }
    } catch (drainErr) {
      const normalized = drainErr instanceof Error ? drainErr : new Error(String(drainErr));
      logger.error('SESSION', 'Failed to drain pending rows after hard-stop generator exit', {
        sessionId: sessionDbId,
        reason,
      }, normalized);
    }
    completionHandler.finalizeSession(sessionDbId);
    sessionManager.removeSessionImmediate(sessionDbId);
    return;
  }

  // 4 / 5. Soft-exit reasons (idle / overflow / natural-completion).
  let pendingCount: number;
  try {
    pendingCount = pendingStore.getPendingCount(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    logger.error('SESSION', 'Error during recovery pending-count check; aborting to prevent leaks', {
      sessionId: sessionDbId
    }, normalized);
    // Treat as restart-guard: drain and remove.
    try {
      pendingStore.transitionMessagesTo('failed', { sessionDbId });
    } catch {/* already logged */}
    completionHandler.finalizeSession(sessionDbId);
    sessionManager.removeSessionImmediate(sessionDbId);
    return;
  }

  if (pendingCount === 0) {
    // 4. Natural completion. Finalize and remove.
    session.restartGuard?.recordSuccess();
    session.consecutiveRestarts = 0;
    completionHandler.finalizeSession(sessionDbId);
    sessionManager.removeSessionImmediate(sessionDbId);
    return;
  }

  // 5. Pending work remains. Try to respawn with restart-guard backoff.
  if (!session.restartGuard) session.restartGuard = new RestartGuard();
  const restartAllowed = session.restartGuard.recordRestart();
  session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

  if (!restartAllowed) {
    logger.error('SESSION', `CRITICAL: Restart guard tripped — session is dead, draining pending messages and terminating`, {
      sessionId: sessionDbId,
      pendingCount,
      restartsInWindow: session.restartGuard.restartsInWindow,
      windowMs: session.restartGuard.windowMs,
      maxRestarts: session.restartGuard.maxRestarts,
      consecutiveFailures: session.restartGuard.consecutiveFailuresSinceSuccess,
      maxConsecutiveFailures: session.restartGuard.maxConsecutiveFailures,
      action: 'Generator will NOT restart. Pending messages drained to abandoned.'
    });
    session.consecutiveRestarts = 0;
    try {
      const drained = pendingStore.transitionMessagesTo('abandoned', { sessionDbId });
      if (drained > 0) {
        logger.error('SESSION', 'Drained pending messages to abandoned after restart guard trip', {
          sessionId: sessionDbId,
          drained,
        });
      }
    } catch (drainErr) {
      const normalized = drainErr instanceof Error ? drainErr : new Error(String(drainErr));
      logger.error('SESSION', 'Failed to drain pending messages after restart guard trip', {
        sessionId: sessionDbId,
      }, normalized);
    }
    completionHandler.finalizeSession(sessionDbId);
    sessionManager.removeSessionImmediate(sessionDbId);
    return;
  }

  logger.info('SESSION', `Restarting generator after exit with pending work`, {
    sessionId: sessionDbId,
    pendingCount,
    consecutiveRestarts: session.consecutiveRestarts,
    restartsInWindow: session.restartGuard.restartsInWindow,
    maxRestarts: session.restartGuard.maxRestarts,
  });

  const oldController = session.abortController;
  session.abortController = new AbortController();
  oldController.abort();

  const backoffMs = Math.min(1000 * Math.pow(2, session.consecutiveRestarts - 1), 8000);

  if (session.respawnTimer) {
    clearTimeout(session.respawnTimer);
  }
  session.respawnTimer = setTimeout(() => {
    session.respawnTimer = undefined;
    const stillExists = deps.sessionManager.getSession(sessionDbId);
    if (stillExists && !stillExists.generatorPromise) {
      restartGenerator(stillExists, 'pending-work-restart');
    }
  }, backoffMs);
}
