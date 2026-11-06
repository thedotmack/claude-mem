import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import { getProcessRegistry, waitForSlot } from '../../../../src/supervisor/process-registry.js';
import * as observerHealth from '../../../../src/shared/observer-health.js';
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
// The observer health ledger lives under DATA_DIR, which is fixed when
// src/shared/paths.ts loads, so an env redirect can't isolate it and other
// test files leave a lastSuccessAt behind. Stub the read instead (#5374).
let readHealthSpy: ReturnType<typeof spyOn>;

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
    readHealthSpy = spyOn(observerHealth, 'readObserverHealth').mockReturnValue(null);
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    readHealthSpy.mockRestore();
  });

  it('reports parkedSessions: 0 alongside the existing fields when nothing is parked', async () => {
    const mockSessionManager = {
      isAnySessionProcessing: mock(() => Promise.resolve(false)),
      getTotalActiveWork: mock(() => Promise.resolve(0)),
      getAbandonedStallSessions: mock(() => []),
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
      isProcessing: false, queueDepth: 0, parkedSessions: 0, lastSuccessfulStoreAt: null, abandonedStallSessions: [],
    });
  });

  it("exposes the observer's last successful store time from the health ledger (#5374)", async () => {
    readHealthSpy.mockReturnValue({
      consecutiveFailures: 0,
      failingSinceAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastErrorProvider: null,
      lastSuccessAt: 1_793_895_791_087,
      quotaCooldown: null,
    });
    const mockSessionManager = {
      isAnySessionProcessing: mock(() => Promise.resolve(false)),
      getTotalActiveWork: mock(() => Promise.resolve(0)),
      getAbandonedStallSessions: mock(() => []),
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
      isProcessing: false, queueDepth: 0, parkedSessions: 0, lastSuccessfulStoreAt: 1_793_895_791_087, abandonedStallSessions: [],
    });
  });

  it('lists the sessions the stall pacer abandoned, with the messages they hold (#5405)', async () => {
    const mockSessionManager = {
      isAnySessionProcessing: mock(() => Promise.resolve(true)),
      getTotalActiveWork: mock(() => Promise.resolve(666)),
      getAbandonedStallSessions: mock(() => [{ sessionDbId: 7, pendingCount: 666 }]),
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
      isProcessing: true, queueDepth: 666, parkedSessions: 0, lastSuccessfulStoreAt: null,
      abandonedStallSessions: [{ sessionDbId: 7, pendingCount: 666 }],
    });
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
        getAbandonedStallSessions: mock(() => []),
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

      expect(await waitForJson()).toEqual({ isProcessing: true, queueDepth: 5, parkedSessions: 1, lastSuccessfulStoreAt: null, abandonedStallSessions: [] });
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
});
