
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any): { req: Partial<Request>; res: Partial<Response>; jsonSpy: ReturnType<typeof mock>; statusSpy: ReturnType<typeof mock> } {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/test', query: {} } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureChain(mockApp: any, targetPath: string): (req: Request, res: Response) => void {
  let middleware: (req: Request, res: Response, next: () => void) => void;
  let handler: (req: Request, res: Response) => void;
  mockApp.post = mock((path: string, ...rest: any[]) => {
    if (path !== targetPath) return;
    if (rest.length === 1) {
      handler = rest[0];
    } else {
      middleware = rest[0];
      handler = rest[1];
    }
  });
  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) handler(req, res);
  };
}

describe('DataRoutes Type Coercion', () => {
  let routes: DataRoutes;
  let mockGetObservationsByIds: ReturnType<typeof mock>;
  let mockGetSdkSessionsBySessionIds: ReturnType<typeof mock>;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    mockGetObservationsByIds = mock(() => [{ id: 1 }, { id: 2 }]);
    mockGetSdkSessionsBySessionIds = mock(() => [{ id: 'abc' }]);

    const mockDbManager = {
      getSessionStore: () => ({
        getObservationsByIds: mockGetObservationsByIds,
        getSdkSessionsBySessionIds: mockGetSdkSessionsBySessionIds,
      }),
    };

    routes = new DataRoutes(
      {} as any, // paginationHelper
      mockDbManager as any,
      {} as any, // sessionManager
      {} as any, // sseBroadcaster
      {} as any, // workerService
      Date.now()
    );
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  describe('handleGetObservationsByIds — ids coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      handler = captureChain(mockApp, '/api/observations/batch');
      routes.setupRoutes(mockApp as any);
    });

    it.each([
      [[1, 2, 3], [1, 2, 3]],
      ['[1,2,3]', [1, 2, 3]],
      ['1,2,3', [1, 2, 3]],
      [['1', ' 2 ', 3], [1, 2, 3]],
      ['["1","2"]', [1, 2]],
    ])('coerces ids %j', (ids, expectedIds) => {
      const { req, res, jsonSpy } = createMockReqRes({ ids });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith(expectedIds, expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject non-numeric string elements of a native array', () => {
      const { req, res, statusSpy } = createMockReqRes({ ids: ['observation:abc', ''] });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(mockGetObservationsByIds).not.toHaveBeenCalled();
    });

    for (const invalidElement of [true, null, '1.5', '1e2', ' ']) {
      it(`should reject ${JSON.stringify(invalidElement)} as an array element`, () => {
        const { req, res, statusSpy } = createMockReqRes({ ids: [invalidElement] });
        handler(req as Request, res as Response);

        expect(statusSpy).toHaveBeenCalledWith(400);
        expect(mockGetObservationsByIds).not.toHaveBeenCalled();
      });
    }

    it('should reject non-integer values after coercion', () => {
      const { req, res, statusSpy } = createMockReqRes({ ids: 'foo,bar' });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should reject missing ids', () => {
      const { req, res, statusSpy } = createMockReqRes({});
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });

    it('should return empty array for empty ids array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [] });
      handler(req as Request, res as Response);

      expect(jsonSpy).toHaveBeenCalledWith([]);
    });

    // Every id comes back as a full row (narrative, facts, concepts, file
    // lists), so an unbounded array is a way to page the whole table in one
    // request. 100 is the ceiling the adapters already advertise.
    it('should reject more than 100 ids', () => {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1);
      const { req, res, statusSpy } = createMockReqRes({ ids });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(mockGetObservationsByIds).not.toHaveBeenCalled();
    });

    it('should accept exactly 100 ids', () => {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);
      const { req, res, jsonSpy } = createMockReqRes({ ids });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith(ids, expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });
  });

  describe('handleGetSdkSessionsByIds — memorySessionIds coercion', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      handler = captureChain(mockApp, '/api/sdk-sessions/batch');
      routes.setupRoutes(mockApp as any);
    });

    it.each([
      [['abc', 'def'], ['abc', 'def']],
      ['["abc","def"]', ['abc', 'def']],
      ['abc,def', ['abc', 'def']],
      ['abc, def , ghi', ['abc', 'def', 'ghi']],
    ])('coerces memorySessionIds %j', (memorySessionIds, expectedIds) => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(expectedIds);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject non-array, non-string values', () => {
      const { req, res, statusSpy } = createMockReqRes({ memorySessionIds: 42 });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });
  });
});
