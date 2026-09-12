import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { logger } from '../../../../src/utils/logger.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { classifyOpenRouterError } from '../../../../src/services/worker/OpenRouterProvider.js';
import { paths } from '../../../../src/shared/paths.js';
import { clearQuotaCooldown, getQuotaCooldown } from '../../../../src/shared/quota-cooldown.js';
import { recordObserverSuccess } from '../../../../src/shared/observer-health.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import type { ActiveSession, ConversationMessage } from '../../../../src/services/worker-types.js';

/**
 * The trial-expiry fallback marker must be recorded even though the provider
 * PAUSES the session for definitive gateway stops.
 *
 * Since #3999, OpenAICompatibleProvider.handleSessionError maps a classified
 * quota/auth failure onto a preserving abortReason and aborts the session's
 * controller BEFORE rethrowing — so SessionRoutes' generator .catch sees
 * `myController.signal.aborted === true` and early-returns. A
 * recordCmemFallbackIfEligible call placed after that early-return never runs
 * for a thrown cmem-gateway rejection, the marker is never written, and
 * dispatch keeps pointing at the exhausted gateway instead of the fallback
 * provider the installer promised. This suite pins the fix (the marker write
 * is hoisted above the early-return) and the pause semantics around it:
 * the batch stays buffered (no finalize/remove) while the switch happens.
 */

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CMEM_PRO_ORIGIN',
] as const;

function makeFakeSession(sessionDbId: number): ActiveSession {
  return {
    sessionDbId,
    contentSessionId: `content-${sessionDbId}`,
    memorySessionId: null,
    project: 'test-project',
    platformSource: 'claude-code',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [{ role: 'user', content: 'hello' }] as ConversationMessage[],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

function makeRoutes(session: ActiveSession, openRouterAgent: { startSession: ReturnType<typeof mock> }) {
  const messageBuffer = {
    getPendingCount: mock(() => 1),
    peekTypes: mock(() => [] as Array<{ message_type: string; tool_name?: string }>),
  };
  const sessionManager = {
    getSession: mock((id: number) => (id === session.sessionDbId ? session : undefined)),
    getMessageBuffer: mock(() => messageBuffer),
    removeSessionImmediate: mock(() => {}),
  };
  const completionHandler = {
    finalizeSession: mock(() => Promise.resolve()),
  };
  const inertAgent = { startSession: mock(() => Promise.resolve()) };

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any, // dbManager — unused by ensureGeneratorRunning
    inertAgent as any,
    inertAgent as any,
    openRouterAgent as any,
    {} as any, // eventBroadcaster — unused by ensureGeneratorRunning
    {} as any, // workerService
    completionHandler as any,
  );

  return { routes, sessionManager, completionHandler };
}

guardSharedQuotaCooldownSingleton('session-routes-cmem-fallback-marker.test.ts');

describe('SessionRoutes — cmem trial-expiry fallback marker on a paused gateway stop', () => {
  let savedEnv: Record<string, string | undefined>;
  let savedSettingsFile: string | null;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  const settingsPath = paths.settings();

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // The marker is written into the per-run temp settings.json — snapshot it
    // so this test cannot leak CLAUDE_MEM_PRO_FALLBACK_AT into later files.
    savedSettingsFile = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : null;

    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-test-key';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://cmem.ai/api/inference/v1';
    process.env.CLAUDE_MEM_PRO_FALLBACK_AT = '';

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (savedSettingsFile === null) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, savedSettingsFile, 'utf-8');
    // The paused exit arms the real (persisted) openrouter breaker; clear it
    // and the observer-health failure it recorded.
    clearQuotaCooldown('openrouter');
    recordObserverSuccess();
  });

  it('writes the marker and preserves the session when the gateway stop pauses via abort (#3999 shape)', async () => {
    const session = makeFakeSession(910001);
    const gatewayStop = classifyOpenRouterError({
      status: 402,
      bodyText: JSON.stringify({ error: { code: 'allowance_exhausted', message: 'allowance exhausted' } }),
      cause: new Error('upstream 402'),
    });
    expect(gatewayStop.kind).toBe('quota_exhausted');

    // Mirrors OpenAICompatibleProvider.handleSessionError for a definitive
    // stop: label the pause, abort the controller, THEN reject.
    const openRouterAgent = {
      startSession: mock((s: ActiveSession) => {
        s.abortReason = 'quota:quota_exhausted';
        s.abortController.abort();
        return Promise.reject(gatewayStop);
      }),
    };
    const { routes, sessionManager, completionHandler } = makeRoutes(session, openRouterAgent);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'test');
    const generatorPromise = session.generatorPromise;
    if (generatorPromise) await generatorPromise;
    // The .finally chain (handleGeneratorExit) runs async — let it settle.
    await new Promise(resolve => setTimeout(resolve, 20));

    // The fallback marker was recorded despite the aborted controller.
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const marker = (persisted.env ?? persisted).CLAUDE_MEM_PRO_FALLBACK_AT;
    expect(typeof marker).toBe('string');
    expect(marker).not.toBe('');
    expect(Number.isNaN(Date.parse(marker))).toBe(false);

    // Pause, not teardown: the buffered batch survives for the fallback
    // provider's fresh generator.
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();

    // The quota breaker armed too (the finally's quota accounting) — that is
    // what holds dispatch when the fallback choice is 'none'.
    expect(getQuotaCooldown('openrouter')).not.toBeNull();
  });

  it('never writes the marker for an externally aborted generator (idle/shutdown)', async () => {
    const session = makeFakeSession(910002);
    const openRouterAgent = {
      startSession: mock((s: ActiveSession) => {
        // An external abort rejects WITHOUT a classified gateway error and
        // without a preserving reason — e.g. the idle monitor.
        s.abortController.abort();
        return Promise.reject(new Error('aborted'));
      }),
    };
    const { routes } = makeRoutes(session, openRouterAgent);

    await routes.ensureGeneratorRunning(session.sessionDbId, 'test');
    const generatorPromise = session.generatorPromise;
    if (generatorPromise) await generatorPromise;
    await new Promise(resolve => setTimeout(resolve, 20));

    const marker = existsSync(settingsPath)
      ? ((JSON.parse(readFileSync(settingsPath, 'utf-8')).env ?? JSON.parse(readFileSync(settingsPath, 'utf-8'))).CLAUDE_MEM_PRO_FALLBACK_AT ?? '')
      : '';
    expect(marker).toBe('');
  });
});
