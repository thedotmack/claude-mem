
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

const generateContextStub = mock(async () => 'CONTEXT_FROM_GENERATOR');
mock.module('../../../../src/services/context-generator.js', () => ({
  generateContext: generateContextStub,
}));

import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

interface MockRes {
  setHeader: ReturnType<typeof mock>;
  send: ReturnType<typeof mock>;
  status: ReturnType<typeof mock>;
  json: ReturnType<typeof mock>;
  headersSent: boolean;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    setHeader: mock(() => {}),
    send: mock(() => {}),
    status: mock(() => res as any),
    json: mock(() => {}),
    headersSent: false,
  };
  return res;
}

function captureContextInjectHandler(routes: SearchRoutes): (req: Request, res: Response) => void {
  let captured: ((req: Request, res: Response) => void) | undefined;
  const mockApp: any = {
    get: mock((path: string, handler: (req: Request, res: Response) => void) => {
      if (path === '/api/context/inject') {
        captured = handler;
      }
    }),
    post: mock(() => {}),
    delete: mock(() => {}),
    use: mock(() => {}),
  };
  routes.setupRoutes(mockApp);
  if (!captured) throw new Error('Failed to capture /api/context/inject handler');
  return captured;
}

describe('SearchRoutes Welcome Hint', () => {
  let countQueryStub: ReturnType<typeof mock>;
  let prepareStub: ReturnType<typeof mock>;
  let mockSessionStore: any;
  let mockSearchManager: any;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    countQueryStub = mock(() => ({ count: 0 }));
    prepareStub = mock(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub } };
    mockSearchManager = {
      getSessionStore: () => mockSessionStore,
    };

    generateContextStub.mockClear();
    delete process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    delete process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
  });

  it('returns the welcome hint when project has zero observations', async () => {
    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.send).toHaveBeenCalledTimes(1);
    const body = (res.send as any).mock.calls[0][0] as string;
    expect(body).toContain('# claude-mem status');
    expect(body).toContain('/learn-codebase');
    expect(body).toContain('http://localhost:');
    expect(body).toContain('Memory injection starts on your second session in a project.');
    expect(body).toContain('disappears once the first observation lands');
    expect(body).not.toContain('Welcome');
    expect(generateContextStub).not.toHaveBeenCalled();
  });

  it('skips the welcome hint when at least one observation exists', async () => {
    countQueryStub = mock(() => ({ count: 7 }));
    prepareStub = mock(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub } };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/active-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(generateContextStub).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith('CONTEXT_FROM_GENERATOR');
  });

  it('skips the welcome hint when CLAUDE_MEM_WELCOME_HINT_ENABLED=false', async () => {
    process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED = 'false';

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(generateContextStub).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith('CONTEXT_FROM_GENERATOR');
  });

  it('queries both projects in a worktree (multi-project) request', async () => {
    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/parent, /path/worktree' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.send).toHaveBeenCalledTimes(1);
    expect(countQueryStub).toHaveBeenCalledWith(
      '/path/parent',
      '/path/worktree',
      '/path/parent',
      '/path/worktree',
    );
  });
});
