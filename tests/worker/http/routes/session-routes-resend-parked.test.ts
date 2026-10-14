import { afterAll, describe, expect, it } from 'bun:test';
import express from 'express';
import { AddressInfo } from 'net';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionManager, type TransportResumeClock } from '../../../../src/services/worker/SessionManager.js';
import { PaidSendBudget } from '../../../../src/services/worker/paid-send-budget.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

/**
 * #4737: POST /api/sessions/resend-parked is the operator handle for the one
 * recovery path a parked batch has. The automatic paths never unpark ("never
 * pay twice"), so the route must reach resendParkedBatch and nothing else —
 * localhost-only like the other admin routes, and 404 (not a silent ok) when
 * there is nothing parked to resend.
 */

const clock: TransportResumeClock = {
  setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: () => {},
};

function makeSessionManagerWithParkedBatch(): { sessionManager: SessionManager; sessionDbId: number } {
  const sessionManager = new SessionManager({} as never, clock);
  const sessionDbId = 4438;
  const session = {
    sessionDbId,
    contentSessionId: 'resend-parked-route',
    memorySessionId: 'resend-parked-route',
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
  const budget = new PaidSendBudget(messageId, 1);
  budget.recordPaidSend(); // spent: an ambiguous failure charged the one send
  session.claimedMessageIds = [messageId];
  session.paidSendBudget = budget;
  budget.batchMessageIds.add(messageId);
  expect(sessionManager.parkBatchOnSpentPaidSendBudget(session)).toEqual([messageId]);
  return { sessionManager, sessionDbId };
}

describe('POST /api/sessions/resend-parked', () => {
  const { sessionManager, sessionDbId } = makeSessionManagerWithParkedBatch();
  const routes = new SessionRoutes(
    sessionManager,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  );
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  afterAll(() => { server.close(); });

  it('resends a parked batch and says what was returned to the queue', async () => {
    const reply = await post('/api/sessions/resend-parked', { sessionDbId });
    expect(reply.status).toBe(200);
    const body = await reply.json() as { status: string; sessionDbId: number; unparkedMessageIds: number[] };
    expect(body.status).toBe('ok');
    expect(body.unparkedMessageIds.length).toBe(1);
    expect(sessionManager.getMessageBuffer().getParkedMessages(sessionDbId)).toHaveLength(0);
    expect(sessionManager.getMessageBuffer().getPendingCount(sessionDbId)).toBe(1);
  });

  it('404s when the session has nothing parked', async () => {
    const reply = await post('/api/sessions/resend-parked', { sessionDbId });
    expect(reply.status).toBe(404);
  });

  it('400s on a malformed body', async () => {
    const reply = await post('/api/sessions/resend-parked', { sessionDbId: 'nope' });
    expect(reply.status).toBe(400);
  });
});
