
import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import * as realContextGenerator from '../../../../src/services/context-generator.js';
import * as realPaths from '../../../../src/shared/paths.js';

const realContextGeneratorSnapshot = { ...realContextGenerator };
const realPathsSnapshot = { ...realPaths };

const generateContextStub = mock(async () => ({ text: 'CONTEXT_FROM_GENERATOR', stats: null }));
mock.module('../../../../src/services/context-generator.js', () => ({
  generateContext: mock(async () => 'CONTEXT_FROM_GENERATOR'),
  generateContextWithStats: generateContextStub,
}));
mock.module('../../../../src/shared/paths.js', () => ({
  ...realPathsSnapshot,
  paths: realPaths.paths,
}));

import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import {
  OBSERVER_HEALTH_FILENAME,
  OBSERVER_UNHEALTHY_FAILURE_THRESHOLD,
} from '../../../../src/shared/observer-health.js';
import { resolveConfigDirProfileKey } from '../../../../src/shared/EnvManager.js';
import { getProjectContext } from '../../../../src/utils/project-name.js';
import { buildWorkStateContextSection } from '../../../../src/services/context/sections/WorkStateRenderer.js';

// The route reads the ledger from paths.dataDir() (CLAUDE_MEM_DATA_DIR, set to a
// per-run temp dir by tests/preload.ts), so write it there for the health case.
const observerHealthPath = join(realPaths.paths.dataDir(), OBSERVER_HEALTH_FILENAME);

let loggerSpies: ReturnType<typeof spyOn>[] = [];

// What every response leads with while nothing has been written: the rule, then "Nothing open yet."
const EMPTY_WORK_STATE_SECTION = buildWorkStateContextSection([], 0);
const workStateEntriesStub = mock((): any[] => []);

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
    mockSessionStore = { db: { prepare: prepareStub }, getWorkStateEntries: workStateEntriesStub };
    mockSearchManager = {
      getSessionStore: () => mockSessionStore,
    };

    generateContextStub.mockClear();
    workStateEntriesStub.mockClear();
    workStateEntriesStub.mockImplementation(() => []);
    delete process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    delete process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED;
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    if (existsSync(observerHealthPath)) rmSync(observerHealthPath, { force: true });
  });

  afterAll(() => {
    mock.module('../../../../src/services/context-generator.js', () => realContextGeneratorSnapshot);
    mock.module('../../../../src/shared/paths.js', () => realPathsSnapshot);
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

  it('appends the observer-health warning to the welcome hint when the observer is failing', async () => {
    // A user whose observer has failed since install has zero observations, so
    // the welcome-hint early return is the ONLY context they ever see. The
    // health warning must ride along with it, not wait for generateContext.
    mkdirSync(realPaths.paths.dataDir(), { recursive: true });
    writeFileSync(observerHealthPath, JSON.stringify({
      consecutiveFailures: OBSERVER_UNHEALTHY_FAILURE_THRESHOLD,
      failingSinceAt: 1_754_700_000_000,
      lastErrorAt: 1_754_700_100_000,
      lastErrorMessage: "You've used your $30 monthly allowance.",
      lastErrorProvider: 'cmem-pro',
      lastSuccessAt: null,
      lastErrorCode: 'allowance_exhausted',
      lastErrorAction: 'It resets on the 1st. Upgrade or add credits to keep going now.',
      lastErrorUrl: 'https://cmem.ai/dashboard',
    }));

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.send).toHaveBeenCalledTimes(1);
    const body = (res.send as any).mock.calls[0][0] as string;
    expect(body).toContain("claude-mem can't save memories right now");
    expect(body).toContain('What to do: It resets on the 1st. Upgrade or add credits to keep going now.');
    expect(body).toContain('# claude-mem status');
    expect(body).toContain('disappears once the first observation lands');
    // Hint first, warning second — same order as normal context, so the
    // warning is the last thing on screen rather than the first thing scrolled off.
    expect(body.indexOf('# claude-mem status')).toBeLessThan(body.indexOf('What to do:'));
    expect(generateContextStub).not.toHaveBeenCalled();
  });

  it('appends the quota-cooldown pause notice to the welcome hint when the breaker is armed', async () => {
    mkdirSync(realPaths.paths.dataDir(), { recursive: true });
    writeFileSync(observerHealthPath, JSON.stringify({
      consecutiveFailures: 0,
      failingSinceAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastErrorProvider: null,
      lastSuccessAt: Date.now(),
      quotaCooldown: {
        active: true,
        provider: 'claude',
        profile: resolveConfigDirProfileKey(), // pauses the account selected now
        armedAt: Date.now() - 60_000,
        until: Date.now() + 20 * 60_000,
        window: 'five_hour',
        message: 'Weekly limit reached',
      },
    }));

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.send).toHaveBeenCalledTimes(1);
    const body = (res.send as any).mock.calls[0][0] as string;
    expect(body).toContain('paused while a provider quota cooldown is active');
    expect(body).toContain('This is not a failure');
    expect(body).toContain('# claude-mem status');
    expect(body).not.toContain("can't save memories");
    expect(body.indexOf('# claude-mem status')).toBeLessThan(body.indexOf('quota cooldown'));
    expect(generateContextStub).not.toHaveBeenCalled();
  });

  it('skips the welcome hint when at least one observation exists', async () => {
    countQueryStub = mock(() => ({ count: 7 }));
    prepareStub = mock(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub }, getWorkStateEntries: workStateEntriesStub };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/active-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(generateContextStub).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith(`${EMPTY_WORK_STATE_SECTION}\n\nCONTEXT_FROM_GENERATOR`);
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
    expect(res.send).toHaveBeenCalledWith(`${EMPTY_WORK_STATE_SECTION}\n\nCONTEXT_FROM_GENERATOR`);
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
      null,
      null,
    );
  });

  it('threads normalized platformSource into observation count and context generation', async () => {
    countQueryStub = mock(() => ({ count: 2 }));
    prepareStub = mock(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub }, getWorkStateEntries: workStateEntriesStub };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = {
      query: { projects: '/path/parent,/path/worktree', platform_source: 'Cursor' },
      body: { platformSource: 'codex' },
      get: (name: string) => name.toLowerCase() === 'x-platform-source' ? 'claude' : undefined,
    } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    expect(countQueryStub).toHaveBeenCalledWith(
      '/path/parent',
      '/path/worktree',
      '/path/parent',
      '/path/worktree',
      'cursor',
      'cursor',
    );
    expect(generateContextStub).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: ['/path/parent', '/path/worktree'],
        platformSource: 'cursor',
      }),
      false,
    );
  });

  it('does not leak positive observation state across route instances', async () => {
    countQueryStub = mock(() => ({ count: 3 }));
    prepareStub = mock(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub }, getWorkStateEntries: workStateEntriesStub };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const activeRoutes = new SearchRoutes(mockSearchManager);
    const activeHandler = captureContextInjectHandler(activeRoutes);
    const activeRes = createMockRes();
    const activeReq = { query: { projects: '/path/to/project' } } as unknown as Request;

    activeHandler(activeReq, activeRes as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));
    expect(generateContextStub).toHaveBeenCalledTimes(1);

    generateContextStub.mockClear();
    countQueryStub = mock(() => ({ count: 0 }));
    prepareStub = mock(() => ({ get: countQueryStub }));
    mockSessionStore = { db: { prepare: prepareStub }, getWorkStateEntries: workStateEntriesStub };
    mockSearchManager = { getSessionStore: () => mockSessionStore };

    const emptyRoutes = new SearchRoutes(mockSearchManager);
    const emptyHandler = captureContextInjectHandler(emptyRoutes);
    const emptyRes = createMockRes();
    const emptyReq = { query: { projects: '/path/to/project' } } as unknown as Request;

    emptyHandler(emptyReq, emptyRes as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const body = (emptyRes.send as any).mock.calls[0][0] as string;
    expect(body).toContain('# claude-mem status');
    expect(generateContextStub).not.toHaveBeenCalled();
  });

  it('uses the request-local worker port env override in the welcome hint URL', async () => {
    process.env.CLAUDE_MEM_WORKER_PORT = '43210';

    const routes = new SearchRoutes(mockSearchManager);
    const handler = captureContextInjectHandler(routes);

    const res = createMockRes();
    const req = { query: { projects: '/path/to/empty-project' } } as unknown as Request;

    handler(req, res as unknown as Response);
    await new Promise(resolve => setImmediate(resolve));

    const body = (res.send as any).mock.calls[0][0] as string;
    expect(body).toContain('http://localhost:43210');
  });

  describe('work state', () => {
    const releaseEntries = () => [
      { id: 1, project: '/path/parent', list_name: 'release', fields: { version: '13.25.3', status: 'active' }, created_at_epoch: Date.now() },
      { id: 2, project: '/path/worktree', list_name: 'release', fields: { task: 'publish', status: 'todo' }, created_at_epoch: Date.now() },
    ];

    it('leads the context with what is still open and takes its length off the memory budget', async () => {
      countQueryStub = mock(() => ({ count: 7 }));
      prepareStub = mock(() => ({ get: countQueryStub }));
      mockSessionStore = { db: { prepare: prepareStub }, getWorkStateEntries: workStateEntriesStub };
      workStateEntriesStub.mockImplementation(releaseEntries);
      const handler = captureContextInjectHandler(new SearchRoutes({ getSessionStore: () => mockSessionStore } as any));
      const res = createMockRes();

      handler({ query: { projects: '/path/parent,/path/worktree' } } as unknown as Request, res as unknown as Response);
      await new Promise(resolve => setImmediate(resolve));

      expect(workStateEntriesStub).toHaveBeenCalledWith(['/path/parent', '/path/worktree']);
      const body = (res.send as any).mock.calls[0][0] as string;
      expect(body).toStartWith('# Work state: your to-do lists and working state');
      expect(body).toContain('\n\nStill open:\n- release: version=13.25.3, status=active, updated 1 minute ago\n  - [todo] publish, updated 1 minute ago');
      expect(body).toEndWith('\n\nCONTEXT_FROM_GENERATOR');
      const sectionLength = body.length - '\n\nCONTEXT_FROM_GENERATOR'.length;
      expect(generateContextStub).toHaveBeenCalledWith(expect.objectContaining({ reserveChars: sectionLength + 2 }), false);
    });

    it('leads the welcome hint with what is still open', async () => {
      workStateEntriesStub.mockImplementation(releaseEntries);
      const handler = captureContextInjectHandler(new SearchRoutes(mockSearchManager));
      const res = createMockRes();

      handler({ query: { projects: '/path/to/empty-project' } } as unknown as Request, res as unknown as Response);
      await new Promise(resolve => setImmediate(resolve));

      const body = (res.send as any).mock.calls[0][0] as string;
      expect(body).toStartWith('# Work state: your to-do lists and working state');
      expect(body).toContain('  - [todo] publish');
      expect(body.indexOf('Still open:')).toBeLessThan(body.indexOf('# claude-mem status'));
    });

    it('leaves the work state out of the colored terminal preview, which is for the human', async () => {
      countQueryStub = mock(() => ({ count: 7 }));
      prepareStub = mock(() => ({ get: countQueryStub }));
      mockSessionStore = { db: { prepare: prepareStub }, getWorkStateEntries: workStateEntriesStub };
      workStateEntriesStub.mockImplementation(releaseEntries);
      const handler = captureContextInjectHandler(new SearchRoutes({ getSessionStore: () => mockSessionStore } as any));
      const res = createMockRes();

      handler({ query: { projects: '/path/to/active-project', colors: 'true' } } as unknown as Request, res as unknown as Response);
      await new Promise(resolve => setImmediate(resolve));

      expect(workStateEntriesStub).not.toHaveBeenCalled();
      expect(res.send).toHaveBeenCalledWith('CONTEXT_FROM_GENERATOR');
      expect(generateContextStub).toHaveBeenCalledWith(expect.objectContaining({ reserveChars: 0 }), true);
    });
  });

  // A host that cannot run the project resolver itself (the in-process OMP
  // hook, #3556) sends its cwd; the route reads the keys the CLI context hook
  // would send for that checkout.
  describe('from a host cwd (#3556)', () => {
    let checkout: string;

    const searchManagerWithObservations = () => ({
      getSessionStore: () => ({
        db: { prepare: mock(() => ({ get: mock(() => ({ count: 1 })) })) },
        getWorkStateEntries: workStateEntriesStub,
      }),
    });

    beforeEach(() => {
      checkout = mkdtempSync(join(tmpdir(), 'omp-inject-checkout-'));
    });

    afterEach(() => {
      delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
      rmSync(checkout, { recursive: true, force: true });
    });

    it('reads the project keys of that checkout', async () => {
      const handler = captureContextInjectHandler(new SearchRoutes(searchManagerWithObservations() as any));
      const res = createMockRes();

      handler({ query: { cwd: checkout } } as unknown as Request, res as unknown as Response);
      await new Promise(resolve => setImmediate(resolve));

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(generateContextStub).toHaveBeenCalledTimes(1);
      const [injectRequest] = (generateContextStub as any).mock.calls[0];
      expect(injectRequest.projects).toEqual(getProjectContext(checkout).allProjects);
    });

    it('injects nothing for a checkout the user excluded', async () => {
      process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = basename(checkout);
      const handler = captureContextInjectHandler(new SearchRoutes(searchManagerWithObservations() as any));
      const res = createMockRes();

      handler({ query: { cwd: checkout } } as unknown as Request, res as unknown as Response);
      await new Promise(resolve => setImmediate(resolve));

      expect(res.send).toHaveBeenCalledWith('');
      expect(generateContextStub).not.toHaveBeenCalled();
    });
  });
});
