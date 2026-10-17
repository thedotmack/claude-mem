// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { ActiveSession } from '../../../../src/services/worker-types.js';
import { OpenRouterProvider, classifyOpenRouterError } from '../../../../src/services/worker/OpenRouterProvider.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import { SessionManager } from '../../../../src/services/worker/SessionManager.js';
import { resetQuotaCooldownsForTesting } from '../../../../src/shared/quota-cooldown.js';
import { resetDependencyStatusesForTesting } from '../../../../src/shared/dependency-health.js';
import { logger } from '../../../../src/utils/logger.js';
import * as realProviderDispatch from '../../../../src/services/worker/provider-dispatch.js';

// Wave 3 gate R4-13: #4115 names the code and host when a request gets no
// response, and for an address on the local network adds the likely fix (on
// macOS, the Local Network permission). A request that never completes pauses
// the observer with its work kept, and that pause was logged only at DEBUG, so
// at the default level the hint never reached the user.

const providerDispatchSnapshot = { ...realProviderDispatch };
mock.module('../../../../src/services/worker/provider-dispatch.js', () => ({
  ...providerDispatchSnapshot,
  selectProviderForGenerator: () => ({ provider: 'openrouter', gatewayProbeClaimId: null }),
  getSelectedProvider: () => 'openrouter',
}));

const { SessionRoutes } = await import('../../../../src/services/worker/http/routes/SessionRoutes.js');

const PAUSE_LINE = 'Observer paused on a transient provider failure; buffered work kept';

function makeSession(): ActiveSession {
  return {
    sessionDbId: 4115,
    contentSessionId: 'content-4115',
    memorySessionId: 'memory-4115',
    project: 'test-project',
    platformSource: 'claude',
    userPrompt: 'last prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

/** Runs one generator whose observation request never gets a response from `apiUrl`. */
async function pauseOnUnreachable(apiUrl: string): Promise<void> {
  const session = makeSession();
  const sessionManager = new SessionManager({} as never, {
    setTimeout: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  (sessionManager as unknown as { sessions: Map<number, ActiveSession> }).sessions.set(session.sessionDbId, session);
  sessionManager.getMessageBuffer().enqueue(session.sessionDbId, {
    type: 'observation',
    tool_name: 'Read',
    tool_input: '{"file_path":"notes.txt"}',
    tool_response: 'content',
    prompt_number: 1,
  });

  class UnreachableProvider extends OpenRouterProvider {
    protected override getConfig() {
      return { apiKey: 'test-key', model: 'test-model', apiUrl };
    }

    protected override async query(): Promise<{ content: string }> {
      const cause = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' });
      throw classifyOpenRouterError({ cause, requestUrl: apiUrl });
    }
  }

  const routes = new SessionRoutes(
    sessionManager,
    {} as never,
    { startSession: async () => {} } as never,
    { startSession: async () => {} } as never,
    new UnreachableProvider({} as never, sessionManager),
    {} as never,
    {} as never,
    { finalizeSession: async () => {} } as never,
  );
  await routes.ensureGeneratorRunning(session.sessionDbId, 'summarize');
  await session.generatorPromise;
}

describe('a provider that cannot be reached', () => {
  let warn: ReturnType<typeof spyOn>;
  let debug: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
    ModeManager.getInstance().loadMode('code');
    warn = spyOn(logger, 'warn');
    debug = spyOn(logger, 'debug');
  });

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
    resetQuotaCooldownsForTesting();
    resetDependencyStatusesForTesting();
  });

  afterAll(() => {
    mock.module('../../../../src/services/worker/provider-dispatch.js', () => providerDispatchSnapshot);
  });

  const pauseCalls = (spy: ReturnType<typeof spyOn>) =>
    spy.mock.calls.filter(call => call[0] === 'SESSION' && call[1] === PAUSE_LINE);

  it('logs the local-network hint at warn, where the user sees it', async () => {
    await pauseOnUnreachable('http://192.168.1.20:11434/v1/chat/completions');

    const lines = pauseCalls(warn);
    expect(lines).toHaveLength(1);
    expect(String(lines[0][3])).toContain('ConnectionRefused, reaching 192.168.1.20:11434');
    expect(String(lines[0][3])).toContain('Privacy & Security > Local Network');
  });

  it('keeps a plain network blip at debug', async () => {
    await pauseOnUnreachable('https://openrouter.ai/api/v1/chat/completions');

    expect(pauseCalls(warn)).toHaveLength(0);
    expect(pauseCalls(debug)).toHaveLength(1);
  });
});
