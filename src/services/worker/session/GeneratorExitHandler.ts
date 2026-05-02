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
 * Post-generator-exit handler. Under the new model:
 *   - 'processing' rows reset to 'pending' on next generator start (handled by SessionManager.getMessageIterator).
 *   - Per-message retry/drain logic is gone; messages live in the queue until clearPendingForSession lands.
 *
 * Behavior:
 *   1. Always: ensure SDK subprocess is dead.
 *   2. Hard-stop reasons (shutdown / restart-guard): clear pending rows for the session and finalize.
 *   3. Otherwise (idle / overflow / natural completion):
 *        - If 0 pending → finalize.
 *        - If pending > 0 and restart guard allows → respawn with backoff.
 *        - If guard tripped → clear pending and finalize.
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

  const pendingStore = sessionManager.getPendingMessageStore();

  if (reason === 'shutdown' || reason === 'restart-guard') {
    logger.info('SESSION', `Generator exited with hard-stop reason — clearing pending and finalizing`, {
      sessionId: sessionDbId,
      reason
    });
    pendingStore.clearPendingForSession(sessionDbId);
    completionHandler.finalizeSession(sessionDbId);
    sessionManager.removeSessionImmediate(sessionDbId);
    return;
  }

  let pendingCount: number;
  try {
    pendingCount = pendingStore.getPendingCount(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    logger.error('SESSION', 'Error during recovery pending-count check; aborting to prevent leaks', {
      sessionId: sessionDbId
    }, normalized);
    pendingStore.clearPendingForSession(sessionDbId);
    completionHandler.finalizeSession(sessionDbId);
    sessionManager.removeSessionImmediate(sessionDbId);
    return;
  }

  if (pendingCount === 0) {
    session.restartGuard?.recordSuccess();
    session.consecutiveRestarts = 0;
    completionHandler.finalizeSession(sessionDbId);
    sessionManager.removeSessionImmediate(sessionDbId);
    return;
  }

  if (!session.restartGuard) session.restartGuard = new RestartGuard();
  const restartAllowed = session.restartGuard.recordRestart();
  session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

  if (!restartAllowed) {
    logger.error('SESSION', `CRITICAL: Restart guard tripped — session is dead, clearing pending and terminating`, {
      sessionId: sessionDbId,
      pendingCount,
      restartsInWindow: session.restartGuard.restartsInWindow,
      windowMs: session.restartGuard.windowMs,
      maxRestarts: session.restartGuard.maxRestarts,
      consecutiveFailures: session.restartGuard.consecutiveFailuresSinceSuccess,
      maxConsecutiveFailures: session.restartGuard.maxConsecutiveFailures,
    });
    session.consecutiveRestarts = 0;
    pendingStore.clearPendingForSession(sessionDbId);
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
