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
    const storeObservation = mock(() => ({ id: 77, createdAtEpoch: Date.now() }));
    const markObservationStale = mock(() => {});
    const mockDbManager = {
      getSessionStore: () => ({
        getObservationById: () => ({ id: 5, project: 'test-project' }),
        getOrCreateManualSession: () => 'manual-test-project',
        storeObservation,
        markObservationStale,
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

    expect(storeObservation).toHaveBeenCalled();
    expect(markObservationStale).toHaveBeenCalledWith(5, 77);
    expect(statusSpy).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      stale_id: 5,
      correction_id: 77,
    }));
  });
});
