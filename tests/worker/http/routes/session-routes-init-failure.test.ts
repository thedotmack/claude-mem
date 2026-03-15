/**
 * SessionRoutes Init Failure Loop Prevention Tests (#623)
 *
 * Verifies that when SDK agent initialization fails, the session is marked
 * as failed and subsequent prompts don't retry init (breaking the infinite loop).
 *
 * Mock Justification:
 * - Express req/res mocks: Required because route handlers expect Express objects
 * - SessionManager: Controls whether initializeSession succeeds or throws
 * - DatabaseManager/SessionStore: Avoids database setup; we test init failure tracking, not queries
 * - Logger spies: Suppress console output during tests
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';

// Mock dependencies before importing SessionRoutes
mock.module('../../../../src/shared/paths.js', () => ({
  getPackageRoot: () => '/tmp/test',
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));
mock.module('../../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: class { get() { return {}; } },
}));
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
mock.module('../../../../src/services/worker/ProcessRegistry.js', () => ({
  getProcessBySession: () => null,
  ensureProcessExit: () => {},
}));

import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createMockReqRes(body: any, params: Record<string, string> = {}): {
  req: Partial<Request>;
  res: Partial<Response>;
  jsonSpy: ReturnType<typeof mock>;
  statusSpy: ReturnType<typeof mock>;
} {
  const jsonSpy = mock(() => {});
  const statusSpy = mock(() => ({ json: jsonSpy }));
  return {
    req: { body, params, path: '/test', query: {} } as Partial<Request>,
    res: {
      json: jsonSpy,
      status: statusSpy,
      headersSent: false,
    } as unknown as Partial<Response>,
    jsonSpy,
    statusSpy,
  };
}

// Data provider: init failure scenarios
const initFailureScenarios = [
  {
    name: 'initializeSession throws Error',
    error: new Error('SDK agent crashed'),
  },
  {
    name: 'initializeSession throws with FOREIGN KEY constraint',
    error: new Error('FOREIGN KEY constraint failed'),
  },
];

describe('SessionRoutes Init Failure Loop Prevention (#623)', () => {
  let routes: SessionRoutes;
  let mockInitializeSession: ReturnType<typeof mock>;
  let mockGetSession: ReturnType<typeof mock>;
  let mockCreateSDKSession: ReturnType<typeof mock>;
  let mockGetSessionById: ReturnType<typeof mock>;
  let mockGetPromptNumberFromUserPrompts: ReturnType<typeof mock>;
  let mockSaveUserPrompt: ReturnType<typeof mock>;
  let mockSessionManager: any;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    mockInitializeSession = mock(() => ({
      sessionDbId: 42,
      contentSessionId: 'test-content-id',
      project: 'test-project',
    }));
    mockGetSession = mock(() => undefined);

    mockCreateSDKSession = mock(() => 42);
    mockGetSessionById = mock(() => ({
      id: 42,
      content_session_id: 'test-content-id',
      memory_session_id: null,
      project: 'test-project',
    }));
    mockGetPromptNumberFromUserPrompts = mock(() => 0);
    mockSaveUserPrompt = mock(() => {});

    mockSessionManager = {
      initializeSession: mockInitializeSession,
      getSession: mockGetSession,
      sessions: new Map(),
    };

    const mockDbManager = {
      getSessionStore: () => ({
        createSDKSession: mockCreateSDKSession,
        getSessionById: mockGetSessionById,
        getPromptNumberFromUserPrompts: mockGetPromptNumberFromUserPrompts,
        saveUserPrompt: mockSaveUserPrompt,
        getLatestUserPrompt: mock(() => null),
      }),
      getChromaSync: () => null,
    };

    const mockEventBroadcaster = {
      broadcastNewPrompt: mock(() => {}),
      broadcastSessionStarted: mock(() => {}),
    };

    routes = new SessionRoutes(
      mockSessionManager as any,
      mockDbManager as any,
      {} as any, // sdkAgent
      {} as any, // geminiAgent
      {} as any, // openRouterAgent
      mockEventBroadcaster as any,
      {} as any, // workerService
    );
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  // Test 1: SDK init fails → sessionDbId added to failedInitSessions
  describe.each(initFailureScenarios)('$name', ({ error }) => {
    it('adds sessionDbId to failedInitSessions on init failure', () => {
      mockInitializeSession.mockImplementation(() => { throw error; });

      const { req, res, statusSpy } = createMockReqRes(
        { userPrompt: 'hello', promptNumber: 1 },
        { sessionDbId: '42' }
      );

      // Call handleSessionInit — wrapHandler catches the throw and returns 500
      (routes as any).handleSessionInit(req, res);

      expect(statusSpy).toHaveBeenCalledWith(500);
      expect((routes as any).failedInitSessions.has(42)).toBe(true);
    });
  });

  // Test 2: Subsequent prompt → contextInjected=true when in failedSet
  it('returns contextInjected=true for sessions in failedInitSessions', () => {
    // Pre-populate the failed set
    (routes as any).failedInitSessions.add(42);

    const { req, res, jsonSpy } = createMockReqRes({
      contentSessionId: 'test-content-id',
      project: 'test-project',
      prompt: 'second prompt',
    });

    (routes as any).handleSessionInitByClaudeId(req, res);

    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionDbId: 42,
        contextInjected: true,
      })
    );
  });

  // Test 3: Successful init → NOT added to failedSet
  it('does not add sessionDbId to failedInitSessions on successful init', () => {
    const { req, res } = createMockReqRes(
      { userPrompt: 'hello', promptNumber: 1 },
      { sessionDbId: '42' }
    );

    (routes as any).handleSessionInit(req, res);

    expect((routes as any).failedInitSessions.has(42)).toBe(false);
  });

  // Test 4: Integration — 3 prompts with broken SDK agent → init attempted once
  it('prevents infinite retry loop: SDK agent init called only once across 3 prompts', () => {
    // First call: initializeSession throws → failure recorded
    mockInitializeSession.mockImplementation(() => { throw new Error('SDK agent crashed'); });

    const { req: req1, res: res1 } = createMockReqRes(
      { userPrompt: 'prompt 1', promptNumber: 1 },
      { sessionDbId: '42' }
    );
    (routes as any).handleSessionInit(req1, res1);
    expect(mockInitializeSession).toHaveBeenCalledTimes(1);

    // Second prompt: /api/sessions/init should return contextInjected=true
    mockGetPromptNumberFromUserPrompts.mockImplementation(() => 1);
    const { req: req2, res: res2, jsonSpy: jsonSpy2 } = createMockReqRes({
      contentSessionId: 'test-content-id',
      project: 'test-project',
      prompt: 'prompt 2',
    });
    (routes as any).handleSessionInitByClaudeId(req2, res2);
    expect(jsonSpy2).toHaveBeenCalledWith(
      expect.objectContaining({ contextInjected: true })
    );

    // Third prompt: same — still contextInjected=true, no new init attempt
    mockGetPromptNumberFromUserPrompts.mockImplementation(() => 2);
    const { req: req3, res: res3, jsonSpy: jsonSpy3 } = createMockReqRes({
      contentSessionId: 'test-content-id',
      project: 'test-project',
      prompt: 'prompt 3',
    });
    (routes as any).handleSessionInitByClaudeId(req3, res3);
    expect(jsonSpy3).toHaveBeenCalledWith(
      expect.objectContaining({ contextInjected: true })
    );

    // initializeSession was only ever called once (on the first prompt)
    expect(mockInitializeSession).toHaveBeenCalledTimes(1);
  });
});
