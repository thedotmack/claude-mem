import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { isClassified } from '../../src/services/worker/provider-errors.js';

/**
 * When the agent SDK spawns the resolved executable itself (the standalone
 * observer calls pass no cmd.exe wrapper), a missing binary (ENOENT) or a
 * Windows .cmd/.bat shim it cannot launch (EINVAL) is thrown from the query
 * loop. startSession must run that raw spawn error through classifyClaudeError
 * so a setup failure surfaces as `setup_required` instead of reaching
 * SessionRoutes unclassified and being retried on every later observation.
 *
 * bun's mock.module is process-global and sticky: snapshot each real module
 * and restore it in afterAll so these stubs never leak into later suites.
 */
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };
const actualProcessRegistry = { ...(await import('../../src/supervisor/process-registry.js')) };
const actualModeManager = { ...(await import('../../src/services/domain/ModeManager.js')) };

let scriptedError: unknown = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...actualAgentSdk,
  query: () => (async function* () {
    if (scriptedError) throw scriptedError;
  })(),
}));

mock.module('../../src/shared/find-claude-executable.js', () => ({
  ...actualFindClaude,
  findClaudeExecutable: () => '/mock/codex.cmd',
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnvManager,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH ?? '' }),
  getAuthMethodDescription: () => 'test-auth',
}));

mock.module('../../src/supervisor/process-registry.js', () => ({
  ...actualProcessRegistry,
  waitForSlot: async () => ({ release: () => {} }),
  createSdkSpawnFactory: () => () => {
    throw new Error('spawn factory must not run in this test');
  },
  getSdkProcessForSession: () => undefined,
  ensureSdkProcessExit: async () => {},
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ...actualModeManager,
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
    }),
  },
}));

afterAll(() => {
  mock.module('../../src/services/domain/ModeManager.js', () => actualModeManager);
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualAgentSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnvManager);
  mock.module('../../src/supervisor/process-registry.js', () => actualProcessRegistry);
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

function createSession(): ActiveSession {
  return {
    sessionDbId: 7788,
    contentSessionId: 'content-7788',
    memorySessionId: null,
    project: 'observer-project',
    platformSource: 'claude',
    userPrompt: 'run the project',
    // modelOverride avoids reading a model from settings on disk.
    modelOverride: 'claude-sonnet-test',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 2,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

function createProvider() {
  const sessionManager = {
    getMessageIterator: async function* () {},
    resetProcessingToPending: async () => 0,
    confirmClaimedMessages: async () => 0,
  };
  const dbManager = {
    getSessionStore: () => ({ ensureMemorySessionIdRegistered: () => {} }),
  };
  return new ClaudeProvider(dbManager as never, sessionManager as never);
}

describe('ClaudeProvider startSession spawn-error classification', () => {
  beforeEach(() => {
    scriptedError = null;
  });

  it('classifies a Windows .cmd shim EINVAL from the SDK spawn as setup_required', async () => {
    scriptedError = Object.assign(new Error('spawn /mock/codex.cmd EINVAL'), { code: 'EINVAL' });
    const provider = createProvider();

    let thrown: unknown;
    try {
      await provider.startSession(createSession());
    } catch (error) {
      thrown = error;
    }

    expect(isClassified(thrown)).toBe(true);
    expect((thrown as { kind: string }).kind).toBe('setup_required');
  });

  it('classifies an ENOENT from the SDK spawn as setup_required', async () => {
    scriptedError = Object.assign(new Error("spawn 'codex' ENOENT"), { code: 'ENOENT' });
    const provider = createProvider();

    let thrown: unknown;
    try {
      await provider.startSession(createSession());
    } catch (error) {
      thrown = error;
    }

    expect(isClassified(thrown)).toBe(true);
    expect((thrown as { kind: string }).kind).toBe('setup_required');
  });

  it('leaves a non-setup error unclassified so genuine failures keep their shape', async () => {
    scriptedError = new Error('ECONNRESET: socket hang up');
    const provider = createProvider();

    let thrown: unknown;
    try {
      await provider.startSession(createSession());
    } catch (error) {
      thrown = error;
    }

    expect(isClassified(thrown)).toBe(false);
    expect((thrown as Error).message).toContain('ECONNRESET');
  });
});
