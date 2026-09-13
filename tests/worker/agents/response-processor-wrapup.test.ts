import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

// Capture real exports before mock.module mutates the live namespace, then
// restore them after this focused harness so its stubs do not leak to later
// response-processor tests.
import * as realWorkerServiceModule from '../../../src/services/worker-service.js';
import * as realWorkerUtilsModule from '../../../src/shared/worker-utils.js';
import * as realModeManagerModule from '../../../src/services/domain/ModeManager.js';
import * as realSettingsDefaultsModule from '../../../src/shared/SettingsDefaultsManager.js';
import * as realTelegramWrapupNotifierModule from '../../../src/services/integrations/TelegramWrapupNotifier.js';

const realWorkerServiceSnapshot = { ...realWorkerServiceModule };
const realWorkerUtilsSnapshot = { ...realWorkerUtilsModule };
const realModeManagerSnapshot = { ...realModeManagerModule };
const realSettingsDefaultsSnapshot = { ...realSettingsDefaultsModule };
const realTelegramWrapupNotifierSnapshot = { ...realTelegramWrapupNotifierModule };
const formatSummary = mock(async () => '• Completed the session');
const deliverSessionWrapup = mock(async () => 'sent' as const);

mock.module('../../../src/services/worker-service.js', () => ({
  ...realWorkerServiceSnapshot,
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  getWorkerPort: () => 37777,
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  ...realSettingsDefaultsSnapshot,
  SettingsDefaultsManager: {
    loadFromFile: () => ({
      CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
      CLAUDE_MEM_TELEGRAM_ENABLED: 'false',
      CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: 'false',
    }),
  },
}));

mock.module('../../../src/services/domain/ModeManager.js', () => ({
  ...realModeManagerSnapshot,
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {
          init: 'init prompt',
          observation: 'observation prompt',
          summary: 'summary prompt',
        },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
    }),
  },
}));

mock.module('../../../src/services/integrations/TelegramWrapupNotifier.js', () => ({
  ...realTelegramWrapupNotifierSnapshot,
  deliverSessionWrapup,
}));

import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import type { StorageResult } from '../../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../../src/services/worker-types.js';

afterAll(() => {
  mock.module('../../../src/services/worker-service.js', () => realWorkerServiceSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsDefaultsSnapshot);
  mock.module('../../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
  mock.module('../../../src/services/integrations/TelegramWrapupNotifier.js', () => realTelegramWrapupNotifierSnapshot);
});

function createSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 42,
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
    earliestPendingTimestamp: Date.now() - 10_000,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: 'claude',
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    ...overrides,
  } as ActiveSession;
}

function createDbManager(result: StorageResult): DatabaseManager {
  const sessionStore = {
    ensureMemorySessionIdRegistered: () => 'memory-session-456',
    getSessionById: () => ({ memory_session_id: 'memory-session-456' }),
    storeObservations: mock(() => result),
  };
  return {
    getSessionStore: () => sessionStore,
    getChromaSync: () => null,
    getCloudSync: () => null,
  } as unknown as DatabaseManager;
}

function createSessionManager(session: ActiveSession, dbManager: DatabaseManager): SessionManager {
  const manager = new SessionManager(dbManager);
  manager.setTelegramWrapupFormatter(formatSummary);
  spyOn(manager, 'getSession').mockReturnValue(session);
  spyOn(manager, 'getClaimedMessages').mockReturnValue([]);
  spyOn(manager, 'confirmClaimedMessages').mockResolvedValue(0);
  return manager;
}

const observationResponse = `
  <observation>
    <type>discovery</type>
    <title>Observation only</title>
    <facts></facts>
    <concepts></concepts>
    <files_read></files_read>
    <files_modified></files_modified>
  </observation>
`;

const summaryResponse = `
  <summary>
    <request>Deliver after the summary lands</request>
    <investigated>Response processor</investigated>
    <learned>The durable claim resolves delivery races</learned>
    <completed>Stored a summary</completed>
    <next_steps>Send the wrap-up</next_steps>
  </summary>
`;

function flushBackgroundWork(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('ResponseProcessor Telegram wrap-up delivery', () => {
  let loggerSpies: ReturnType<typeof spyOn>[];
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    deliverSessionWrapup.mockClear();
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      warnSpy,
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('does not deliver an observation-only response when wrap-up is requested', async () => {
    const session = createSession({ telegramWrapupRequestedAt: Date.now() });
    const dbManager = createDbManager({ observationIds: [1], summaryId: null, createdAtEpoch: 1_700_000_000_000 });

    await processAgentResponse(
      observationResponse,
      session,
      dbManager,
      createSessionManager(session, dbManager),
      undefined,
      100,
      null,
      'TestAgent',
    );

    expect(deliverSessionWrapup).not.toHaveBeenCalled();
  });

  it('stores a Stop summary without delivering before SessionEnd', async () => {
    const session = createSession();
    const dbManager = createDbManager({ observationIds: [], summaryId: 99, createdAtEpoch: 1_700_000_000_000 });

    await processAgentResponse(
      summaryResponse,
      session,
      dbManager,
      createSessionManager(session, dbManager),
      undefined,
      100,
      null,
      'TestAgent',
    );

    expect(deliverSessionWrapup).not.toHaveBeenCalled();
  });

  it('delivers once after a requested wrap-up summary is stored, including timestamp zero', async () => {
    const session = createSession({ telegramWrapupRequestedAt: 0 });
    const dbManager = createDbManager({ observationIds: [], summaryId: 99, createdAtEpoch: 1_700_000_000_000 });

    await processAgentResponse(
      summaryResponse,
      session,
      dbManager,
      createSessionManager(session, dbManager),
      undefined,
      100,
      null,
      'TestAgent',
    );

    expect(deliverSessionWrapup).toHaveBeenCalledTimes(1);
    expect(deliverSessionWrapup).toHaveBeenCalledWith({
      sessionStore: dbManager.getSessionStore(),
      sessionDbId: session.sessionDbId,
      formatSummary,
    });
  });

  it('handles a rejected background delivery without rejecting response processing', async () => {
    const session = createSession({ telegramWrapupRequestedAt: Date.now() });
    const dbManager = createDbManager({ observationIds: [], summaryId: 99, createdAtEpoch: 1_700_000_000_000 });
    const error = new Error('wrap-up delivery failed');
    deliverSessionWrapup.mockImplementationOnce(async () => {
      throw error;
    });

    await expect(processAgentResponse(
      summaryResponse,
      session,
      dbManager,
      createSessionManager(session, dbManager),
      undefined,
      100,
      null,
      'TestAgent',
    )).resolves.toBeUndefined();
    await flushBackgroundWork();

    expect(warnSpy).toHaveBeenCalledWith(
      'TELEGRAM',
      'Failed to deliver Telegram session wrap-up from SessionManager',
      { sessionId: session.sessionDbId },
      error,
    );
  });
});
