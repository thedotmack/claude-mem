import type { ActiveSession } from '../../worker-types.js';
import { logger } from '../../../utils/logger.js';

export type RecoverableOutputDisposition = 'retry' | 'pause';

/**
 * Count failures against the stable claimed batch, not response text. Resetting
 * a claim preserves its message IDs, so a fresh generator cannot accidentally
 * earn another retry for the same work.
 */
export function recordRecoverableOutputFailure(
  session: ActiveSession,
): RecoverableOutputDisposition {
  const claimedIds = session.claimedMessageIds ?? [];
  const batchKey = claimedIds.length > 0
    ? claimedIds.join(',')
    // A fresh retry performs a synthetic init turn before it reclaims the
    // preserved batch. If that init fails, keep charging the failure to the
    // original batch instead of granting a second retry under a new key.
    : session.invalidOutputBatchKey ?? `untracked:${session.sessionDbId}`;

  if (session.invalidOutputBatchKey !== batchKey) {
    session.invalidOutputBatchKey = batchKey;
    session.consecutiveInvalidOutputs = 0;
  }

  session.consecutiveInvalidOutputs += 1;
  logger.debug('SESSION', 'Recorded recoverable observer-output failure', {
    sessionId: session.sessionDbId,
    attempt: session.consecutiveInvalidOutputs,
    batchSize: claimedIds.length,
  });
  return session.consecutiveInvalidOutputs === 1 ? 'retry' : 'pause';
}

export function clearRecoverableOutputFailure(session: ActiveSession): void {
  session.consecutiveInvalidOutputs = 0;
  session.invalidOutputBatchKey = null;
}
