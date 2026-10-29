import { randomUUID } from 'crypto';
import type { ActiveSession } from '../worker-types.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

/**
 * Paid sends one claimed batch may make in total, across every path that can
 * resend it: withRetry's in-place loop, the transport resume after an
 * ambiguous failure, a response-stall resume, and Codex's retry. Two means the
 * first send plus one resend after an ambiguous outcome ("never pay twice"
 * allows one resend only because the first may not have run).
 */
export const DEFAULT_MAX_PAID_SENDS_PER_BATCH = 2;

/**
 * No zero for "unlimited": the budget also counts output failures, so a model
 * that keeps answering unusably would have its batch resent forever.
 */
const MAX_PAID_SENDS_BOUNDS = { min: 1, max: 20 } as const;

/**
 * CLAUDE_MEM_MAX_PAID_SENDS from the environment, then settings.json, then the
 * default, read for every new batch so a change applies without a restart. A
 * self-hosted endpoint does not bill a resend, and raising the cap there keeps
 * an endpoint restart from parking every batch claimed meanwhile (#4737).
 */
export function resolveMaxPaidSendsPerBatch(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = USER_SETTINGS_PATH,
): number {
  const raw = env.CLAUDE_MEM_MAX_PAID_SENDS
    ?? SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_MAX_PAID_SENDS;
  const trimmed = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (trimmed === '') return DEFAULT_MAX_PAID_SENDS_PER_BATCH;
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (parsed >= MAX_PAID_SENDS_BOUNDS.min && parsed <= MAX_PAID_SENDS_BOUNDS.max) return parsed;
  logger.warn('SDK', 'Invalid CLAUDE_MEM_MAX_PAID_SENDS, using default', { value: raw, ...MAX_PAID_SENDS_BOUNDS });
  return DEFAULT_MAX_PAID_SENDS_PER_BATCH;
}

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
export function paidSendBudgetForClaimedBatch(
  session: ActiveSession,
  maxPaidSends: number = resolveMaxPaidSendsPerBatch(),
): PaidSendBudget | undefined {
  const batchHeadMessageId = session.claimedMessageIds[0];
  if (batchHeadMessageId === undefined) return undefined;
  if (session.paidSendBudget?.batchHeadMessageId !== batchHeadMessageId) {
    session.paidSendBudget = new PaidSendBudget(batchHeadMessageId, maxPaidSends);
  }
  for (const messageId of session.claimedMessageIds) {
    session.paidSendBudget.batchMessageIds.add(messageId);
  }
  return session.paidSendBudget;
}
