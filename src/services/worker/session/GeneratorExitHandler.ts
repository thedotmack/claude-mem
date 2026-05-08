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

function isHardStopReason(reason: ActiveSession['abortReason']): boolean {
  return reason === 'shutdown' ||
    reason === 'restart-guard' ||
    reason === 'overflow' ||
    reason === 'quota' ||
    (typeof reason === 'string' && reason.startsWith('quota:'));
}

function isTemporarySqliteBusyOrLockedError(error: Error): boolean {
  const maybeCode = (error as { code?: unknown }).code;
  const code = typeof maybeCode === 'string' ? maybeCode.toUpperCase() : '';
  if (code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_BUSY_') ||
      code.startsWith('SQLITE_LOCKED_')) {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes('sqlite_busy') ||
    message.includes('sqlite_locked') ||
    /\bdatabase(?: table)? is (?:busy|locked)\b/.test(message);
}

/**
 * Post-generator-exit handler. Under the new model:
 *   - 'processing' rows reset to 'pending' on next generator start (handled by SessionManager.getMessageIterator).
 *   - Per-message retry/drain logic is gone; messages live in the queue until clearPendingForSession lands.
 *
 * Behavior:
 *   1. Always: ensure SDK subprocess is dead.
 *   2. Hard-stop reasons (shutdown / restart-guard / overflow / quota): clear pending rows for the session and finalize.
 *   3. Otherwise (idle / natural completion):
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

  const ensureRestartGuard = (): RestartGuard => {
    if (!session.restartGuard) session.restartGuard = new RestartGuard();
    return session.restartGuard;
  };

  const stopInMemoryLoop = (logPrefix: string) => {
    if (session.respawnTimer) {
      clearTimeout(session.respawnTimer);
      session.respawnTimer = undefined;
    }
    session.consecutiveRestarts = 0;
    logger.error('SESSION', `${logPrefix}; preserving pending rows and removing in-memory session`, {
      sessionId: sessionDbId,
      reason,
      restartsInWindow: session.restartGuard?.restartsInWindow,
      windowMs: session.restartGuard?.windowMs,
      maxRestarts: session.restartGuard?.maxRestarts,
      consecutiveFailures: session.restartGuard?.consecutiveFailuresSinceSuccess,
      maxConsecutiveFailures: session.restartGuard?.maxConsecutiveFailures,
    });
    try {
      completionHandler.finalizeSession(sessionDbId);
    } catch (e) {
      const normalized = e instanceof Error ? e : new Error(String(e));
      logger.error('SESSION', `${logPrefix} finalization failed while preserving pending rows`, {
        sessionId: sessionDbId,
        reason
      }, normalized);
    }
    sessionManager.removeSessionImmediate(sessionDbId);
  };

  const scheduleRestart = (options: { preservePendingOnGuardTrip: boolean }): number => {
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
      if (stillExists && stillExists !== session) {
        logger.info('SESSION', 'Skipping stale respawn timer for replaced session object', {
          sessionId: sessionDbId,
          reason
        });
        return;
      }
      if (stillExists && !stillExists.generatorPromise) {
        try {
          restartGenerator(stillExists, 'pending-work-restart');
        } catch (e) {
          const normalized = e instanceof Error ? e : new Error(String(e));
          const preservePendingOnGuardTrip = options.preservePendingOnGuardTrip ||
            isTemporarySqliteBusyOrLockedError(normalized);
          logger.error('SESSION', 'Restart generator failed after respawn timer; scheduling guarded retry', {
            sessionId: sessionDbId,
            reason
          }, normalized);

          const guard = ensureRestartGuard();
          const restartAllowed = guard.recordRestart();
          session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

          if (!restartAllowed) {
            if (preservePendingOnGuardTrip) {
              stopInMemoryLoop('Restart guard tripped after temporary SQLite pressure restart failure');
            } else {
              logger.error('SESSION', `CRITICAL: Restart guard tripped after restart generator failure — clearing pending and terminating`, {
                sessionId: sessionDbId,
                restartsInWindow: guard.restartsInWindow,
                windowMs: guard.windowMs,
                maxRestarts: guard.maxRestarts,
                consecutiveFailures: guard.consecutiveFailuresSinceSuccess,
                maxConsecutiveFailures: guard.maxConsecutiveFailures,
              });
              session.consecutiveRestarts = 0;
              terminateSession('Restart generator failure guard', true);
            }
            return;
          }

          scheduleRestart({ preservePendingOnGuardTrip });
        }
      }
    }, backoffMs);

    return backoffMs;
  };

  const terminateSession = (logPrefix: string, clearPending: boolean) => {
    try {
      if (clearPending) {
        try {
          pendingStore.clearPendingForSession(sessionDbId);
        } catch (e) {
          const normalized = e instanceof Error ? e : new Error(String(e));
          logger.error('SESSION', `${logPrefix} pending cleanup failed; continuing finalization`, {
            sessionId: sessionDbId,
            reason
          }, normalized);
        }
      }
      try {
        completionHandler.finalizeSession(sessionDbId);
      } catch (e) {
        const normalized = e instanceof Error ? e : new Error(String(e));
        logger.error('SESSION', `${logPrefix} finalization failed; forcing in-memory session removal`, {
          sessionId: sessionDbId,
          reason
        }, normalized);
      }
    } finally {
      sessionManager.removeSessionImmediate(sessionDbId);
    }
  };

  if (isHardStopReason(reason)) {
    logger.info('SESSION', `Generator exited with hard-stop reason — clearing pending and finalizing`, {
      sessionId: sessionDbId,
      reason
    });
    terminateSession('Hard-stop', true);
    return;
  }

  let pendingCount: number;
  try {
    pendingCount = pendingStore.getPendingCount(sessionDbId);
  } catch (e) {
    const normalized = e instanceof Error ? e : new Error(String(e));
    if (isTemporarySqliteBusyOrLockedError(normalized)) {
      const guard = ensureRestartGuard();
      const restartAllowed = guard.recordRestart();
      session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

      if (!restartAllowed) {
        stopInMemoryLoop('Restart guard tripped during temporary SQLite pending-count recovery');
        return;
      }

      const backoffMs = scheduleRestart({ preservePendingOnGuardTrip: true });
      logger.warn('SESSION', 'Temporary SQLite pressure during recovery pending-count check; preserving pending rows and scheduling restart', {
        sessionId: sessionDbId,
        reason,
        consecutiveRestarts: session.consecutiveRestarts,
        backoffMs
      }, normalized);
      return;
    }

    logger.error('SESSION', 'Error during recovery pending-count check; aborting to prevent leaks', {
      sessionId: sessionDbId
    }, normalized);
    terminateSession('Recovery abort', true);
    return;
  }

  if (pendingCount === 0) {
    session.restartGuard?.recordSuccess();
    session.consecutiveRestarts = 0;
    terminateSession('Natural completion', false);
    return;
  }

  const guard = ensureRestartGuard();
  const restartAllowed = guard.recordRestart();
  session.consecutiveRestarts = (session.consecutiveRestarts || 0) + 1;

  if (!restartAllowed) {
    logger.error('SESSION', `CRITICAL: Restart guard tripped — session is dead, clearing pending and terminating`, {
      sessionId: sessionDbId,
      pendingCount,
      restartsInWindow: guard.restartsInWindow,
      windowMs: guard.windowMs,
      maxRestarts: guard.maxRestarts,
      consecutiveFailures: guard.consecutiveFailuresSinceSuccess,
      maxConsecutiveFailures: guard.maxConsecutiveFailures,
    });
    session.consecutiveRestarts = 0;
    terminateSession('Restart guard', true);
    return;
  }

  logger.info('SESSION', `Restarting generator after exit with pending work`, {
    sessionId: sessionDbId,
    pendingCount,
    consecutiveRestarts: session.consecutiveRestarts,
    restartsInWindow: guard.restartsInWindow,
    maxRestarts: guard.maxRestarts,
  });

  scheduleRestart({ preservePendingOnGuardTrip: false });
}
