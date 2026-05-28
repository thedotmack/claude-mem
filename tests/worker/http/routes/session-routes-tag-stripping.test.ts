/**
 * SessionRoutes — privacy-tag stripping tests (worker-layer defense-in-depth)
 *
 * Validates that both worker summarize endpoints strip memory tags from
 * last_assistant_message before queuing, and return `skipped/empty_after_strip`
 * when the cleaned message is empty.
 *
 * Routes under test:
 *  - POST /sessions/:sessionDbId/summarize  → handleSummarize
 *  - POST /api/sessions/summarize           → handleSummarizeByClaudeId
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
  USER_SETTINGS_PATH: '/tmp/test/settings.json',
}));

mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

// Prevent GeminiAgent / OpenRouterAgent from reading env
mock.module('../../../../src/services/worker/GeminiAgent.js', () => ({
  GeminiAgent: class {},
  isGeminiSelected: () => false,
  isGeminiAvailable: () => false,
}));

mock.module('../../../../src/services/worker/OpenRouterAgent.js', () => ({
  OpenRouterAgent: class {},
  isOpenRouterSelected: () => false,
  isOpenRouterAvailable: () => false,
}));

// Prevent settings file reads
mock.module('../../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => '',
    getInt: () => 0,
    loadFromFile: () => ({}),
  },
}));

mock.module('../../../../src/supervisor/process-registry.js', () => ({
  getSdkProcessForSession: () => undefined,
  ensureSdkProcessExit: () => Promise.resolve(),
}));

import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function createMockReqRes(body: any, params: Record<string, string> = {}): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, params, path: '/test', query: {} } as unknown as Partial<Request>,
    res: { json: jsonSpy, status: statusSpy, headersSent: false } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

/** Capture the handler registered for a specific POST path. */
function capturePostHandler(
  routes: SessionRoutes,
  targetPath: string
): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;

  const mockApp: any = {
    get: mock(() => {}),
    delete: mock(() => {}),
    use: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path !== targetPath) return;
      if (rest.length === 1) {
        handler = rest[0];
      } else {
        middleware = rest[0];
        handler = rest[1];
      }
    }),
  };

  routes.setupRoutes(mockApp);

  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler!(req, res);
      return;
    }
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    if (nextCalled) handler!(req, res);
  };
}

// ── fixture ──────────────────────────────────────────────────────────────────

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let mockQueueSummarize: ReturnType<typeof mock>;
let routes: SessionRoutes;

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];

  mockQueueSummarize = mock(() => {});

  const mockSessionManager: any = {
    queueSummarize: mockQueueSummarize,
    getSession: () => undefined, // makes ensureGeneratorRunning return early (no spawn)
    getActiveSession: () => undefined,
    createSession: () => ({ sessionDbId: 1 }),
  };

  const mockStore: any = {
    createSDKSession: () => 42,
    getPromptNumberFromUserPrompts: () => 1,
    getUserPrompt: () => 'hello world', // non-empty → privacy check passes
    getLastUserPromptForSession: () => ({ prompt: 'hello' }),
    getSessionByContentSessionId: () => null,
  };

  const mockDbManager: any = {
    getSessionStore: () => mockStore,
  };

  const mockEventBroadcaster: any = {
    broadcastSummarizeQueued: mock(() => {}),
    broadcastSessionEvent: mock(() => {}),
  };

  routes = new SessionRoutes(
    mockSessionManager,
    mockDbManager,
    {} as any, // sdkAgent
    {} as any, // geminiAgent
    {} as any, // openRouterAgent
    mockEventBroadcaster,
    {} as any, // workerService
    {} as any, // completionHandler
  );
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.restore();
});

// ── handleSummarize (/sessions/:sessionDbId/summarize) ───────────────────────

describe('handleSummarize — privacy-tag stripping', () => {
  let invoke: (req: Request, res: Response) => void;

  beforeEach(() => {
    invoke = capturePostHandler(routes, '/sessions/:sessionDbId/summarize');
  });

  it('strips <private> tags before queueing', () => {
    const { req, res, jsonSpy } = createMockReqRes(
      { last_assistant_message: 'Hello <private>SECRET</private> world' },
      { sessionDbId: '1' }
    );
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).toHaveBeenCalledTimes(1);
    const queued = mockQueueSummarize.mock.calls[0][1];
    expect(queued).not.toContain('SECRET');
    expect(queued).not.toContain('<private>');
    expect(queued).toContain('Hello');
    expect(queued).toContain('world');
    expect(jsonSpy).toHaveBeenCalledWith({ status: 'queued' });
  });

  it('returns skipped/empty_after_strip when entire message is wrapped in <private>', () => {
    const { req, res, jsonSpy } = createMockReqRes(
      { last_assistant_message: '<private>everything is private</private>' },
      { sessionDbId: '1' }
    );
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ status: 'skipped', reason: 'empty_after_strip' });
  });

  it('returns skipped/empty_after_strip when stripped result is only whitespace', () => {
    const { req, res, jsonSpy } = createMockReqRes(
      { last_assistant_message: '  <private>x</private>\n<private>y</private>  ' },
      { sessionDbId: '1' }
    );
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ status: 'skipped', reason: 'empty_after_strip' });
  });

  it('passes through content with no privacy tags unchanged', () => {
    const { req, res } = createMockReqRes(
      { last_assistant_message: 'Normal assistant turn.' },
      { sessionDbId: '1' }
    );
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).toHaveBeenCalledTimes(1);
    expect(mockQueueSummarize.mock.calls[0][1]).toBe('Normal assistant turn.');
  });

  it('returns skipped/empty_after_strip when last_assistant_message is absent', () => {
    const { req, res, jsonSpy } = createMockReqRes({}, { sessionDbId: '1' });
    invoke(req as Request, res as Response);

    // undefined message → cleanedLastAssistantMessage is undefined → empty guard fires
    expect(mockQueueSummarize).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ status: 'skipped', reason: 'empty_after_strip' });
  });
});

// ── handleSummarizeByClaudeId (/api/sessions/summarize) ──────────────────────

describe('handleSummarizeByClaudeId — privacy-tag stripping', () => {
  let invoke: (req: Request, res: Response) => void;

  beforeEach(() => {
    invoke = capturePostHandler(routes, '/api/sessions/summarize');
  });

  it('strips <private> tags before queueing', () => {
    const { req, res, jsonSpy } = createMockReqRes({
      contentSessionId: 'sess-abc',
      last_assistant_message: 'Result: <private>TOP-SECRET</private> done.',
    });
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).toHaveBeenCalledTimes(1);
    const queued = mockQueueSummarize.mock.calls[0][1];
    expect(queued).not.toContain('TOP-SECRET');
    expect(queued).toContain('Result:');
    expect(queued).toContain('done.');
    expect(jsonSpy).toHaveBeenCalledWith({ status: 'queued' });
  });

  it('returns skipped/empty_after_strip when entire message is wrapped in <private>', () => {
    const { req, res, jsonSpy } = createMockReqRes({
      contentSessionId: 'sess-abc',
      last_assistant_message: '<private>everything</private>',
    });
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ status: 'skipped', reason: 'empty_after_strip' });
  });

  it('returns skipped/empty_after_strip when stripped result is only whitespace', () => {
    const { req, res, jsonSpy } = createMockReqRes({
      contentSessionId: 'sess-abc',
      last_assistant_message: '\t<private>x</private>\n',
    });
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).not.toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith({ status: 'skipped', reason: 'empty_after_strip' });
  });

  it('passes through content with no privacy tags unchanged', () => {
    const { req, res } = createMockReqRes({
      contentSessionId: 'sess-abc',
      last_assistant_message: 'Clean output.',
    });
    invoke(req as Request, res as Response);

    expect(mockQueueSummarize).toHaveBeenCalledTimes(1);
    expect(mockQueueSummarize.mock.calls[0][1]).toBe('Clean output.');
  });
});
