import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import { SessionManager, type TransportResumeClock } from '../../../../src/services/worker/SessionManager.js';
import { PaidSendBudget } from '../../../../src/services/worker/paid-send-budget.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';
import { getProcessRegistry, waitForSlot } from '../../../../src/supervisor/process-registry.js';
import { guardSharedProcessRegistrySingleton } from '../../../supervisor/process-registry-singleton-guard.js';

/**
 * #2756/(c) — GET /api/processing-status must additively expose
 * `parkedSessions` (sessions currently parked in waitForSlot) without
 * breaking the existing isProcessing/queueDepth shape. Drives the real
 * process-registry singleton (see the twin comment in
 * tests/supervisor/process-registry.test.ts for why mock.module is avoided
 * here) with a fake 'sdk' occupant + a real parked waiter, cleaned up in a
 * `finally`, plus the guard below for cross-file isolation against
 * tests/supervisor/process-registry.test.ts,
 * tests/worker/http/routes/session-routes-provider-switch.test.ts, and
 * tests/supervisor/wait-for-slot.test.ts, which all share this same
 * singleton in the same `bun test` process.
 */

let loggerSpies: ReturnType<typeof spyOn>[] = [];

const clock: TransportResumeClock = {
  setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: () => {},
};

/**
 * BaseRouteHandler.wrapHandler returns a fire-and-forget `(req, res): void`
 * function — it does NOT await or return the inner async handler's promise.
 * So awaiting the wrapped handler's call resolves after only one microtask,
 * before the inner handler's own awaits (isAnySessionProcessing/
 * getTotalActiveWork) have run. `waitForJson()` instead resolves only once
 * `res.json(...)` is actually invoked, however many microtasks that takes.
 */
function createMockReqRes(): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  waitForJson: () => Promise<unknown>;
} {
  let resolveJson!: (body: unknown) => void;
  const jsonCalled = new Promise<unknown>(resolve => { resolveJson = resolve; });
  const jsonSpy = mock((body: unknown) => { resolveJson(body); });
  return {
    req: { path: '/api/processing-status', query: {} } as Partial<Request>,
    res: { json: jsonSpy } as unknown as Partial<Response>,
    jsonSpy,
    waitForJson: () => jsonCalled,
  };
}

// Registered at true file top level, OUTSIDE the describe below (and
// outside its own beforeEach/afterEach nested just inside it): bun runs
// afterEach hooks inner-scope-first, outer-scope-last (LIFO) regardless of
// source order, so this outer-scope guard is guaranteed to run its "after"
// check only once anything nested one level in has already finished. (This
// file's own sdk-registry cleanup is actually inline in a try/finally
// inside the second test itself, not a hook, so it already completes before
// any afterEach runs at all — the nesting below is defense-in-depth should
// a future test here add registry cleanup via afterEach instead.)
guardSharedProcessRegistrySingleton('data-routes-processing-status.test.ts');

describe('DataRoutes GET /api/processing-status — parkedSessions (#2756)', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  it('reports parkedSessions: 0 alongside the existing fields when nothing is parked', async () => {
    const mockSessionManager = {
      isAnySessionProcessing: mock(() => Promise.resolve(false)),
      getTotalActiveWork: mock(() => Promise.resolve(0)),
      getMessageBuffer: mock(() => ({ getParkedBatchSummaries: mock(() => []) })),
    };

    const routes = new DataRoutes(
      {} as any,
      {} as any,
      mockSessionManager as any,
      {} as any,
      {} as any,
      Date.now(),
    );

    const { req, res, waitForJson } = createMockReqRes();
    (routes as any).handleGetProcessingStatus(req as Request, res as Response);

    expect(await waitForJson()).toEqual({ isProcessing: false, queueDepth: 0, parkedSessions: 0, parkedBatches: [] });
  });

  it('reports a positive parkedSessions count while a session is parked in waitForSlot, without touching isProcessing/queueDepth', async () => {
    const registry = getProcessRegistry();
    const occupantId = `sdk:processing-status-test:${Math.random().toString(36).slice(2)}`;
    registry.register(occupantId, {
      pid: process.pid,
      type: 'sdk',
      sessionId: 'processing-status-occupant',
      startedAt: new Date().toISOString(),
    });

    const parkedPromise = waitForSlot(1, undefined, 'processing-status-parked-session');

    try {
      const mockSessionManager = {
        isAnySessionProcessing: mock(() => Promise.resolve(true)),
        getTotalActiveWork: mock(() => Promise.resolve(5)),
        getMessageBuffer: mock(() => ({ getParkedBatchSummaries: mock(() => []) })),
      };

      const routes = new DataRoutes(
        {} as any,
        {} as any,
        mockSessionManager as any,
        {} as any,
        {} as any,
        Date.now(),
      );

      const { req, res, waitForJson } = createMockReqRes();
      (routes as any).handleGetProcessingStatus(req as Request, res as Response);

      expect(await waitForJson()).toEqual({ isProcessing: true, queueDepth: 5, parkedSessions: 1, parkedBatches: [] });
    } finally {
      // Free the slot so parkedPromise settles, then clean up the occupant —
      // never leak a parked waiter or a fake 'sdk' entry into later test files.
      registry.unregister(occupantId);
      // waitForSlot now returns a SlotReservation (#3287, upstream since this
      // fork's base) rather than resolving void — release it explicitly and
      // promptly rather than relying solely on the guard below to catch a
      // leak after the fact: the guard now also asserts reservedSlots back
      // to zero (getReservedSlotCount()), so a forgotten release here would
      // fail loudly in THIS file's own afterEach, but an unreleased
      // reservation would still wrongly count toward getActiveSdkCount()
      // for any test that ran in between.
      const reservation = await parkedPromise;
      reservation.release();
    }
  });

  it('lists sessions holding parked batches so an operator can pick a sessionDbId for resend-parked (#4737)', async () => {
    // Real buffer + real park path (same fixture shape as
    // tests/worker/http/routes/session-routes-resend-parked.test.ts), so the
    // summary reflects what a parked batch actually looks like.
    const sessionManager = new SessionManager({} as never, clock);
    const sessionDbId = 4769;
    const session = {
      sessionDbId,
      contentSessionId: 'processing-status-parked-batch',
      memorySessionId: 'processing-status-parked-batch',
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
    const buffer = sessionManager.getMessageBuffer();
    const messageId = buffer.enqueue(sessionDbId, {
      type: 'observation', tool_name: 'Read', tool_input: '{}', tool_response: 'content', prompt_number: 1,
    });
    const budget = new PaidSendBudget(messageId, 1);
    budget.recordPaidSend(); // spent: an ambiguous failure charged the one send
    session.claimedMessageIds = [messageId];
    session.paidSendBudget = budget;
    budget.batchMessageIds.add(messageId);
    expect(sessionManager.parkBatchOnSpentPaidSendBudget(session)).toEqual([messageId]);

    const mockSessionManager = {
      isAnySessionProcessing: mock(() => Promise.resolve(false)),
      getTotalActiveWork: mock(() => Promise.resolve(0)),
      getMessageBuffer: mock(() => buffer),
    };

    const routes = new DataRoutes(
      {} as any,
      {} as any,
      mockSessionManager as any,
      {} as any,
      {} as any,
      Date.now(),
    );

    const { req, res, waitForJson } = createMockReqRes();
    (routes as any).handleGetProcessingStatus(req as Request, res as Response);

    expect(await waitForJson()).toEqual({
      isProcessing: false,
      queueDepth: 0,
      parkedSessions: 0,
      parkedBatches: [{ sessionDbId, parkedMessageIds: [messageId], clientAttemptIds: [budget.clientAttemptId] }],
    });
  });
});
