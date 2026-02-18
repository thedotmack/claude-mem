import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../../../src/utils/logger.js';

// Mock modules that cause import chain issues - MUST be before imports
// Use full paths from test file location
vi.mock('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

vi.mock('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

// Mock the ModeManager
vi.mock('../../../src/services/domain/ModeManager.js', () => ({
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
import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession, ParsedObservation, ParsedSummary } from '../../../src/services/worker-types.js';

/** Tuple type for storeObservations mock calls: (memorySessionId, project, observations, summaries, promptNumber, createdAtEpoch) */
type StoreObservationsCall = [string, string, ParsedObservation[], ParsedSummary[], number, number];


/** Broadcast event shape for observation or summary SSE events */
interface BroadcastEvent {
  type: string;
  observation?: { id: number; title: string; type: string };
  summary?: { request: string };
}
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

// Spy on logger methods to suppress output during tests
import type { MockInstance } from 'vitest';
let loggerSpies: MockInstance[] = [];

describe('ResponseProcessor', () => {
  // Mocks
  let mockStoreObservations: ReturnType<typeof vi.fn>;
  let mockChromaSyncObservation: ReturnType<typeof vi.fn>;
  let mockChromaSyncSummary: ReturnType<typeof vi.fn>;
  let mockBroadcast: ReturnType<typeof vi.fn>;
  let mockBroadcastProcessingStatus: ReturnType<typeof vi.fn>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let mockWorker: WorkerRef;

  beforeEach(() => {
    // Spy on logger to suppress output
    loggerSpies = [
      vi.spyOn(logger, 'info').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      vi.spyOn(logger, 'warn').mockImplementation(() => {}),
      vi.spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    // Create fresh mocks for each test
    mockStoreObservations = vi.fn(() => ({
      observationIds: [1, 2],
      summaryId: 1,
      createdAtEpoch: 1700000000000,
    } as StorageResult));

    mockChromaSyncObservation = vi.fn(() => Promise.resolve());
    mockChromaSyncSummary = vi.fn(() => Promise.resolve());

    mockDbManager = {
      getSessionStore: () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      }),
      getChromaSync: () => ({
        syncObservation: mockChromaSyncObservation,
        syncSummary: mockChromaSyncSummary,
      }),
    } as unknown as DatabaseManager;

    mockSessionManager = {
      // eslint-disable-next-line @typescript-eslint/require-await
      getMessageIterator: async function* () {
        yield* [];
      },
      getPendingMessageStore: () => ({
        markProcessed: vi.fn(() => {}),
        cleanupProcessed: vi.fn(() => 0),
        resetStuckMessages: vi.fn(() => 0),
      }),
    } as unknown as SessionManager;

    mockBroadcast = vi.fn(() => {});
    mockBroadcastProcessingStatus = vi.fn(() => {});

    mockWorker = {
      sseBroadcaster: {
        broadcast: mockBroadcast,
      },
      broadcastProcessingStatus: mockBroadcastProcessingStatus,
    };
  });

  afterEach(() => {
    for (const spy of loggerSpies) spy.mockRestore();
    vi.restoreAllMocks();
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
      ...overrides,
    };
  }

  describe('parsing observations from XML response', () => {
    it('should parse single observation from response', () => {
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

      processAgentResponse(
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
      const [memorySessionId, project, observations] =
        mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('test-project');
      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe('discovery');
      expect(observations[0].title).toBe('Found important pattern');
    });

    it('should parse multiple observations from response', () => {
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

      processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , observations] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(observations).toHaveLength(2);
      expect(observations[0].type).toBe('discovery');
      expect(observations[1].type).toBe('bugfix');
    });
  });

  describe('parsing summary from XML response', () => {
    it('should parse summary from response', () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <narrative>Test narrative for summary parsing</narrative>
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

      processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , , summary] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(summary).not.toBeNull();
      expect(summary.request).toBe('Build login form');
      expect(summary.investigated).toBe('Reviewed existing forms');
      expect(summary.learned).toBe('React Hook Form works well');
    });

    it('should handle response without summary', () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <narrative>Test narrative without summary</narrative>
          <facts></facts>
          <concepts></concepts>
          <files_read></files_read>
          <files_modified></files_modified>
        </observation>
      `;

      // Mock to return result without summary
      mockStoreObservations = vi.fn(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager as unknown as { getSessionStore: () => { storeObservations: typeof mockStoreObservations } }).getSessionStore = () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      });

      processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      const [, , , summary] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(summary).toBeNull();
    });
  });

  describe('atomic database transactions', () => {
    it('should call storeObservations atomically', () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <narrative>Test narrative for atomic transaction</narrative>
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

      processAgentResponse(
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
      ] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;

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
    it('should broadcast observations via SSE', () => {
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
      mockStoreObservations = vi.fn(() => ({
        observationIds: [42],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager as unknown as { getSessionStore: () => { storeObservations: typeof mockStoreObservations } }).getSessionStore = () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      });

      processAgentResponse(
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
      const observationCall = (mockBroadcast.mock.calls as [BroadcastEvent][]).find(
        (call) => call[0].type === 'new_observation'
      );
      expect(observationCall).toBeDefined();
      const obsEvent = (observationCall as [BroadcastEvent])[0];
      expect((obsEvent.observation as NonNullable<BroadcastEvent['observation']>).id).toBe(42);
      expect((obsEvent.observation as NonNullable<BroadcastEvent['observation']>).title).toBe('Broadcast Test');
      expect((obsEvent.observation as NonNullable<BroadcastEvent['observation']>).type).toBe('discovery');
    });

    it('should broadcast summary via SSE', () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test</title>
          <narrative>Test narrative for summary broadcast</narrative>
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

      processAgentResponse(
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
      const summaryCall = (mockBroadcast.mock.calls as [BroadcastEvent][]).find(
        (call) => call[0].type === 'new_summary'
      );
      expect(summaryCall).toBeDefined();
      const sumEvent = (summaryCall as [BroadcastEvent])[0];
      expect((sumEvent.summary as NonNullable<BroadcastEvent['summary']>).request).toBe('Build feature');
    });
  });

  describe('handling empty response', () => {
    it('should handle empty response gracefully', () => {
      const session = createMockSession();
      const responseText = '';

      // Mock to handle empty observations
      mockStoreObservations = vi.fn(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager as unknown as { getSessionStore: () => { storeObservations: typeof mockStoreObservations } }).getSessionStore = () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      });

      processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      // Should still call storeObservations with empty arrays
      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      const [, , observations, summary] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(observations).toHaveLength(0);
      expect(summary).toBeNull();
    });

    it('should handle response with only text (no XML)', () => {
      const session = createMockSession();
      const responseText = 'This is just plain text without any XML tags.';

      mockStoreObservations = vi.fn(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager as unknown as { getSessionStore: () => { storeObservations: typeof mockStoreObservations } }).getSessionStore = () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      });

      processAgentResponse(
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
      const [, , observations] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(observations).toHaveLength(0);
    });
  });

  describe('session cleanup', () => {
    it('should reset earliestPendingTimestamp after processing', () => {
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

      mockStoreObservations = vi.fn(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager as unknown as { getSessionStore: () => { storeObservations: typeof mockStoreObservations } }).getSessionStore = () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      });

      processAgentResponse(
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

    it('should call broadcastProcessingStatus after processing', () => {
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

      mockStoreObservations = vi.fn(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager as unknown as { getSessionStore: () => { storeObservations: typeof mockStoreObservations } }).getSessionStore = () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      });

      processAgentResponse(
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
    it('should add assistant response to conversation history', () => {
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

      mockStoreObservations = vi.fn(() => ({
        observationIds: [1],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      }));
      (mockDbManager as unknown as { getSessionStore: () => { storeObservations: typeof mockStoreObservations } }).getSessionStore = () => ({
        storeObservations: mockStoreObservations,
        completeSession: vi.fn(),
      });

      processAgentResponse(
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

  describe('skipSummaryStorage parameter', () => {
    it('should store observations but NOT summary when skipSummaryStorage=true', () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test observation</title>
          <narrative>Observation should still be stored</narrative>
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

      processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent',
        undefined,
        true  // skipSummaryStorage
      );

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      const [memorySessionId, , observations, summary] =
        mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(memorySessionId).toBe('memory-session-456');
      expect(observations).toHaveLength(1);
      expect(observations[0].title).toBe('Test observation');
      // Summary should be null even though XML contained one
      expect(summary).toBeNull();
    });

    it('should store both observations and summary when skipSummaryStorage=false', () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test observation</title>
          <narrative>Observation should be stored</narrative>
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

      processAgentResponse(
        responseText,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent',
        undefined,
        false  // skipSummaryStorage explicitly false
      );

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      const [, , observations, summary] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(observations).toHaveLength(1);
      expect(summary).not.toBeNull();
      expect(summary.request).toBe('Build feature');
    });

    it('should store both observations and summary when skipSummaryStorage is omitted', () => {
      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Test observation</title>
          <narrative>Observation should be stored</narrative>
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

      // Call without the skipSummaryStorage parameter (default behavior)
      processAgentResponse(
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
      const [, , observations, summary] = mockStoreObservations.mock.calls[0] as StoreObservationsCall;
      expect(observations).toHaveLength(1);
      expect(summary).not.toBeNull();
      expect(summary.request).toBe('Build feature');
    });
  });

  describe('error handling', () => {
    it('should throw error if memorySessionId is missing', () => {
      const session = createMockSession({
        memorySessionId: null, // Missing memory session ID
      });
      const responseText = '<observation><type>discovery</type></observation>';

      expect(() =>
        { processAgentResponse(
          responseText,
          session,
          mockDbManager,
          mockSessionManager,
          mockWorker,
          100,
          null,
          'TestAgent'
        ); }
      ).toThrow('Cannot store observations: memorySessionId not yet captured');
    });
  });
});
