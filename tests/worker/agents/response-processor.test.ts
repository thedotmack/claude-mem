import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

// Mock modules that cause import chain issues - MUST be before imports
// Use full paths from test file location
mock.module('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

// Mock the ModeManager
mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {
          init: 'init prompt',
          observation: 'obs prompt',
          summary: 'summary prompt',
        },
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    }),
  },
}));

// Import after mocks
import { processAgentResponse, isRateLimitResponse, isAuthErrorResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

// Spy on logger methods to suppress output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ResponseProcessor', () => {
  // Mocks
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockMarkFailed: ReturnType<typeof mock>;
  let mockChromaSyncObservation: ReturnType<typeof mock>;
  let mockChromaSyncSummary: ReturnType<typeof mock>;
  let mockBroadcast: ReturnType<typeof mock>;
  let mockBroadcastProcessingStatus: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let mockWorker: WorkerRef;

  beforeEach(() => {
    // Spy on logger to suppress output
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    // Create fresh mocks for each test
    mockStoreObservations = mock(() => ({
      observationIds: [1, 2],
      summaryId: 1,
      createdAtEpoch: 1700000000000,
    } as StorageResult));

    mockChromaSyncObservation = mock(() => Promise.resolve());
    mockChromaSyncSummary = mock(() => Promise.resolve());

    mockDbManager = {
      getSessionStore: () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),  // FK fix (Issue #846)
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),  // FK fix (Issue #846)
      }),
      getChromaSync: () => ({
        syncObservation: mockChromaSyncObservation,
        syncSummary: mockChromaSyncSummary,
      }),
    } as unknown as DatabaseManager;

    mockMarkFailed = mock(() => {});

    mockSessionManager = {
      getMessageIterator: async function* () {
        yield* [];
      },
      getPendingMessageStore: () => ({
        markProcessed: mock(() => {}),
        confirmProcessed: mock(() => {}),  // CLAIM-CONFIRM pattern: confirm after successful storage
        markFailed: mockMarkFailed,         // Preserve messages on error for retry
        cleanupProcessed: mock(() => 0),
        resetStuckMessages: mock(() => 0),
      }),
    } as unknown as SessionManager;

    mockBroadcast = mock(() => {});
    mockBroadcastProcessingStatus = mock(() => {});

    mockWorker = {
      sseBroadcaster: {
        broadcast: mockBroadcast,
      },
      broadcastProcessingStatus: mockBroadcastProcessingStatus,
    };
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  // Helper to create mock session
  function createMockSession(
    overrides: Partial<ActiveSession> = {}
  ): ActiveSession {
    return {
      sessionDbId: 1,
      contentSessionId: 'content-session-123',
      memorySessionId: 'memory-session-456',
      project: 'test-project',
      userPrompt: 'Test prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 5,
      startTime: Date.now(),
      cumulativeInputTokens: 100,
      cumulativeOutputTokens: 50,
      earliestPendingTimestamp: Date.now() - 10000,
      conversationHistory: [],
      currentProvider: 'claude',
      processingMessageIds: [],  // CLAIM-CONFIRM pattern: track message IDs being processed
      ...overrides,
    };
  }

  describe('parsing observations from XML response', () => {
    it('should parse single observation from response', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Found important pattern</title>
          <subtitle>In auth module</subtitle>
          <narrative>Discovered reusable authentication pattern.</narrative>
          <facts><fact>Uses JWT</fact></facts>
          <concepts><concept>authentication</concept></concepts>
          <files_read><file>src/auth.ts</file></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      const [memorySessionId, project, observations, summary] =
        mockStoreObservations.mock.calls[0];
      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('test-project');
      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe('discovery');
      expect(observations[0].title).toBe('Found important pattern');
    });

    it('should parse multiple observations from response', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>First discovery</title>
          <narrative>First narrative</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
        <observation>
          <type>bugfix</type>
          <title>Fixed null pointer</title>
          <narrative>Second narrative</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , observations] = mockStoreObservations.mock.calls[0];
      expect(observations).toHaveLength(2);
      expect(observations[0].type).toBe('discovery');
      expect(observations[1].type).toBe('bugfix');
    });
  });

  describe('non-XML observer responses', () => {
    it('preserves messages via markFailed when observer returns non-XML prose', async () => {
      const session = createMockSession({
        processingMessageIds: [101, 102],
      });
      const responseText = 'Skipping — repeated log scan with no new findings.';

      const result = await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      // Messages must be preserved, not silently deleted
      expect(mockMarkFailed).toHaveBeenCalledTimes(2);
      expect(mockMarkFailed).toHaveBeenCalledWith(101);
      expect(mockMarkFailed).toHaveBeenCalledWith(102);

      // storeObservations must NOT be called — no confirmed deletion of messages
      expect(mockStoreObservations).not.toHaveBeenCalled();

      // Return status indicates error
      expect(result.status).toBe('error');
      expect(result.observationCount).toBe(0);
    });
  });

  describe('parsing summary from XML response', () => {
    it('should parse summary from response', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
        <summary>
          <request>Build login form</request>
          <investigated>Reviewed existing forms</investigated>
          <learned>React Hook Form works well</learned>
          <completed>Form skeleton created</completed>
          <next_steps>Add validation</next_steps>
          <notes>Some notes</notes>
        </summary>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , , summary] = mockStoreObservations.mock.calls[0];
      expect(summary).not.toBeNull();
      expect(summary.request).toBe('Build login form');
      expect(summary.investigated).toBe('Reviewed existing forms');
      expect(summary.learned).toBe('React Hook Form works well');
    });

    it('should handle response without summary', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      // Mock to return result without summary
      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , , summary] = mockStoreObservations.mock.calls[0];
      expect(summary).toBeNull();
    });
  });

  describe('atomic database transactions', () => {
    it('should call storeObservations atomically', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
        <summary>
          <request>Test request</request>
          <investigated>Test investigated</investigated>
          <learned>Test learned</learned>
          <completed>Test completed</completed>
          <next_steps>Test next steps</next_steps>
        </summary>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        1700000000000,
        'TestAgent'
      );

      // Verify storeObservations was called exactly once (atomic)
      expect(mockStoreObservations).toHaveBeenCalledTimes(1);

      // Verify all parameters passed correctly
      const [
        memorySessionId,
        project,
        observations,
        summary,
        promptNumber,
        tokens,
        timestamp,
      ] = mockStoreObservations.mock.calls[0];

      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('test-project');
      expect(observations).toHaveLength(1);
      expect(summary).not.toBeNull();
      expect(promptNumber).toBe(5);
      expect(tokens).toBe(100);
      expect(timestamp).toBe(1700000000000);
    });
  });

  describe('SSE broadcasting', () => {
    it('should broadcast observations via SSE', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Broadcast Test</title>
          <subtitle>Testing broadcast</subtitle>
          <narrative>Testing SSE broadcast</narrative>
          <facts><fact>Fact 1</fact></facts>
          <concepts><concept>testing</concept></concepts>
          <files_read><file>test.ts</file></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      // Mock returning single observation ID
      mockStoreObservations = mock(() => ({
        observationIds: [42],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      // Should broadcast observation
      expect(mockBroadcast).toHaveBeenCalled();

      // Find the observation broadcast call
      const observationCall = mockBroadcast.mock.calls.find(
        (call: any[]) => call[0].type === 'new_observation'
      );
      expect(observationCall).toBeDefined();
      expect(observationCall[0].observation.id).toBe(42);
      expect(observationCall[0].observation.title).toBe('Broadcast Test');
      expect(observationCall[0].observation.type).toBe('discovery');
    });

    it('should broadcast summary via SSE', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
        <summary>
          <request>Build feature</request>
          <investigated>Reviewed code</investigated>
          <learned>Found patterns</learned>
          <completed>Feature built</completed>
          <next_steps>Add tests</next_steps>
        </summary>
      `;

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      // Find the summary broadcast call
      const summaryCall = mockBroadcast.mock.calls.find(
        (call: any[]) => call[0].type === 'new_summary'
      );
      expect(summaryCall).toBeDefined();
      expect(summaryCall[0].summary.request).toBe('Build feature');
    });
  });

  describe('handling empty response', () => {
    it('preserves pending messages via markFailed on empty response', async () => {
      // Empty response WITH pending messages = error; preserve them
      const session = createMockSession({
        processingMessageIds: [201],
      });

      const result = await processAgentResponse(
        '',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockMarkFailed).toHaveBeenCalledWith(201);
      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(result.status).toBe('error');
    });

    it('calls storeObservations normally on empty response with no pending messages (init case)', async () => {
      // Empty response WITHOUT pending messages = init prompt; proceed normally
      const session = createMockSession({
        processingMessageIds: [],  // init has no queued messages
      });

      mockStoreObservations = mock(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      const result = await processAgentResponse(
        '',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockMarkFailed).not.toHaveBeenCalled();
      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('empty');
    });

    it('preserves messages on plain-text non-XML response with pending messages', async () => {
      const session = createMockSession({
        processingMessageIds: [301],
      });

      const result = await processAgentResponse(
        'This is just plain text without any XML tags.',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockMarkFailed).toHaveBeenCalledWith(301);
      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(result.status).toBe('error');
    });

    it('preserves messages on malformed/truncated XML response with pending messages', async () => {
      const session = createMockSession({
        processingMessageIds: [302],
      });

      // Truncated XML — has XML markers but parser produces no observations/summary
      const result = await processAgentResponse(
        '<observation><type>bugfix',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockMarkFailed).toHaveBeenCalledWith(302);
      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(result.status).toBe('error');
    });
  });

  describe('session cleanup', () => {
    it('should reset earliestPendingTimestamp after processing', async () => {
      const session = createMockSession({
        earliestPendingTimestamp: 1700000000000,
      });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('should call broadcastProcessingStatus after processing', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(mockBroadcastProcessingStatus).toHaveBeenCalled();
    });
  });

  describe('conversation history', () => {
    it('should add assistant response to conversation history', async () => {
      const session = createMockSession({
        conversationHistory: [],
      });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      mockStoreObservations = mock(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(session.conversationHistory).toHaveLength(1);
      expect(session.conversationHistory[0].role).toBe('assistant');
      expect(session.conversationHistory[0].content).toBe(responseText);
    });

    it('should NOT add to conversationHistory on empty-response error path', async () => {
      const session = createMockSession({
        conversationHistory: [],
        processingMessageIds: [1],
      });

      await processAgentResponse(
        '',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        0,
        null,
        'TestAgent'
      );

      expect(session.conversationHistory).toHaveLength(0);
    });

    it('should NOT add to conversationHistory on non-XML error path', async () => {
      const session = createMockSession({
        conversationHistory: [],
        processingMessageIds: [1],
      });

      await processAgentResponse(
        'Some non-XML error text',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        0,
        null,
        'TestAgent'
      );

      expect(session.conversationHistory).toHaveLength(0);
    });

    it('should NOT add to conversationHistory on rate-limit error path', async () => {
      const session = createMockSession({
        conversationHistory: [],
        processingMessageIds: [1],
      });

      await processAgentResponse(
        "You've hit your rate limit. Please try again later.",
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        0,
        null,
        'TestAgent'
      );

      expect(session.conversationHistory).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should throw error if memorySessionId is missing from session', async () => {
      const session = createMockSession({
        memorySessionId: null, // Missing memory session ID
        processingMessageIds: [],
      });
      const responseText = '<observation><type>discovery</type></observation>';

      await expect(
        processAgentResponse(
          responseText,
          session,
          mockDbManager,
          mockSessionManager,
          mockWorker,
          100,
          null,
          'TestAgent'
        )
      ).rejects.toThrow('Cannot store observations: memorySessionId not yet captured');
    });
  });

  describe('return value', () => {
    it('returns ok status with observation count when XML is parsed successfully', async () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified>
        </observation>
      `;

      const result = await processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(result.status).toBe('ok');
      expect(result.observationCount).toBeGreaterThan(0);
      expect(mockMarkFailed).not.toHaveBeenCalled();
    });
  });

  describe('message preservation — rate-limit responses', () => {
    it('marks messages failed and returns rate_limited status on rate-limit text', async () => {
      const session = createMockSession({
        processingMessageIds: [401, 402],
      });

      const result = await processAgentResponse(
        "You've hit your rate limit. Please try again later.",
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(result.status).toBe('rate_limited');
      expect(mockMarkFailed).toHaveBeenCalledTimes(2);
      expect(mockMarkFailed).toHaveBeenCalledWith(401);
      expect(mockMarkFailed).toHaveBeenCalledWith(402);
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });

    it('marks messages failed on "too many requests" text', async () => {
      const session = createMockSession({ processingMessageIds: [501] });

      const result = await processAgentResponse(
        'Too many requests. Quota exceeded.',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(result.status).toBe('rate_limited');
      expect(mockMarkFailed).toHaveBeenCalledWith(501);
    });
  });

  describe('message preservation — auth error responses', () => {
    it('marks messages failed and returns error status on auth error text', async () => {
      const session = createMockSession({
        processingMessageIds: [601],
      });

      const result = await processAgentResponse(
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(result.status).toBe('error');
      expect(mockMarkFailed).toHaveBeenCalledWith(601);
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });

    it('marks messages failed on "Invalid API key" text', async () => {
      const session = createMockSession({ processingMessageIds: [701] });

      const result = await processAgentResponse(
        'Invalid API key. Please check your settings.',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(result.status).toBe('error');
      expect(mockMarkFailed).toHaveBeenCalledWith(701);
    });
  });

  describe('isRateLimitResponse', () => {
    it('detects common rate-limit patterns', () => {
      expect(isRateLimitResponse("You've hit your limit")).toBe(true);
      expect(isRateLimitResponse("rate limit exceeded")).toBe(true);
      expect(isRateLimitResponse("Too many requests")).toBe(true);
      expect(isRateLimitResponse("quota exceeded")).toBe(true);
      expect(isRateLimitResponse("billing limit reached")).toBe(true);
      expect(isRateLimitResponse("please wait a moment")).toBe(true);
    });

    it('does not match normal response text', () => {
      expect(isRateLimitResponse("Found an interesting pattern")).toBe(false);
      expect(isRateLimitResponse("Invalid API key")).toBe(false);
      expect(isRateLimitResponse("")).toBe(false);
    });
  });

  describe('isAuthErrorResponse', () => {
    it('detects common auth error patterns', () => {
      expect(isAuthErrorResponse("Invalid API key provided")).toBe(true);
      expect(isAuthErrorResponse("Invalid bearer token")).toBe(true);
      expect(isAuthErrorResponse('{"type":"authentication_error"}')).toBe(true);
      expect(isAuthErrorResponse("API key expired")).toBe(true);
      expect(isAuthErrorResponse("invalid_api_key")).toBe(true);
    });

    it('does not match rate-limit or normal text', () => {
      expect(isAuthErrorResponse("rate limit exceeded")).toBe(false);
      expect(isAuthErrorResponse("Found interesting pattern")).toBe(false);
      expect(isAuthErrorResponse("")).toBe(false);
    });
  });
});
