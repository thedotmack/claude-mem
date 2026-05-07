
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
  let mockImportSdkSession: ReturnType<typeof mock>;
  let mockImportSessionSummary: ReturnType<typeof mock>;
  let mockImportObservation: ReturnType<typeof mock>;
  let mockImportUserPrompt: ReturnType<typeof mock>;

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
    mockImportSdkSession = mock(() => ({ imported: true, id: 1 }));
    mockImportSessionSummary = mock(() => ({ imported: true, id: 2 }));
    mockImportObservation = mock(() => ({ imported: true, id: 3 }));
    mockImportUserPrompt = mock(() => ({ imported: true, id: 4 }));

    const mockDbManager = {
      getSessionStore: () => ({
        getObservationsByIds: mockGetObservationsByIds,
        getSdkSessionsBySessionIds: mockGetSdkSessionsBySessionIds,
        importSdkSession: mockImportSdkSession,
        importSessionSummary: mockImportSessionSummary,
        importObservation: mockImportObservation,
        importUserPrompt: mockImportUserPrompt,
        rebuildObservationsFTSIndex: mock(() => {}),
      }),
      getChromaSync: () => undefined,
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

    it('should accept a native array of numbers', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [1, 2, 3] });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a JSON-encoded string array "[1,2,3]" to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: '[1,2,3]' });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a comma-separated string "1,2,3" to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: '1,2,3' });
      handler(req as Request, res as Response);

      expect(mockGetObservationsByIds).toHaveBeenCalledWith([1, 2, 3], expect.anything());
      expect(jsonSpy).toHaveBeenCalled();
    });

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

    it('should accept a native array of strings', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: ['abc', 'def'] });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a JSON-encoded string array to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: '["abc","def"]' });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should coerce a comma-separated string to native array', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: 'abc,def' });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should trim whitespace from comma-separated values', () => {
      const { req, res, jsonSpy } = createMockReqRes({ memorySessionIds: 'abc, def , ghi' });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def', 'ghi']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should accept legacy sdkSessionIds as a compatibility alias', () => {
      const { req, res, jsonSpy } = createMockReqRes({ sdkSessionIds: ['abc', 'def'] });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['abc', 'def']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should prefer canonical memorySessionIds when both fields are provided', () => {
      const { req, res, jsonSpy } = createMockReqRes({
        memorySessionIds: ['canonical'],
        sdkSessionIds: ['legacy'],
      });
      handler(req as Request, res as Response);

      expect(mockGetSdkSessionsBySessionIds).toHaveBeenCalledWith(['canonical']);
      expect(jsonSpy).toHaveBeenCalled();
    });

    it('should reject non-array, non-string values', () => {
      const { req, res, statusSpy } = createMockReqRes({ memorySessionIds: 42 });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
    });
  });

  describe('handleImport — partial export rejection', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = {
        get: mock(() => {}),
        delete: mock(() => {}),
        use: mock(() => {}),
      };
      handler = captureChain(mockApp, '/api/import');
      routes.setupRoutes(mockApp as any);
    });

    it('rejects partial export payloads before any import writes', () => {
      const { req, res, statusSpy, jsonSpy } = createMockReqRes({
        metadata: {
          partial: true,
          importable: false,
          warnings: [{ code: 'SDK_SESSIONS_METADATA_UNAVAILABLE', message: 'missing sessions' }],
        },
        sessions: [],
        summaries: [{ memory_session_id: 'memory-a' }],
        observations: [{ memory_session_id: 'memory-a' }],
        prompts: [],
      });
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(jsonSpy).toHaveBeenCalledWith({
        error: 'Partial exports are not importable because SDK session metadata is missing. Re-run export without --allow-partial before importing.',
      });
      expect(mockImportSdkSession).not.toHaveBeenCalled();
      expect(mockImportSessionSummary).not.toHaveBeenCalled();
      expect(mockImportObservation).not.toHaveBeenCalled();
      expect(mockImportUserPrompt).not.toHaveBeenCalled();
    });
  });
});
