import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';

function createMockReqRes(body: any): { req: Partial<Request>; res: Partial<Response>; jsonSpy: ReturnType<typeof mock>; statusSpy: ReturnType<typeof mock> } {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/test' } as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

describe('MemoryRoutes', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

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
    mock.restore();
  });

  it('saves manual memory when Chroma is disabled', () => {
    const storeObservation = mock(() => ({ id: 42, createdAtEpoch: Date.now() }));
    const mockDbManager = {
      getSessionStore: () => ({
        getOrCreateManualSession: () => 'manual-test-project',
        storeObservation,
      }),
      getChromaSync: () => null,
    };

    const routes = new MemoryRoutes(mockDbManager as any, 'test-project');
    let handler: (req: Request, res: Response) => void = () => {};
    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/memory/save') handler = fn;
      }),
    };
    routes.setupRoutes(mockApp as any);

    const { req, res, jsonSpy, statusSpy } = createMockReqRes({ text: 'Remember this' });
    handler(req as Request, res as Response);

    expect(storeObservation).toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      id: 42,
      project: 'test-project',
    }));
  });

  it('records contradictions when Chroma is disabled', () => {
    const contradictObservation = mock(() => ({ id: 77, createdAtEpoch: Date.now() }));
    const mockDbManager = {
      getSessionStore: () => ({
        getObservationById: () => ({ id: 5, project: 'test-project' }),
        getOrCreateManualSession: () => 'manual-test-project',
        contradictObservation,
      }),
      getChromaSync: () => null,
    };

    const routes = new MemoryRoutes(mockDbManager as any, 'test-project');
    let handler: (req: Request, res: Response) => void = () => {};
    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/memory/contradict') handler = fn;
      }),
    };
    routes.setupRoutes(mockApp as any);

    const { req, res, jsonSpy, statusSpy } = createMockReqRes({
      stale_id: 5,
      correction: 'The old memory is outdated',
    });
    handler(req as Request, res as Response);

    expect(contradictObservation).toHaveBeenCalledWith(
      5,
      'manual-test-project',
      'test-project',
      expect.objectContaining({
        narrative: 'The old memory is outdated',
        subtitle: 'Correction',
      }),
      0,
      0
    );
    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      stale_id: 5,
      correction_id: 77,
    }));
  });

  it('returns 404 when contradiction target does not exist', () => {
    const mockDbManager = {
      getSessionStore: () => ({
        getObservationById: () => null,
      }),
      getChromaSync: () => null,
    };

    const routes = new MemoryRoutes(mockDbManager as any, 'test-project');
    let handler: (req: Request, res: Response) => void = () => {};
    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/memory/contradict') handler = fn;
      }),
    };
    routes.setupRoutes(mockApp as any);

    const { req, res, statusSpy, jsonSpy } = createMockReqRes({
      stale_id: 5,
      correction: 'New fact',
    });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(404);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: 'Observation not found',
    }));
  });

  it('rounds and persists clamped importance values', () => {
    const setObservationImportance = mock(() => {});
    const mockDbManager = {
      getSessionStore: () => ({
        getObservationById: () => ({ id: 5, project: 'test-project' }),
        setObservationImportance,
      }),
    };

    const routes = new MemoryRoutes(mockDbManager as any, 'test-project');
    let handler: (req: Request, res: Response) => void = () => {};
    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/memory/importance') handler = fn;
      }),
    };
    routes.setupRoutes(mockApp as any);

    const { req, res, jsonSpy, statusSpy } = createMockReqRes({ id: 5, importance: 7.6 });
    handler(req as Request, res as Response);

    expect(setObservationImportance).toHaveBeenCalledWith(5, 8);
    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      id: 5,
      importance: 8,
    }));
  });

  it('rejects non-finite importance values', () => {
    const mockDbManager = {
      getSessionStore: () => ({
        getObservationById: () => ({ id: 5, project: 'test-project' }),
      }),
    };

    const routes = new MemoryRoutes(mockDbManager as any, 'test-project');
    let handler: (req: Request, res: Response) => void = () => {};
    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/memory/importance') handler = fn;
      }),
    };
    routes.setupRoutes(mockApp as any);

    const { req, res, statusSpy } = createMockReqRes({ id: 5, importance: Number.NaN });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(400);
  });

  it('returns 404 when setting importance on a missing observation', () => {
    const mockDbManager = {
      getSessionStore: () => ({
        getObservationById: () => null,
      }),
    };

    const routes = new MemoryRoutes(mockDbManager as any, 'test-project');
    let handler: (req: Request, res: Response) => void = () => {};
    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/memory/importance') handler = fn;
      }),
    };
    routes.setupRoutes(mockApp as any);

    const { req, res, statusSpy, jsonSpy } = createMockReqRes({ id: 5, importance: 6 });
    handler(req as Request, res as Response);

    expect(statusSpy).toHaveBeenCalledWith(404);
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: 'Observation not found',
    }));
  });

  it('returns drift-check output in MCP content format', () => {
    const detectDrift = mock(() => ({
      driftedConcepts: [
        {
          signal: 'high-stale',
          project: 'test-project',
          concept: 'auth',
          stalePct: 75,
          totalCount: 4,
          recentCount: 1,
          oldCount: 3,
          unaccessedOld: 2,
        },
      ],
      summary: '1 drifted concept cluster detected.',
    }));
    const mockDbManager = {
      getSessionSearch: () => ({ detectDrift }),
    };

    const routes = new MemoryRoutes(mockDbManager as any, 'test-project');
    let handler: (req: Request, res: Response) => void = () => {};
    const mockApp = {
      post: mock((path: string, fn: any) => {
        if (path === '/api/memory/drift-check') handler = fn;
      }),
    };
    routes.setupRoutes(mockApp as any);

    const { req, res, jsonSpy, statusSpy } = createMockReqRes({ project: 'test-project' });
    handler(req as Request, res as Response);

    expect(detectDrift).toHaveBeenCalledWith('test-project');
    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('| high-stale | test-project | auth | 75% | 4 | 1 | 3 | 2 |'),
        },
      ],
    });
  });
});
