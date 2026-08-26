import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { logger } from '../../../src/utils/logger.js';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these partial stubs do not leak
// into later test files (bun's mock.module is process-global; mock.restore()
// does NOT undo it). A leaked ModeManager stub (no class prototype, no
// loadMode) breaks tests/server/server-boot.test.ts, server-runtime-smoke and
// the tests/sdk parser suites; leaked worker-service/worker-utils stubs break
// any later file that imports the real modules.
import * as realWorkerServiceModule from '../../../src/services/worker-service.js';
import * as realWorkerUtilsModule from '../../../src/shared/worker-utils.js';
import * as realModeManagerModule from '../../../src/services/domain/ModeManager.js';

const realWorkerServiceSnapshot = { ...realWorkerServiceModule };
const realWorkerUtilsSnapshot = { ...realWorkerUtilsModule };
const realModeManagerSnapshot = { ...realModeManagerModule };

afterAll(() => {
  mock.module('../../../src/services/worker-service.js', () => realWorkerServiceSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
});

function mockSettingsDefaults(): Record<string, string> {
  return {
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: mockFolderClaudeMdEnabled,
    CLAUDE_MEM_QUEUE_ENGINE: 'sqlite',
    CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true',
    CLAUDE_MEM_WORKER_PORT: '37777',
  };
}

function mockSettingsFromFile(settingsPath?: string, applyEnvOverrides = true): Record<string, string> {
  const settings = settingsPath && existsSync(settingsPath)
    ? { ...mockSettingsDefaults(), ...JSON.parse(readFileSync(settingsPath, 'utf-8')) }
    : mockSettingsDefaults();

  if (!applyEnvOverrides) {
    settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED = mockFolderClaudeMdEnabled;
    return settings;
  }

  for (const key of Object.keys(settings)) {
    if (key === 'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED') {
      continue;
    }
    settings[key] = process.env[key] ?? settings[key];
  }
  settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED = mockFolderClaudeMdEnabled;

  return settings;
}

mock.module('../../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../../src/utils/claude-md-utils.js', () => ({
  updateFolderClaudeMdFiles: (...args: unknown[]) => mockUpdateFolderClaudeMdFiles(...args),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    getAllDefaults: () => mockSettingsDefaults(),
    get: (key: string) => process.env[key] ?? mockSettingsDefaults()[key] ?? '',
    getInt: (key: string) => parseInt(process.env[key] ?? mockSettingsDefaults()[key] ?? '0', 10),
    loadFromFile: (settingsPath?: string, applyEnvOverrides = true) =>
      mockSettingsFromFile(settingsPath, applyEnvOverrides),
  },
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

import {
  extractObservationFileEvidence,
  processAgentResponse,
  type ResponseContext,
} from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let mockFolderClaudeMdEnabled = false;
let mockUpdateFolderClaudeMdFiles: ReturnType<typeof mock>;
let claimedMessages: Array<{
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: unknown;
}> = [];
let mockGetClaimedMessages: ReturnType<typeof mock>;

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
    mockFolderClaudeMdEnabled = false;
    claimedMessages = [];
    mockUpdateFolderClaudeMdFiles = mock(() => Promise.resolve());
    mockGetClaimedMessages = mock(() => claimedMessages);

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
      getCloudSync: () => null,
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
      getClaimedMessages: mockGetClaimedMessages,
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
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
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 5,
      startTime: Date.now(),
      cumulativeInputTokens: 100,
      cumulativeOutputTokens: 50,
      earliestPendingTimestamp: Date.now() - 10000,
      claimedMessageIds: [],
      conversationHistory: [],
      currentProvider: 'claude',
      ...overrides,
    } as ActiveSession;
  }

  describe('parsing observations from XML response', () => {
    it('should parse single observation from response', async () => {
      const session = createMockSession({ project: 'repo-b/worktree' });
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
      expect(project).toBe('repo-b/worktree');
      expect(mockChromaSyncObservation.mock.calls[0][2]).toBe('repo-b/worktree');
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

    it('stores observations against the dispatched prompt context when the live session has already advanced', async () => {
      const session = createMockSession({
        project: 'repo-b/worktree',
        lastPromptNumber: 2,
        pendingAgentId: 'agent-new',
        pendingAgentType: 'coder',
      });
      const responseContext: ResponseContext = {
        project: 'repo-a',
        promptNumber: 1,
        pendingAgentId: 'agent-old',
        pendingAgentType: 'planner',
      };
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Late response</title>
          <narrative>Stored on the original prompt context.</narrative>
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
        'TestAgent',
        undefined,
        undefined,
        responseContext
      );

      const [, project, observations, , promptNumber] = mockStoreObservations.mock.calls[0];
      expect(project).toBe('repo-a');
      expect(promptNumber).toBe(1);
      expect(observations[0].agent_id).toBe('agent-old');
      expect(observations[0].agent_type).toBe('planner');
      expect(mockChromaSyncObservation.mock.calls[0][2]).toBe('repo-a');
      expect(mockBroadcast.mock.calls[0][0].observation.project).toBe('repo-a');
      expect(mockBroadcast.mock.calls[0][0].observation.prompt_number).toBe(1);
    });
  });

  describe('file evidence sanitization', () => {
    it('enforces the provenance contract for read and write evidence', () => {
      const evidence = extractObservationFileEvidence([
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/read.ts' } },
        { type: 'observation', tool_name: 'write_file', tool_input: { filePath: 'src/write.ts', edits: [] } },
        {
          type: 'observation',
          tool_name: 'apply_patch',
          tool_input: '*** Update File: src/patch.ts\n@@\n-old\n+new\n',
        },
        {
          type: 'observation',
          tool_name: 'apply_patch',
          tool_input: JSON.stringify({ patch: '*** Update File: src/json-patch.ts\n@@\n-old\n+new\n' }),
        },
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/read.ts' } },
      ]);

      expect(evidence.files_read).toEqual(['src/read.ts']);
      expect(evidence.files_modified).toEqual(['src/write.ts', 'src/patch.ts', 'src/json-patch.ts']);
    });
  });

  describe('observation file metadata gating', () => {
    it('drops fabricated files_modified while preserving read evidence', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'supabase/functions/edge/index.ts' } },
      ];

      const session = createMockSession();
      const responseText = `
        <observation>
          <type>bugfix</type>
          <title>Secured edge function access</title>
          <narrative>Completed the security work.</narrative>
          <facts><fact>Observed read-only inspection</fact></facts>
          <concepts><concept>security</concept></concepts>
          <files_read><file>supabase/functions/edge/index.ts</file></files_read>
          <files_modified><file>supabase/functions/edge/index.ts</file></files_modified>
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
      const [, , observations] = mockStoreObservations.mock.calls[0];
      expect(observations[0].files_read).toEqual(['supabase/functions/edge/index.ts']);
      expect(observations[0].files_modified).toEqual([]);
    });

    it('populates files_modified from captured write evidence when XML omits it', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'write_file', tool_input: { filePath: 'src/services/worker/agents/ResponseProcessor.ts', edits: [{ type: 'replace' }] } },
      ];

      const session = createMockSession();
      const responseText = `
        <observation>
          <type>bugfix</type>
          <title>Wrote the fix</title>
          <narrative>Captured write evidence drives stored metadata.</narrative>
          <facts><fact>Write evidence present</fact></facts>
          <concepts><concept>storage</concept></concepts>
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
      expect(observations[0].files_modified).toEqual(['src/services/worker/agents/ResponseProcessor.ts']);
    });

    it('keeps native records scoped to their originating project', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/native.ts' } },
      ];

      const session = createMockSession({ project: 'origin-project' });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Native scope</title>
          <facts><fact>Project stays unchanged</fact></facts>
          <concepts><concept>scoping</concept></concepts>
          <files_read><file>src/native.ts</file></files_read>
          <files_modified><file>src/native.ts</file></files_modified>
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

      const [memorySessionId, project] = mockStoreObservations.mock.calls[0];
      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('origin-project');
    });

    it('stores worktree-adopted records under the parent project scope', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/parent.ts' } },
      ];

      const session = createMockSession({ project: 'parent-project' });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Adopted scope</title>
          <facts><fact>Parent project owns the stored row</fact></facts>
          <concepts><concept>scoping</concept></concepts>
          <files_read><file>src/parent.ts</file></files_read>
          <files_modified><file>src/parent.ts</file></files_modified>
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

      const [memorySessionId, project] = mockStoreObservations.mock.calls[0];
      expect(memorySessionId).toBe('memory-session-456');
      expect(project).toBe('parent-project');
    });

    it('preserves read-only batches while clearing only files_modified', async () => {
      claimedMessages = [
        { type: 'observation', tool_name: 'Read', tool_input: { file_path: 'src/read-only.ts' } },
      ];

      const session = createMockSession();
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Read-only batch</title>
          <narrative>Read evidence should stay visible.</narrative>
          <facts><fact>Read evidence present</fact></facts>
          <concepts><concept>evidence</concept></concepts>
          <files_read></files_read>
          <files_modified><file>src/fabricated.ts</file></files_modified>
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
      expect(observations[0].files_read).toEqual(['src/read-only.ts']);
      expect(observations[0].files_modified).toEqual([]);
    });
  });

  describe('non-XML observer responses', () => {
    it('warns and clears pending work when the observer returns non-XML prose', async () => {
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        confirmClaimedMessages,
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
        expect.stringMatching(/^TestAgent returned non-XML prose response/),
        expect.objectContaining({ sessionId: 1, outputClass: 'prose' })
      );
      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
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
      const session = createMockSession({ project: 'repo-b/worktree' });
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
      expect(observationCall[0].observation.project).toBe('repo-b/worktree');
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
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        confirmClaimedMessages,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = '';

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it('clears pending work and does NOT call storeObservations on plain-text response', async () => {
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        confirmClaimedMessages,
      } as unknown as SessionManager;

      const session = createMockSession();
      const responseText = 'This is just plain text without any XML tags.';

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
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
    it('should reset processing work if memorySessionId is missing from session', async () => {
      const resetProcessingToPending = mock(() => Promise.resolve(1));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        resetProcessingToPending,
      } as unknown as SessionManager;
      const session = createMockSession({
        memorySessionId: null, // Missing memory session ID
      });
      const responseText = `<observation>
        <type>discovery</type>
        <title>some title</title>
        <narrative>some narrative</narrative>
      </observation>`;

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

      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(mockStoreObservations).not.toHaveBeenCalled();
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
});
