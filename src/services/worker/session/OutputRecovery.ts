import type { ActiveSession } from '../../worker-types.js';

/**
 * What happens to a queued batch whose reply was neither observation/summary
 * XML nor the `<skip_summary />` sentinel: the first such reply earns it one
 * more try in a fresh generation; a second one drops it, visibly.
 */
export type RejectedOutputDisposition = 'retry' | 'drop';

/**
 * Count one rejected reply against the batch it answered.
 *
 * Counted against the stable claimed batch (its message ids), not the reply
 * text: a reset to pending keeps the ids, so the restarted generator cannot
 * earn the same batch a second retry. A different batch starts a fresh count.
 */
export function recordRejectedOutput(session: ActiveSession): RejectedOutputDisposition {
  const batchKey = session.claimedMessageIds.join(',');
  if (session.invalidOutputBatchKey !== batchKey) {
    session.invalidOutputBatchKey = batchKey;
    session.consecutiveInvalidOutputs = 0;
  }
  session.consecutiveInvalidOutputs += 1;
  return session.consecutiveInvalidOutputs === 1 ? 'retry' : 'drop';
}

/** A valid answer, or a dropped batch, ends the count. */
export function clearRejectedOutput(session: ActiveSession): void {
  session.consecutiveInvalidOutputs = 0;
  session.invalidOutputBatchKey = null;
}
