import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import * as processRegistry from '../../../../src/supervisor/process-registry.js';
import * as observerHealth from '../../../../src/shared/observer-health.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
// The observer health ledger lives under DATA_DIR, which is fixed when
// src/shared/paths.ts loads, so an env redirect can't isolate it and other
// test files leave a lastSuccessAt behind. Stub the read instead (#5374).
let readHealthSpy: ReturnType<typeof spyOn>;
let parkedCountSpy: ReturnType<typeof spyOn>;

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
    parkedCountSpy = spyOn(processRegistry, 'getParkedSlotWaiterCount').mockReturnValue(0);
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    readHealthSpy.mockRestore();
    parkedCountSpy.mockRestore();
  });

  it.each([
    { label: 'idle', lastSuccessAt: null, isProcessing: false, queueDepth: 0, abandoned: [], parked: 0 },
    { label: 'successful store', lastSuccessAt: 1_793_895_791_087, isProcessing: false, queueDepth: 0, abandoned: [], parked: 0 },
    { label: 'abandoned sessions', lastSuccessAt: null, isProcessing: true, queueDepth: 666, abandoned: [{ sessionDbId: 7, pendingCount: 666 }], parked: 0 },
    { label: 'parked session', lastSuccessAt: null, isProcessing: true, queueDepth: 5, abandoned: [], parked: 1 },
  ])('reports $label alongside the processing fields', async ({ lastSuccessAt, isProcessing, queueDepth, abandoned, parked }) => {
    if (lastSuccessAt !== null) {
      readHealthSpy.mockReturnValue({
        consecutiveFailures: 0,
        failingSinceAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        lastErrorProvider: null,
        lastSuccessAt,
        quotaCooldown: null,
      });
    }
    parkedCountSpy.mockReturnValue(parked);
    const mockSessionManager = {
      isAnySessionProcessing: mock(() => Promise.resolve(isProcessing)),
      getTotalActiveWork: mock(() => Promise.resolve(queueDepth)),
      getAbandonedStallSessions: mock(() => abandoned),
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
      isProcessing, queueDepth, parkedSessions: parked, lastSuccessfulStoreAt: lastSuccessAt, abandonedStallSessions: abandoned,
    });
  });
});
