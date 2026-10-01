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
 * Counted against the batch, not the reply text, and keyed on its head (the
 * oldest claimed message): a reset to pending keeps it at the front of the
 * queue, so the restarted generator cannot earn the same batch a second retry.
 * Keyed on every claimed id, a retry that folded in observations queued since
 * the first try (Codex batches them) counted as a new batch, and a batch that
 * kept growing was retried once per growth. A different head starts a fresh
 * count: the old one was answered or dropped, and is gone from the queue.
 */
export function recordRejectedOutput(session: ActiveSession): RejectedOutputDisposition {
  const batchKey = String(session.claimedMessageIds[0] ?? '');
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
