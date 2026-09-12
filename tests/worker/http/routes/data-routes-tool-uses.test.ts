import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

// Same module-snapshot dance as data-routes-coercion.test.ts: bun's
// mock.module is process-global and mock.restore() does not undo it.
import * as realPaths from '../../../../src/shared/paths.js';
import * as realWorkerUtils from '../../../../src/shared/worker-utils.js';
const realPathsSnapshot = { ...realPaths };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

afterAll(() => {
  mock.module('../../../../src/shared/paths.js', () => realPathsSnapshot);
  mock.module('../../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any, query: any = {}) {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, path: '/test', query, headers: {} } as unknown as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

function captureChain(mockApp: any, method: 'get' | 'post', targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: (req: Request, res: Response) => void;
  mockApp[method] = mock((path: string, ...rest: any[]) => {
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

const SAMPLE_ROW = {
  id: 7,
  tool_use_id: 'toolu_01',
  content_session_id: 'session-a',
  memory_session_id: 'memory-a',
  session_db_id: 1,
  project: 'claude-mem',
  platform_source: 'claude',
  tool_name: 'Read',
  tool_input: '{"file_path":"/tmp/a.ts"}',
  tool_response: '{"ok":true}',
  cwd: '/workspace/claude-mem',
  prompt_number: 2,
  agent_type: null,
  agent_id: null,
  observation_id: 99,
  or_generation_id: 'gen-abc',
  or_session_id: 'job:session-a',
  content_hash: 'deadbeefdeadbeef',
  created_at: '2026-09-07T00:00:00.000Z',
  created_at_epoch: 1757203200000,
};

describe('DataRoutes tool_uses (progressive disclosure layer 4)', () => {
  let routes: DataRoutes;
  let mockGetToolUsesByIds: ReturnType<typeof mock>;
  let mockQueryToolUses: ReturnType<typeof mock>;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    mockGetToolUsesByIds = mock(() => [SAMPLE_ROW]);
    mockQueryToolUses = mock(() => [SAMPLE_ROW]);

    const mockDbManager = {
      getSessionStore: () => ({
        getToolUsesByIds: mockGetToolUsesByIds,
        queryToolUses: mockQueryToolUses,
      }),
    };

    routes = new DataRoutes(
      {} as any,
      mockDbManager as any,
      {} as any,
      {} as any,
      {} as any,
      Date.now()
    );
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  describe('POST /api/tool-uses/batch', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = { get: mock(() => {}), delete: mock(() => {}), use: mock(() => {}) };
      handler = captureChain(mockApp, 'post', '/api/tool-uses/batch');
      routes.setupRoutes(mockApp as any);
    });

    it('accepts numeric ids', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [7, 8] });
      handler(req as Request, res as Response);

      expect(mockGetToolUsesByIds).toHaveBeenCalledWith([7, 8], expect.anything());
      expect(jsonSpy).toHaveBeenCalledWith([SAMPLE_ROW]);
    });

    it('accepts opaque tool_use_id strings', () => {
      const { req, res } = createMockReqRes({ ids: ['toolu_01', 'toolu_02'] });
      handler(req as Request, res as Response);

      expect(mockGetToolUsesByIds).toHaveBeenCalledWith(['toolu_01', 'toolu_02'], expect.anything());
    });

    it('coerces a comma-separated string', () => {
      const { req, res } = createMockReqRes({ ids: 'toolu_01,toolu_02' });
      handler(req as Request, res as Response);

      expect(mockGetToolUsesByIds).toHaveBeenCalledWith(['toolu_01', 'toolu_02'], expect.anything());
    });

    it('rejects a request with no ids — this route is never a full-table scan', () => {
      const { req, res, statusSpy } = createMockReqRes({});
      handler(req as Request, res as Response);

      expect(statusSpy).toHaveBeenCalledWith(400);
      expect(mockGetToolUsesByIds).not.toHaveBeenCalled();
    });

    it('returns [] for an empty ids array without touching the store', () => {
      const { req, res, jsonSpy } = createMockReqRes({ ids: [] });
      handler(req as Request, res as Response);

      expect(jsonSpy).toHaveBeenCalledWith([]);
      expect(mockGetToolUsesByIds).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/tool-uses', () => {
    let handler: (req: Request, res: Response) => void;

    beforeEach(() => {
      const mockApp: any = { post: mock(() => {}), delete: mock(() => {}), use: mock(() => {}) };
      handler = captureChain(mockApp, 'get', '/api/tool-uses');
      routes.setupRoutes(mockApp as any);
    });

    it('never returns tool_input / tool_response in the index listing', () => {
      const { req, res, jsonSpy } = createMockReqRes(undefined, { project: 'claude-mem' });
      handler(req as Request, res as Response);

      const payload = (jsonSpy.mock.calls[0] as any[])[0];
      expect(payload.count).toBe(1);
      const [row] = payload.toolUses;
      expect(row).not.toHaveProperty('tool_input');
      expect(row).not.toHaveProperty('tool_response');
    });

    it('exposes identity + the Receipt join keys + size hints', () => {
      const { req, res, jsonSpy } = createMockReqRes(undefined, {});
      handler(req as Request, res as Response);

      const [row] = (jsonSpy.mock.calls[0] as any[])[0].toolUses;
      expect(row.tool_use_id).toBe('toolu_01');
      expect(row.tool_name).toBe('Read');
      expect(row.content_session_id).toBe('session-a');
      expect(row.or_generation_id).toBe('gen-abc');
      expect(row.or_session_id).toBe('job:session-a');
      expect(row.observation_id).toBe(99);
      expect(row.tool_input_bytes).toBe(Buffer.byteLength(SAMPLE_ROW.tool_input, 'utf8'));
      expect(row.tool_response_bytes).toBe(Buffer.byteLength(SAMPLE_ROW.tool_response, 'utf8'));
      // Receipt freeze: identity only, never dollars.
      expect(row).not.toHaveProperty('cost_usd');
    });

    it('passes session and tool_name filters through to the store', () => {
      const { req, res } = createMockReqRes(undefined, { session: 'session-a', tool_name: 'Read,Edit' });
      handler(req as Request, res as Response);

      expect(mockQueryToolUses).toHaveBeenCalledWith(expect.objectContaining({
        contentSessionId: 'session-a',
        toolName: ['Read', 'Edit'],
      }));
    });
  });
});
