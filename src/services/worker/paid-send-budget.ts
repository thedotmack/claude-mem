import { randomUUID } from 'crypto';
import type { ActiveSession } from '../worker-types.js';

/**
 * Paid sends one claimed batch may make in total, across every path that can
 * resend it: withRetry's in-place loop, the transport resume after an
 * ambiguous failure, a response-stall resume, and Codex's retry. Two means the
 * first send plus one resend after an ambiguous outcome ("never pay twice"
 * allows one resend only because the first may not have run).
 */
export const DEFAULT_MAX_PAID_SENDS_PER_BATCH = 2;

/**
 * The paid-send allowance of one claimed batch, identified by its head (the
 * oldest claimed message id). A reset to pending keeps the head at the front of
 * the queue, so every resend of the same batch, from any generator, finds the
 * same budget on the session (OutputRecovery keys rejected replies the same
 * way). A different head is a different batch with a fresh budget.
 */
export class PaidSendBudget {
  /** Sent as `x-client-request-id` on every send of this batch. Tracing only, never idempotency. */
  readonly clientAttemptId = randomUUID();
  /** Every message id this batch carried at a send; they are parked together. */
  readonly batchMessageIds = new Set<number>();
  private paidSendsSpent = 0;

  constructor(
    readonly batchHeadMessageId: number,
    readonly maxPaidSends: number = DEFAULT_MAX_PAID_SENDS_PER_BATCH,
  ) {}

  get spentPaidSends(): number {
    return this.paidSendsSpent;
  }

  hasRemainingPaidSend(): boolean {
    return this.paidSendsSpent < this.maxPaidSends;
  }

  /** Count one send that may have been billed (answered, ambiguous, or an output failure). */
  recordPaidSend(): void {
    this.paidSendsSpent += 1;
  }
}

/**
 * The budget of the batch this session has claimed right now, created when the
 * head changes. Undefined when nothing is claimed (an init turn), which is not
 * a batch and carries no budget.
 */
export function paidSendBudgetForClaimedBatch(session: ActiveSession): PaidSendBudget | undefined {
  const batchHeadMessageId = session.claimedMessageIds[0];
  if (batchHeadMessageId === undefined) return undefined;
  if (session.paidSendBudget?.batchHeadMessageId !== batchHeadMessageId) {
    session.paidSendBudget = new PaidSendBudget(batchHeadMessageId);
  }
  for (const messageId of session.claimedMessageIds) {
    session.paidSendBudget.batchMessageIds.add(messageId);
  }
  return session.paidSendBudget;
}
