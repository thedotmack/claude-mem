import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

mock.module('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

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

import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SUMMARY_MODE_MARKER } from '../../../src/sdk/prompts.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ResponseProcessor', () => {
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockChromaSyncObservation: ReturnType<typeof mock>;
  let mockChromaSyncSummary: ReturnType<typeof mock>;
  let mockBroadcast: ReturnType<typeof mock>;
  let mockBroadcastProcessingStatus: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let mockWorker: WorkerRef;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

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

    mockSessionManager = {
      getMessageIterator: async function* () {
        yield* [];
      },
      getPendingMessageStore: () => ({
        markProcessed: mock(() => {}),
        confirmProcessed: mock(() => {}),  // CLAIM-CONFIRM pattern: confirm after successful storage
        cleanupProcessed: mock(() => 0),
        resetStuckMessages: mock(() => 0),
      }),
      clearPendingForSession: mock(() => {}),
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
    } as ActiveSession;
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
    it('warns and clears pending work when the observer returns non-XML prose', async () => {
      const clearPendingForSession = mock(() => {});
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        clearPendingForSession,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = 'Skipping — repeated log scan with no new findings.';

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

      expect(logger.warn).toHaveBeenCalledWith(
        'PARSER',
        expect.stringMatching(/^TestAgent returned non-XML\/empty response/),
        expect.objectContaining({ sessionId: 1 })
      );
      expect(clearPendingForSession).toHaveBeenCalledWith(1);
      expect(session.earliestPendingTimestamp).toBeNull();
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });
  });

  describe('parsing summary from XML response', () => {
    it('should parse summary from response', async () => {
      const session = createMockSession();
      const responseText = `
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

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);

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
      expect(summary).toBeNull();
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

      expect(mockBroadcast).toHaveBeenCalled();

      const observationCall = mockBroadcast.mock.calls.find(
        (call: any[]) => call[0].type === 'new_observation'
      );
      expect(observationCall).toBeDefined();
      expect(observationCall[0].observation.id).toBe(42);
      expect(observationCall[0].observation.title).toBe('Broadcast Test');
      expect(observationCall[0].observation.type).toBe('discovery');
    });

    it('should broadcast summary via SSE', async () => {
      mockStoreObservations = mock(() => ({
        observationIds: [],
        summaryId: 99,
        createdAtEpoch: 1700000000000,
      } as StorageResult));
      (mockDbManager.getSessionStore as any) = () => ({
        storeObservations: mockStoreObservations,
        ensureMemorySessionIdRegistered: mock(() => {}),
        getSessionById: mock(() => ({ memory_session_id: 'memory-session-456' })),
      });

      const session = createMockSession();
      const responseText = `
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

      const summaryCall = mockBroadcast.mock.calls.find(
        (call: any[]) => call[0].type === 'new_summary'
      );
      expect(summaryCall).toBeDefined();
      expect(summaryCall[0].summary.request).toBe('Build feature');
    });
  });

  describe('handling empty / non-XML response', () => {
    it('clears pending work and does NOT call storeObservations on empty response', async () => {
      const clearPendingForSession = mock(() => {});
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        clearPendingForSession,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = '';

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(clearPendingForSession).toHaveBeenCalledWith(1);
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('clears pending work and does NOT call storeObservations on plain-text response', async () => {
      const clearPendingForSession = mock(() => {});
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        clearPendingForSession,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = 'This is just plain text without any XML tags.';

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(clearPendingForSession).toHaveBeenCalledWith(1);
      expect(session.earliestPendingTimestamp).toBeNull();
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
  });

  describe('error handling', () => {
    it('should throw error if memorySessionId is missing from session', async () => {
      const session = createMockSession({
        memorySessionId: null, // Missing memory session ID
      });
      const responseText = `<observation>
        <type>discovery</type>
        <title>some title</title>
        <narrative>some narrative</narrative>
      </observation>`;

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

  describe('lastSummaryStored tracking (#1633)', () => {
    it('should set lastSummaryStored=true when storage returns a summaryId', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: 42,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession();
      const responseText = `
        <summary>
          <request>user asked to fix bug</request>
          <investigated>looked at auth module</investigated>
          <learned>JWT tokens were expiring</learned>
          <completed>fixed expiry check</completed>
          <next_steps>write tests</next_steps>
        </summary>
      `;

      await processAgentResponse(responseText, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(session.lastSummaryStored).toBe(true);
    });

    it('should set lastSummaryStored=false when storage returns summaryId=null (silent loss path, #1633)', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession();
      const responseText = '<skip_summary/>';

      await processAgentResponse(responseText, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(session.lastSummaryStored).toBe(false);
    });
  });

  describe.skip('circuit breaker: consecutiveSummaryFailures counter (#1633 — deleted)', () => {
    const SUMMARY_PROMPT = `--- ${SUMMARY_MODE_MARKER} ---\nDo the summary now.`;

    it('does NOT increment the counter on normal observation responses (P1 regression guard)', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession({
        conversationHistory: [{ role: 'user', content: 'record a new observation' }],
      });
      const obsResponse = `
        <observation>
          <type>discovery</type>
          <title>found a thing</title>
          <narrative>it happened</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      for (let i = 0; i < 5; i++) {
        await processAgentResponse(obsResponse, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');
      }

      expect(session.consecutiveSummaryFailures).toBe(0);
    });

    it('increments the counter when a summary was expected but none was stored', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession({
        conversationHistory: [{ role: 'user', content: SUMMARY_PROMPT }],
      });
      const badResponse = 'I cannot comply with that request.';

      await processAgentResponse(badResponse, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(session.consecutiveSummaryFailures).toBe(1);
    });

    it('does NOT increment the counter on intentional <skip_summary/> responses', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession({
        consecutiveSummaryFailures: 1,
        conversationHistory: [{ role: 'user', content: SUMMARY_PROMPT }],
      });
      const skipResponse = '<skip_summary reason="no meaningful work this session"/>';

      await processAgentResponse(skipResponse, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(session.consecutiveSummaryFailures).toBe(1);
    });

    it('resets the counter to 0 when a summary is successfully stored', async () => {
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: 42,
        createdAtEpoch: 1700000000000,
      } as StorageResult));

      const session = createMockSession({
        consecutiveSummaryFailures: 2,
        conversationHistory: [{ role: 'user', content: SUMMARY_PROMPT }],
      });
      const goodResponse = `
        <summary>
          <request>wrap it up</request>
          <investigated>the thing</investigated>
          <learned>the answer</learned>
          <completed>the work</completed>
          <next_steps>none</next_steps>
        </summary>
      `;

      await processAgentResponse(goodResponse, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(session.consecutiveSummaryFailures).toBe(0);
    });
  });
});
