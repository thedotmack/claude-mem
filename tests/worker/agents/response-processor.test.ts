import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../../src/shared/paths.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { recordObserverFailure, readObserverHealth } from '../../../src/shared/observer-health.js';
import { recordQuotaExhausted, getQuotaCooldown, resetQuotaCooldownsForTesting } from '../../../src/shared/quota-cooldown.js';
import { logger } from '../../../src/utils/logger.js';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these partial stubs do not leak
// into later test files (bun's mock.module is process-global; mock.restore()
// does NOT undo it). A leaked ModeManager stub (no class prototype, no
// loadMode) breaks tests/server/server-boot.test.ts, server-runtime-smoke and
// the tests/sdk parser suites; leaked worker-utils stubs break
// any later file that imports the real modules.
import * as realWorkerUtilsModule from '../../../src/shared/worker-utils.js';
import * as realModeManagerModule from '../../../src/services/domain/ModeManager.js';
import * as realSettingsDefaultsModule from '../../../src/shared/SettingsDefaultsManager.js';
import * as realClaudeMdUtilsModule from '../../../src/utils/claude-md-utils.js';
import * as realGrokBotIndexWriterModule from '../../../src/services/integrations/GrokBotIndexWriter.js';

const realWorkerUtilsSnapshot = { ...realWorkerUtilsModule };
const realModeManagerSnapshot = { ...realModeManagerModule };
// The 4-key SettingsDefaultsManager stub below would otherwise leak into every
// later file that reads settings (e.g. ingestObservation's SKIP_TOOLS split).
const realSettingsDefaultsSnapshot = { ...realSettingsDefaultsModule };
const realClaudeMdUtilsSnapshot = { ...realClaudeMdUtilsModule };
const realGrokBotIndexWriterSnapshot = { ...realGrokBotIndexWriterModule };

afterAll(() => {
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsDefaultsSnapshot);
  mock.module('../../../src/utils/claude-md-utils.js', () => realClaudeMdUtilsSnapshot);
  mock.module('../../../src/services/integrations/GrokBotIndexWriter.js', () => realGrokBotIndexWriterSnapshot);
});

function mockSettingsDefaults(): Record<string, string> {
  return {
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: mockFolderClaudeMdEnabled,
    CLAUDE_MEM_QUEUE_ENGINE: 'sqlite',
    CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true',
    CLAUDE_MEM_WORKER_PORT: '37777',
    ...extraMockSettings,
  };
}

mock.module('../../../src/utils/claude-md-utils.js', () => ({
  updateFolderClaudeMdFiles: (...args: unknown[]) => mockUpdateFolderClaudeMdFiles(...args),
}));

mock.module('../../../src/services/integrations/GrokBotIndexWriter.js', () => ({
  notifyGrokBotIndex: () => undefined,
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    getAllDefaults: () => mockSettingsDefaults(),
    get: (key: string) => process.env[key] ?? mockSettingsDefaults()[key] ?? '',
    getInt: (key: string) => parseInt(process.env[key] ?? mockSettingsDefaults()[key] ?? '0', 10),
    loadFromFile: () => ({ ...mockSettingsDefaults(), ...extraMockSettings }),
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
  isOutputCapFinishReason,
  processAgentResponse,
  hasUnfinishedObservationBlock,
  takeObserverSchemaReminder,
  type ResponseContext,
} from '../../../src/services/worker/agents/ResponseProcessor.js';
import { buildObservationPrompt, OBSERVATION_SCHEMA_REMINDER } from '../../../src/sdk/prompts.js';
import type { WorkerRef, StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { sessionDbWithoutMedia } from '../../fixtures/worker/session-db-without-media.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let mockFolderClaudeMdEnabled = false;
// Per-test settings on top of the stub defaults (reset in beforeEach).
let extraMockSettings: Record<string, string> = {};
let mockUpdateFolderClaudeMdFiles: ReturnType<typeof mock>;
let claimedMessages: Array<{
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: unknown;
  toolUseId?: string;
}> = [];
let mockGetClaimedMessages: ReturnType<typeof mock>;

describe('ResponseProcessor', () => {
  let mockStoreObservations: ReturnType<typeof mock>;
  let mockChromaSyncObservation: ReturnType<typeof mock>;
  let mockChromaSyncSummary: ReturnType<typeof mock>;
  let mockBroadcast: ReturnType<typeof mock>;
  let mockBroadcastProcessingStatus: ReturnType<typeof mock>;
  let mockRecordAiInteraction: ReturnType<typeof mock>;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;
  let mockWorker: WorkerRef;

  let ownedHealthDirectory: string;
  let dataDirSpy: { mockRestore(): void };

  beforeEach(() => {
    ownedHealthDirectory = mkdtempSync(join(tmpdir(), 'claude-mem-response-health-'));
    dataDirSpy = spyOn(paths, 'dataDir').mockReturnValue(ownedHealthDirectory);
    resetQuotaCooldownsForTesting();
    expect(readObserverHealth()).toBeNull();
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    mockFolderClaudeMdEnabled = false;
    extraMockSettings = {};
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
        db: sessionDbWithoutMedia(), ensureMemorySessionIdRegistered: mock(() => {}),  // FK fix (Issue #846)
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
    mockRecordAiInteraction = mock(() => {});

    mockWorker = {
      sseBroadcaster: {
        broadcast: mockBroadcast,
      },
      broadcastProcessingStatus: mockBroadcastProcessingStatus,
      recordAiInteraction: mockRecordAiInteraction,
    };
  });

  afterEach(() => {
    // Reset while the resolver still points into this test's owned directory.
    resetQuotaCooldownsForTesting();
    dataDirSpy.mockRestore();
    rmSync(ownedHealthDirectory, { recursive: true, force: true });
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
      consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0,
      ...overrides,
    } as ActiveSession;
  }

  it('commits a real claimed tool identity with its stored observation', async () => {
    const store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession('content-session-123', 'test-project', 'prompt', undefined, 'codex');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-session-456');
    mockDbManager = { ...mockDbManager, getSessionStore: () => store } as unknown as DatabaseManager;
    claimedMessages = [{ type: 'observation', tool_name: 'Bash', toolUseId: 'toolu_real_1' }];
    try {
      await processAgentResponse(
        '<observation><type>discovery</type><title>Stored</title><narrative>Result</narrative></observation>',
        createMockSession({ sessionDbId, platformSource: 'codex' }),
        mockDbManager, mockSessionManager, mockWorker, 100, null, 'TestAgent',
      );
      expect(store.hasCommittedToolUse('codex', 'content-session-123', 'toolu_real_1')).toBe(true);
      expect(store.hasCommittedToolUse('claude', 'content-session-123', 'toolu_real_1')).toBe(false);
    } finally {
      store.close();
    }
  });

  describe('reply cut off at the output-token cap', () => {
    const complete = '<observation><type>discovery</type><title>Kept</title><narrative>Whole block</narrative></observation>';
    const cut = `${complete}\n<observation><type>change</type><title>Unfinished`;
    const cutOffErrors = () => (loggerSpies[3] as ReturnType<typeof spyOn>).mock.calls
      .filter(call => String(call[1]).includes('reply was cut off'));

    // A restart never authorizes re-spending on answered work, so a cut-off
    // reply's claimed tool uses are terminal like any other stored reply.
    it('marks a reply cut off at the cap terminal for its claimed tool uses', async () => {
      claimedMessages = [{ type: 'observation', tool_name: 'Bash', toolUseId: 'toolu_cut_1' }];
      await processAgentResponse(cut, createMockSession({ lastFinishReason: 'length' }),
        mockDbManager, mockSessionManager, mockWorker, 100, null, 'TestAgent');
      expect(mockStoreObservations.mock.calls[0][8]).toMatchObject({
        committedToolUses: { contentSessionId: 'content-session-123', toolUseIds: ['toolu_cut_1'] },
      });
    });

    it('stores the complete blocks and reports the lost tail when finish_reason is length', async () => {
      const session = createMockSession({ lastFinishReason: 'length' } as Partial<ActiveSession>);
      const result = await processAgentResponse(cut, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');
      expect(result).not.toBeNull();
      expect(mockStoreObservations).toHaveBeenCalled();
      const errors = cutOffErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0][2]).toMatchObject({ finishReason: 'length', completeObservations: 1, hasUnfinishedObservationBlock: true });
    });
  });

  it('classifies output-cap finish reasons and finds an unfinished observation block', () => {
    expect(isOutputCapFinishReason('length')).toBe(true);
    expect(isOutputCapFinishReason('MAX_TOKENS')).toBe(true);
    expect(isOutputCapFinishReason('stop')).toBe(false);
    expect(isOutputCapFinishReason(null)).toBe(false);
    expect(hasUnfinishedObservationBlock('<observation>a</observation><observation>b')).toBe(true);
    expect(hasUnfinishedObservationBlock('<observation>a</observation>')).toBe(false);
    // A tag inside a stored block's content is content, not a block boundary.
    expect(hasUnfinishedObservationBlock('<observation><![CDATA[<observation>]]></observation>')).toBe(false);
    expect(hasUnfinishedObservationBlock('<observation>say "<observation>" twice: <observation></observation>')).toBe(false);
    expect(hasUnfinishedObservationBlock('<observation>a</observation><observation>cut <![CDATA[<observation>')).toBe(true);
    // A whole summary, or a skip reason, that mentions the tag is not a cut-off observation.
    expect(hasUnfinishedObservationBlock('<summary><learned>Each result needs an <observation> block</learned></summary>')).toBe(false);
    expect(hasUnfinishedObservationBlock('<skip_summary reason="no <observation> worth storing" />')).toBe(false);
    expect(hasUnfinishedObservationBlock("<skip_summary reason = 'no <observation> worth storing' />")).toBe(false);
  });

  it('does not report a successful observer store when no memory rows were written', async () => {
    const store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession('empty-store-session', 'test-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'empty-store-memory');
    mockDbManager = {
      ...mockDbManager,
      getSessionStore: () => store,
    } as unknown as DatabaseManager;
    const session = createMockSession({
      sessionDbId, contentSessionId: 'empty-store-session', memorySessionId: 'empty-store-memory',
    });
    recordObserverFailure('claude', 'provider outage');
    const cooldown = recordQuotaExhausted('claude', 'spent allowance');
    const prior = readObserverHealth();
    try {
      const result = await processAgentResponse(
        '<observation><type>discovery</type><title> </title><narrative>No storable title</narrative></observation>',
        session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent',
      );
      expect(result?.observationIds).toEqual([]);
      expect(result?.summaryId).toBeNull();
      expect(readObserverHealth()?.consecutiveFailures).toBe(prior?.consecutiveFailures);
      expect(readObserverHealth()?.lastSuccessAt).toBe(prior?.lastSuccessAt);
      expect(getQuotaCooldown('claude')).toEqual(cooldown);
    } finally {
      store.close();
    }
  });

  it.each([
    '<observation><type>discovery</type><title>Useful result</title><narrative>Real finding</narrative></observation>',
    '<summary><request>Real session summary</request><investigated>Code</investigated><learned>Finding</learned><completed>Work</completed><next_steps>Review</next_steps></summary>',
  ])('still clears observer failure evidence after storing real memory: %s', async (text) => {
    const store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession('successful-store-session', 'test-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'successful-store-memory');
    mockDbManager = { ...mockDbManager, getSessionStore: () => store } as unknown as DatabaseManager;
    const session = createMockSession({
      sessionDbId, contentSessionId: 'successful-store-session', memorySessionId: 'successful-store-memory',
    });
    recordObserverFailure('claude', 'provider outage');
    recordQuotaExhausted('claude', 'spent allowance');
    try {
      const result = await processAgentResponse(
        text, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent',
      );
      expect(result).not.toBeNull();
      expect((result?.observationIds.length ?? 0) + (result?.summaryId ? 1 : 0)).toBeGreaterThan(0);
      expect(readObserverHealth()?.consecutiveFailures).toBe(0);
      expect(readObserverHealth()?.lastSuccessAt).not.toBeNull();
      expect(getQuotaCooldown('claude')).toBeNull();
    } finally {
      store.close();
    }
  });

  it.each([
    ['subscription', 'api-key'],
    ['api-key', 'subscription'],
  ] as const)("keeps the primary credential's breaker when a quota-fallback run on %s stores memory", async (standIn, held) => {
    const store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession(`stand-in-${standIn}`, 'test-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, `stand-in-memory-${standIn}`);
    mockDbManager = { ...mockDbManager, getSessionStore: () => store } as unknown as DatabaseManager;
    const session = createMockSession({
      sessionDbId, contentSessionId: `stand-in-${standIn}`, memorySessionId: `stand-in-memory-${standIn}`,
      currentProvider: 'claude', claudeAuthOverride: standIn,
    });
    const cooldown = recordQuotaExhausted('claude', 'allowance spent', undefined, undefined, undefined, held);
    try {
      const result = await processAgentResponse(
        '<observation><type>discovery</type><title>Useful result</title><narrative>Real finding</narrative></observation>',
        session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent',
      );
      expect(result?.observationIds.length).toBeGreaterThan(0);
      expect(getQuotaCooldown('claude')).toEqual(cooldown);
    } finally {
      store.close();
    }
  });

  describe('parsing observations from XML response', () => {
    it('skips Chroma sync and the SSE broadcast for a Tier-0 dedup merge (#3038)', async () => {
      // Item 1 reused an existing row: syncing its new content under id 3 would
      // overwrite that row's vector and show text the row does not hold.
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [7, 3],
        mergedIntoExisting: [false, true],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Fresh finding</title>
          <narrative>New row</narrative>
          <facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified>
        </observation>
        <observation>
          <type>discovery</type>
          <title>Recurring finding</title>
          <narrative>Merged into an older row</narrative>
          <facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(responseText, createMockSession(), mockDbManager, mockSessionManager, mockWorker, 100, null, 'TestAgent');

      expect(mockChromaSyncObservation.mock.calls.map(call => call[0])).toEqual([7]);
      const broadcastIds = mockBroadcast.mock.calls
        .map(call => call[0] as { type: string; observation?: { id: number } })
        .filter(event => event.type === 'new_observation')
        .map(event => event.observation?.id);
      expect(broadcastIds).toEqual([7]);
    });

    it('drops a title-less observation before storing, so Chroma and the brainbeat webhook get the right ids', async () => {
      // Like the real store: one id per TITLED observation it is handed. Before
      // the fix the untitled one was handed over too, and every later id shifted
      // onto the wrong parsed observation.
      mockStoreObservations.mockImplementation((_memorySessionId: string, _project: string, observations: Array<{ title: string | null }>) => {
        const titled = observations.filter(observation => observation.title);
        return {
          observationIds: titled.map((_observation, index) => 101 + index),
          mergedIntoExisting: titled.map(() => false),
          summaryId: null,
          createdAtEpoch: 1700000000000,
        } as StorageResult;
      });
      extraMockSettings = {
        CLAUDE_MEM_GROK_BOT_WEBHOOK_URL: 'https://bot.example/hook',
        CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'discovery,bugfix',
      };
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 202 }));
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>First finding</title>
          <narrative>A</narrative>
          <facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified>
        </observation>
        <observation>
          <type>discovery</type>
          <narrative>A narrative with no title</narrative>
          <facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified>
        </observation>
        <observation>
          <type>bugfix</type>
          <title>Third finding</title>
          <narrative>C</narrative>
          <facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified>
        </observation>
      `;

      await processAgentResponse(responseText, createMockSession(), mockDbManager, mockSessionManager, mockWorker, 100, null, 'TestAgent');

      const stored = mockStoreObservations.mock.calls[0][2] as Array<{ title: string | null; type: string }>;
      expect(stored.map(observation => [observation.title, observation.type]))
        .toEqual([['First finding', 'discovery'], ['Third finding', 'bugfix']]);
      expect(mockChromaSyncObservation.mock.calls.map(call => [call[0], (call[3] as { title: string }).title]))
        .toEqual([[101, 'First finding'], [102, 'Third finding']]);
      const webhookPayloads = fetchSpy.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)));
      expect(webhookPayloads.map(payload => [payload.observation_id, payload.title]))
        .toEqual([[101, 'First finding'], [102, 'Third finding']]);
    });

    it('does not store an init reply or acknowledge queued work, even when it parses as an observation', async () => {
      // Upstream's seam: with the feed paced to one unanswered prompt,
      // lastGeneratorSource names the prompt this reply answers.
      const session = createMockSession({ lastGeneratorSource: 'init', claimedMessageIds: [7] });
      const text = '<observation><type>feature</type><title>Unproven deployment</title><narrative>The user asked to deploy.</narrative></observation>';

      await processAgentResponse(text, session, mockDbManager, mockSessionManager,
        mockWorker, 100, null, 'SDK');

      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(mockSessionManager.confirmClaimedMessages).not.toHaveBeenCalled();
      expect(mockSessionManager.resetProcessingToPending).not.toHaveBeenCalled();
      // The turn is kept so role alternation holds; only storage is refused.
      expect(session.conversationHistory).toEqual([{ role: 'assistant', content: text }]);
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
    it('merges and deduplicates read evidence while dropping fabricated files_modified', async () => {
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
          <files_read><file>supabase/functions/edge/index.ts</file><file>src/other.ts</file></files_read>
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
      expect(observations[0].files_read).toEqual(['supabase/functions/edge/index.ts', 'src/other.ts']);
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

    it('pauses the generator with a preserving abort reason on transport failure', async () => {
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        confirmClaimedMessages: mock(() => Promise.resolve(0)),
        resetProcessingToPending: mock(() => Promise.resolve(0)),
      } as unknown as SessionManager;

      const session = createMockSession();

      await processAgentResponse(
        'getaddrinfo ENOTFOUND api.anthropic.com',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      // handleGeneratorExit keys off the category before the colon; 'transport'
      // is what keeps it from finalizing the session and undoing the requeue.
      expect(mockSessionManager.resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(mockSessionManager.confirmClaimedMessages).not.toHaveBeenCalled();
      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(session.abortReason).toBe('transport:observer_text');
      expect(session.abortController.signal.aborted).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        'PARSER',
        expect.stringMatching(/could not reach the provider/),
        expect.objectContaining({ sessionId: 1, outputClass: 'transport' })
      );
    });
  });

  describe('context-window overflow recovery (#3800)', () => {
    function overflowSessionManager() {
      const resetProcessingToPending = mock(() => Promise.resolve(1));
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        confirmClaimedMessages,
        resetProcessingToPending,
      } as unknown as SessionManager;
      return { resetProcessingToPending, confirmClaimedMessages };
    }

    it('recycles the conversation and preserves the batch instead of dropping it', async () => {
      const { resetProcessingToPending, confirmClaimedMessages } = overflowSessionManager();
      const session = createMockSession({
        conversationHistory: [
          { role: 'user', content: 'framing' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'observation 1' },
        ],
        consecutiveContextOverflows: 0,
      });

      await processAgentResponse(
        'Prompt is too long', session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      // The batch is preserved for a fresh generator, never confirmed away.
      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(confirmClaimedMessages).not.toHaveBeenCalled();
      // The outgrown conversation is dropped and a fresh one forced.
      expect(session.conversationHistory).toEqual([]);
      expect(session.forceInit).toBe(true);
      expect(session.abortReason).toBe('overflow:recycle');
      expect(session.abortController.signal.aborted).toBe(true);
      expect(session.consecutiveContextOverflows).toBe(1);
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });
  });

  describe('AI interaction health signal', () => {
    it("labels the interaction with the session's provider, not the current settings", async () => {
      const session = createMockSession();
      (session as { currentProvider?: string }).currentProvider = 'gemini';

      await processAgentResponse(
        'API Error: 401 Invalid authentication credentials', session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'SDK'
      );

      expect(mockRecordAiInteraction).toHaveBeenCalledWith({
        success: false,
        error: 'unauthenticated',
        provider: 'gemini',
      });
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });

    it('does NOT record an interaction for ordinary non-auth prose', async () => {
      const session = createMockSession();
      const responseText = 'Skipping — repeated log scan with no new findings.';

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockRecordAiInteraction).not.toHaveBeenCalled();
    });

    it('records a successful interaction when observations store', async () => {
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

      await processAgentResponse(
        responseText, session, mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent'
      );

      expect(mockRecordAiInteraction).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
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
      expect(observationCall[0].observation.id).toBe(1);
      expect(observationCall[0].observation.project).toBe('repo-b/worktree');
      expect(observationCall[0].observation.title).toBe('Broadcast Test');
      expect(observationCall[0].observation.type).toBe('discovery');
    });
  });

  describe('handling empty / non-XML response', () => {
    it('confirms an explicit <skip_summary/> to an observation prompt and hands storage no rows', async () => {
      // The file's default store stub answers with observation ids whatever it
      // is given; a skip writes nothing, so answer as the real store would.
      mockStoreObservations.mockImplementation(() => ({
        observationIds: [],
        summaryId: null,
        createdAtEpoch: 1700000000000,
      } as StorageResult));
      const confirmClaimedMessages = mock(() => Promise.resolve(1));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getClaimedMessages: mock(() => []),
        confirmClaimedMessages,
      } as unknown as SessionManager;

      const session = createMockSession({ earliestPendingTimestamp: 1700000000000 });

      await processAgentResponse(
        '<skip_summary reason="agent bookkeeping"/>',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'Gemini'
      );

      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
      // With the memory session id known the skip still passes through the
      // store, carrying nothing: no observations and a null summary.
      for (const [, , observations, summary] of mockStoreObservations.mock.calls) {
        expect(observations).toEqual([]);
        expect(summary).toBeNull();
      }
      expect(session.earliestPendingTimestamp).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });

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

    // #3454: the idle WARN line names why the turn was empty (block kinds
    // only), so "the model skipped" is distinguishable from "the turn had
    // only thinking/tool_use blocks" in the field.
    it('names the empty-turn shape on the idle WARN line', async () => {
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        confirmClaimedMessages: mock(() => Promise.resolve(0)),
      } as unknown as SessionManager;

      await processAgentResponse(
        '', createMockSession(), mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent', undefined, undefined, undefined,
        'non-text-blocks-only(thinking,tool_use)'
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'PARSER',
        expect.stringMatching(/non-XML idle response/),
        expect.objectContaining({ outputClass: 'idle', emptyOutputReason: 'non-text-blocks-only(thinking,tool_use)' })
      );
    });

    it('does not attach an empty-turn shape to a prose response', async () => {
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        confirmClaimedMessages: mock(() => Promise.resolve(0)),
      } as unknown as SessionManager;

      await processAgentResponse(
        'Nothing durable in this batch.', createMockSession(), mockDbManager, mockSessionManager, mockWorker,
        100, null, 'TestAgent', undefined, undefined, undefined, 'blank-text'
      );

      expect(logger.warn).toHaveBeenCalledWith(
        'PARSER',
        expect.stringMatching(/non-XML prose response/),
        expect.not.objectContaining({ emptyOutputReason: expect.anything() })
      );
    });
  });

  describe('session cleanup', () => {
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

  describe('signed-out CLI prose preserves the batch (#3606)', () => {
    // End to end over the branch the matcher gates: the CLI's signed-out
    // wording must reach the auth branch (reset to pending + abort) instead of
    // the prose fallback, which confirms the claim and loses the work.
    it('resets the batch to pending instead of confirming it', async () => {
      const confirmClaimedMessages = mock(() => Promise.resolve(0));
      const resetProcessingToPending = mock(() => Promise.resolve(1));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        confirmClaimedMessages,
        resetProcessingToPending,
      } as unknown as SessionManager;
      const session = createMockSession();

      await processAgentResponse(
        'Not logged in · Please run /login',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(confirmClaimedMessages).not.toHaveBeenCalled();
      expect(session.abortReason).toBe('auth:observer_text');
    });

    it('preserves the batch on the org-disabled subscription notice with its own abort reason (#4677)', async () => {
      const confirmClaimedMessages = mock(async () => 0);
      const resetProcessingToPending = mock(async () => 1);
      const mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ markProcessed: mock(() => {}) }),
        confirmClaimedMessages,
        resetProcessingToPending,
      } as unknown as SessionManager;
      const session = createMockSession();

      await processAgentResponse(
        'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(confirmClaimedMessages).not.toHaveBeenCalled();
      expect(session.abortReason).toBe('auth:observer_org_policy');
    });

    it('preserves the batch on an Anthropic verification hold without logging its account URL (#5251)', async () => {
      const confirmClaimedMessages = mock(async () => 0);
      const resetProcessingToPending = mock(async () => 1);
      const mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ markProcessed: mock(() => {}) }),
        confirmClaimedMessages,
        resetProcessingToPending,
      } as unknown as SessionManager;
      const session = createMockSession();
      const response = "API Error: Your account can't receive replies from Claude right now. You can find the next step in the Anthropic Verification Portal: https://portal.anthropic.com/verify?org=private-org-id";

      await processAgentResponse(
        response,
        session,
        mockDbManager,
        mockSessionManager,
        mockWorker,
        100,
        null,
        'TestAgent'
      );

      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(confirmClaimedMessages).not.toHaveBeenCalled();
      expect(session.abortReason).toBe('auth:observer_verification_hold');
      expect(mockRecordAiInteraction).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'unauthenticated' })
      );
      expect(logger.error).toHaveBeenCalledWith(
        'PARSER',
        expect.stringContaining('account verification is required'),
        expect.not.objectContaining({ preview: expect.stringContaining('private-org-id') })
      );
    });
  });
  describe('a valid reply that arrives before the memory session id is captured', () => {
    function sessionManagerWithSpies() {
      const confirmClaimedMessages = mock(() => Promise.resolve(1));
      const resetProcessingToPending = mock(() => Promise.resolve(1));
      mockSessionManager = {
        getMessageIterator: async function* () { yield* []; },
        getPendingMessageStore: () => ({ confirmProcessed: mock(() => {}) }),
        getClaimedMessages: mock(() => []),
        confirmClaimedMessages,
        resetProcessingToPending,
      } as unknown as SessionManager;
      return { confirmClaimedMessages, resetProcessingToPending };
    }

    it('confirms a skip at once: it stores nothing, so it needs no memory session id', async () => {
      const { confirmClaimedMessages, resetProcessingToPending } = sessionManagerWithSpies();
      const session = createMockSession({ memorySessionId: null });

      await processAgentResponse('<skip_summary reason="noise" />', session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(confirmClaimedMessages).toHaveBeenCalledWith(1);
      expect(resetProcessingToPending).not.toHaveBeenCalled();
      expect(mockStoreObservations).not.toHaveBeenCalled();
      expect(session.lastSummaryStored).toBe(false);
      expect(session.earliestPendingTimestamp).toBeNull();
    });

    it.each([
      ['<skip_summary reason="noise" />', undefined],
      ['<skip_summary reason="noise" />\n<observation><type>change</type><title>Unfinished', 'length'],
    ] as const)('commits a skip marker before confirming claimed work without a memory session id: %s', async (responseText, lastFinishReason) => {
      const store = new SessionStore(':memory:');
      const sessionDbId = store.createSDKSession('content-session-123', 'test-project', 'prompt', undefined, 'claude');
      const { confirmClaimedMessages } = sessionManagerWithSpies();
      mockSessionManager = {
        ...mockSessionManager,
        getClaimedMessages: mock(() => [{ type: 'observation', toolUseId: 'toolu_skip_1' }]),
      } as unknown as SessionManager;
      mockDbManager = { ...mockDbManager, getSessionStore: () => store } as unknown as DatabaseManager;
      try {
        await processAgentResponse(responseText,
          createMockSession({ sessionDbId, memorySessionId: null, lastFinishReason }),
          mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');
        expect(store.hasCommittedToolUse('claude', 'content-session-123', 'toolu_skip_1')).toBe(true);
        expect(confirmClaimedMessages).toHaveBeenCalledWith(sessionDbId);
      } finally {
        store.close();
      }
    });

    it('still defers an observation until the id arrives', async () => {
      const { confirmClaimedMessages, resetProcessingToPending } = sessionManagerWithSpies();
      const session = createMockSession({ memorySessionId: null });
      const responseText = `
        <observation>
          <type>discovery</type>
          <title>Found the retry loop</title>
          <narrative>The worker re-queued the same batch.</narrative>
        </observation>
      `;

      await processAgentResponse(responseText, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

      expect(resetProcessingToPending).toHaveBeenCalledWith(1);
      expect(confirmClaimedMessages).not.toHaveBeenCalled();
      expect(mockStoreObservations).not.toHaveBeenCalled();
    });
  });

  // #3461: drifted XML (<kind>/<detail> for <type>/<title>) is salvaged into
  // rows, but the drifted turn stayed in the conversation and the model kept
  // copying it for the rest of the generation.
  describe('schema drift (#3461)', () => {
    const DRIFTED = '<observation><kind>bugfix</kind><detail>Fixed the retry loop</detail></observation>';
    const CLEAN = '<observation><type>discovery</type><title>Clean reply</title><narrative>ok</narrative></observation>';
    const reply = (session: ActiveSession, text: string) =>
      processAgentResponse(text, session, mockDbManager, mockSessionManager, mockWorker, 0, null, 'TestAgent');

    it('stores the salvaged rows, corrects the drifted turn, and reminds the next prompt', async () => {
      const session = createMockSession();

      await reply(session, DRIFTED);

      expect(mockStoreObservations).toHaveBeenCalledTimes(1);
      const turn = session.conversationHistory.at(-1)!;
      expect(turn.role).toBe('assistant');
      expect(turn.content).toContain('<type>');
      expect(turn.content).not.toContain('<kind>');
      expect(turn.content).not.toContain('<detail>');
      expect(session.observerSchemaReminder).toBe(true);
      expect(session.consecutiveSchemaDrifts).toBe(1);
      expect(session.abortController.signal.aborted).toBe(false);
    });

    it('starts a fresh generation after three drifts in a row; a clean reply resets the count', async () => {
      const session = createMockSession();

      await reply(session, DRIFTED);
      await reply(session, DRIFTED);
      await reply(session, CLEAN);
      expect(session.consecutiveSchemaDrifts).toBe(0);

      await reply(session, DRIFTED);
      await reply(session, DRIFTED);
      expect(session.abortController.signal.aborted).toBe(false);
      await reply(session, DRIFTED);

      expect(session.abortReason).toBe('drift:observer_schema');
      expect(session.abortController.signal.aborted).toBe(true);
      expect(session.consecutiveSchemaDrifts).toBe(0);
    });

    it('restates the schema once, in the next observation prompt', () => {
      const session = createMockSession({ observerSchemaReminder: true });
      expect(takeObserverSchemaReminder(session)).toBe(true);
      expect(takeObserverSchemaReminder(session)).toBe(false);

      const observation = {
        id: 0, tool_name: 'Read', tool_input: '{}', tool_output: '"ok"', created_at_epoch: Date.now(), cwd: '/repo',
      };
      expect(buildObservationPrompt(observation, undefined, true)).toContain(OBSERVATION_SCHEMA_REMINDER);
      expect(buildObservationPrompt(observation)).not.toContain(OBSERVATION_SCHEMA_REMINDER);
    });
  });
});
