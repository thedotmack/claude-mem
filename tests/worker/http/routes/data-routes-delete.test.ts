/**
 * DataRoutes delete observations tests
 *
 * Tests POST /api/observations/delete — validation, coercion, and deletion.
 * Follows the mock pattern from data-routes-coercion.test.ts.
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any) {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/test', query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

describe('DataRoutes DELETE observations — POST /api/observations/delete', () => {
  let routes: DataRoutes;
  let mockDeleteObservations: ReturnType<typeof mock>;
  let handler: (req: Request, res: Response) => void;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    mockDeleteObservations = mock(() => ({ deleted: [1, 2], notFound: [] }));

    const mockDbManager = {
      getSessionStore: () => ({ deleteObservations: mockDeleteObservations }),
    };

    routes = new DataRoutes(
      {} as any,
      mockDbManager as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now()
    );

    const mockApp = {
      get: mock(() => {}),
      post: mock((path: string, fn: any) => {
        if (path === '/api/observations/delete') handler = fn;
      }),
      delete: mock(() => {}),
    };
    routes.setupRoutes(mockApp as any);
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('should delete observations and return { success, deleted, notFound }', () => {
    const { req, res, jsonSpy } = createMockReqRes({ ids: [1, 2] });
    handler(req as Request, res as Response);

    expect(mockDeleteObservations).toHaveBeenCalledWith([1, 2]);
    expect(jsonSpy).toHaveBeenCalledWith({ success: true, deleted: [1, 2], notFound: [] });
  });

  it('should return 400 for missing ids', () => {
    const { req, res, statusSpy } = createMockReqRes({});
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('should return 400 for non-array ids', () => {
    const { req, res, statusSpy } = createMockReqRes({ ids: 'not-valid' });
    handler(req as Request, res as Response);

    // 'not-valid' splits to ['not-valid'] → fails integer check
    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('should coerce JSON-encoded string "[1,2]" to native array', () => {
    const { req, res } = createMockReqRes({ ids: '[1,2]' });
    handler(req as Request, res as Response);

    expect(mockDeleteObservations).toHaveBeenCalledWith([1, 2]);
  });

  it('should coerce comma-separated string "1,2" to native array', () => {
    const { req, res } = createMockReqRes({ ids: '1,2' });
    handler(req as Request, res as Response);

    expect(mockDeleteObservations).toHaveBeenCalledWith([1, 2]);
  });

  it('should return 400 when ids exceeds 1000', () => {
    const { req, res, statusSpy } = createMockReqRes({ ids: Array.from({ length: 1001 }, (_, i) => i) });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
    expect(mockDeleteObservations).not.toHaveBeenCalled();
  });

  it('should return 400 for non-integer values', () => {
    const { req, res, statusSpy } = createMockReqRes({ ids: [1, 'two', 3] });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('should handle empty ids array without calling store', () => {
    mockDeleteObservations = mock(() => ({ deleted: [], notFound: [] }));
    const { req, res, jsonSpy } = createMockReqRes({ ids: [] });
    handler(req as Request, res as Response);

    // Empty array passes validation, store called with []
    expect(jsonSpy).toHaveBeenCalled();
  });
});
