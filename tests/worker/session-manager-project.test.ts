import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { StorageResult, WorkerRef } from '../../src/services/worker/agents/types.js';

mock.module('../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: { init: 'init', observation: 'observation', summary: 'summary' },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
    }),
  },
}));

const durableSessionTemplate = {
  content_session_id: 'content-123',
  project: 'repo-a',
  platform_source: 'claude',
  user_prompt: 'prompt 1',
  memory_session_id: 'memory-123',
};

function makeDbManager(storeObservations = mock(() => ({
  observationIds: [1],
  summaryId: null,
  createdAtEpoch: 1700000000000,
} as StorageResult)), project = 'repo-a'): DatabaseManager {
  return {
    getSessionById: () => ({
      ...durableSessionTemplate,
      project,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations,
    }),
    getChromaSync: () => ({ syncObservation: mock(() => Promise.resolve()) }),
    getCloudSync: () => null,
  } as unknown as DatabaseManager;
}

function initializeWithProject(
  sessionManager: SessionManager,
  sessionDbId: number,
  prompt: string,
  promptNumber: number,
  project: string,
): ActiveSession {
  const initialize = sessionManager.initializeSession as unknown as (
    id: number,
    currentPrompt: string,
    number: number,
    currentProject: string,
  ) => ActiveSession;
  return initialize.call(sessionManager, sessionDbId, prompt, promptNumber, project);
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('SessionManager prompt project attribution', () => {
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('uses the prompt project when a new active session is created cold', () => {
    const dbManager = makeDbManager();
    const sessionManager = new SessionManager(dbManager);
    const session = initializeWithProject(sessionManager, 1, 'prompt 1', 1, 'repo-b/worktree');

    expect(session.project).toBe('repo-b/worktree');
    expect(dbManager.getSessionById(1).project).toBe('repo-a');
  });

  it('attributes a prompt-2 observation to its current project and preserves durable identity', async () => {
    const storeObservations = mock(() => ({
      observationIds: [1],
      summaryId: null,
      createdAtEpoch: 1700000000000,
    } as StorageResult));
    const dbManager = makeDbManager(storeObservations);
    const sessionManager = new SessionManager(dbManager);
    sessionManager.initializeSession(1, 'prompt 1', 1);

    const session = initializeWithProject(sessionManager, 1, 'prompt 2', 2, 'repo-b/worktree');
    await processAgentResponse(
      `<observation><type>discovery</type><title>Prompt 2</title><narrative>Valid observation</narrative><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>`,
      { ...session, memorySessionId: 'memory-123' },
      dbManager,
      sessionManager,
      { sseBroadcaster: { broadcast: mock(() => {}) } } as unknown as WorkerRef,
      10,
      null,
      'TestAgent',
    );

    expect(session.project).toBe('repo-b/worktree');
    expect(storeObservations.mock.calls[0][1]).toBe('repo-b/worktree');
    expect(dbManager.getSessionById(1).project).toBe('repo-a');
  });

  it('keeps the same non-placeholder project across prompt continuation', () => {
    const sessionManager = new SessionManager(makeDbManager(undefined, 'repo-b/worktree'));
    const firstPrompt = sessionManager.initializeSession(1, 'prompt 1', 1);
    expect(firstPrompt.project).toBe('repo-b/worktree');

    const secondPrompt = initializeWithProject(sessionManager, 1, 'prompt 2', 2, 'repo-b/worktree');
    expect(secondPrompt.project).toBe('repo-b/worktree');
  });

  it.each([undefined, '', 'unknown'])(
    'uses the durable project as fallback for %s current project input',
    (project) => {
      const sessionManager = new SessionManager(makeDbManager());
      sessionManager.initializeSession(1, 'prompt 1', 1);
      const session = initializeWithProject(sessionManager, 1, 'prompt 2', 2, project as string);
      expect(session.project).toBe('repo-a');
    },
  );
});
