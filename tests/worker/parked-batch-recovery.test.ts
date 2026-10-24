import { afterEach, describe, expect, it } from 'bun:test';
import { SessionManager, type TransportResumeClock } from '../../src/services/worker/SessionManager.js';
import { withRetry } from '../../src/services/worker/retry.js';
import {
  ClassifiedProviderError,
  PAID_SEND_BUDGET_EXHAUSTED_CODE,
  isClassified,
} from '../../src/services/worker/provider-errors.js';
import { PaidSendBudget, paidSendBudgetForClaimedBatch } from '../../src/services/worker/paid-send-budget.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

/**
 * #4737 Part 2: an ambiguous failure — a self-hosted backend that queues past
 * the idle window, or an abandoned deadline — spends the batch's paid-send
 * budget, and the spent budget parks the batch, "never resent, by any path".
 * The charging is deliberate ("never pay twice": the backend may have billed a
 * send that never answered); the lack of recovery is not. These tests pin both
 * halves: the park, and the operator-consented resend of a parked batch.
 */

function makeSessionManager() {
  const clock: TransportResumeClock = {
    setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  };
  const sessionManager = new SessionManager({} as never, clock);
  const sessionDbId = 4437;
  const session = {
    sessionDbId,
    contentSessionId: 'parked-recovery',
    memorySessionId: 'parked-recovery',
    project: 'test',
    platformSource: 'claude',
    userPrompt: '',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  } as unknown as ActiveSession;
  (sessionManager as unknown as { sessions: Map<number, ActiveSession> }).sessions.set(sessionDbId, session);
  const messageId = sessionManager.getMessageBuffer().enqueue(sessionDbId, {
    type: 'observation', tool_name: 'Read', tool_input: '{}', tool_response: 'content', prompt_number: 1,
  });
  return { sessionManager, session, sessionDbId, messageId };
}

/** One send that fails ambiguous (transient), like an idle-timeout against a queued backend. */
async function spendBudgetOnAmbiguousSend(budget: PaidSendBudget): Promise<unknown> {
  const idleTimeout = new ClassifiedProviderError('Request timed out after 90000ms idle', { kind: 'transient', cause: null });
  return withRetry(async () => {
    throw idleTimeout;
  }, { perAttemptTimeoutMs: 5_000, baseDelayMs: 1, paidSendBudget: budget }).catch((caught: unknown) => caught);
}

function parkSpentBatch(
  sessionManager: SessionManager,
  session: ActiveSession,
  messageId: number,
  budget: PaidSendBudget,
): number[] {
  // What paidSendBudgetForClaimedBatch does at claim time: the batch carries
  // its message ids, and parking parks them together.
  session.claimedMessageIds = [messageId];
  session.paidSendBudget = budget;
  budget.batchMessageIds.add(messageId);
  return sessionManager.parkBatchOnSpentPaidSendBudget(session);
}

afterEach(() => { /* no global mocks used here yet */ });

describe('#4737 Part 2: the ambiguous failure spends the budget and the batch parks', () => {
  it('an ambiguous send is charged; the second send is refused and parkBatchOnSpentPaidSendBudget parks the batch', async () => {
    const { sessionManager, session, sessionDbId, messageId } = makeSessionManager();
    const budget = new PaidSendBudget(messageId, 1);

    const error = await spendBudgetOnAmbiguousSend(budget);
    expect(error).toBeInstanceOf(ClassifiedProviderError);
    expect(budget.spentPaidSends).toBe(1);

    // The next send of this batch is refused outright, before any request.
    let sent = false;
    const refusal = await withRetry(async () => {
      sent = true;
      return 'ok';
    }, { perAttemptTimeoutMs: 5_000, paidSendBudget: budget }).catch((caught: unknown) => caught);
    expect(sent).toBe(false);
    expect(isClassified(refusal) && refusal.code).toBe(PAID_SEND_BUDGET_EXHAUSTED_CODE);

    // And the session parks the batch instead of ever resending it.
    const parked = parkSpentBatch(sessionManager, session, messageId, budget);
    expect(parked).toEqual([messageId]);
    expect(sessionManager.getMessageBuffer().getParkedMessages(sessionDbId)).toHaveLength(1);
    expect(sessionManager.getMessageBuffer().getPendingCount(sessionDbId)).toBe(0);
  });
});

describe('#4737 Part 2: an operator resend recovers a parked batch with a fresh budget', () => {
  it('resendParkedBatch unparks the batch, starts a generator, and the re-claimed head gets a fresh budget', async () => {
    const { sessionManager, session, sessionDbId, messageId } = makeSessionManager();
    const budget = new PaidSendBudget(messageId, 1);
    await spendBudgetOnAmbiguousSend(budget);
    expect(parkSpentBatch(sessionManager, session, messageId, budget)).toEqual([messageId]);

    const started: Array<[number, string]> = [];
    sessionManager.setGeneratorStarter((id, source) => { started.push([id, source]); });

    const unparked = sessionManager.resendParkedBatch(sessionDbId);
    expect(unparked).toEqual([messageId]);
    expect(sessionManager.getMessageBuffer().getParkedMessages(sessionDbId)).toHaveLength(0);
    expect(sessionManager.getMessageBuffer().getPendingCount(sessionDbId)).toBe(1);
    expect(started).toEqual([[sessionDbId, 'resend-parked']]);

    // Parking cleared the spent budget, so the re-claimed head gets a fresh one:
    // the operator, not the retry loop, accepted the risk of a second bill.
    session.claimedMessageIds = [messageId];
    const freshBudget = paidSendBudgetForClaimedBatch(session)!;
    expect(freshBudget).not.toBe(budget);
    expect(freshBudget.spentPaidSends).toBe(0);

    // And the batch actually goes out again.
    const result = await withRetry(async () => 'resent-ok', { perAttemptTimeoutMs: 5_000, paidSendBudget: freshBudget });
    expect(result).toBe('resent-ok');
  });

  it('resendParkedBatch is a no-op with nothing parked, and for an unknown or dying session', () => {
    const { sessionManager, session, sessionDbId, messageId } = makeSessionManager();
    const budget = new PaidSendBudget(messageId, 1);
    // Budget spent but nothing parked yet: nothing to recover.
    session.paidSendBudget = budget;
    expect(sessionManager.resendParkedBatch(sessionDbId)).toEqual([]);

    const started: Array<[number, string]> = [];
    sessionManager.setGeneratorStarter((id, source) => { started.push([id, source]); });
    expect(sessionManager.resendParkedBatch(999999)).toEqual([]);
    expect(started).toEqual([]);
  });
});
