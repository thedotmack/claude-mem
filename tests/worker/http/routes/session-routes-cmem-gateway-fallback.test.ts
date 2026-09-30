import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../../../src/shared/SettingsDefaultsManager.js';
import { paths } from '../../../../src/shared/paths.js';
import * as realHookSettings from '../../../../src/shared/hook-settings.js';
import * as realProjectName from '../../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../../src/shared/worker-utils.js';

/**
 * The cmem.ai trial-expiry fallback, end to end on the worker side.
 *
 * When the gateway terminally rejects the delivered key (allowance_exhausted,
 * key_invalid), memory is promised to keep running on the user's Anthropic
 * plan: CLAUDE_MEM_PRO_FALLBACK_AT is written, dispatch returns 'claude', and
 * the next SessionStart shows a one-time "trial ended" notice with the
 * renewal link.
 *
 * Since #3999 the provider pauses on exactly these rejections by aborting the
 * session's controller BEFORE rethrowing, and the generator's .catch in
 * SessionRoutes returns early on an aborted controller — so the fallback was
 * never recorded. This suite drives the REAL OpenRouterProvider (only fetch is
 * faked, as the gateway) through the REAL SessionRoutes and dispatch, so it
 * pins the whole chain rather than a re-implementation of the provider.
 *
 * It also pins the single post-window gateway re-probe: once the fallback
 * window elapses, one session probes the gateway and the rest stay on the
 * Anthropic plan until that probe resolves.
 */

// Snapshot the real namespaces EAGERLY, before the mocks below re-point them,
// so afterAll can reinstall them for every later file in a full-suite run.
const realHookSettingsSnapshot = { ...realHookSettings };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

// The SessionStart hook caches settings for its short-lived process; here it
// must read the file the worker just wrote, so every call loads it fresh.
mock.module('../../../../src/shared/hook-settings.js', () => ({
  ...realHookSettingsSnapshot,
  loadFromFileOnce: () => SettingsDefaultsManager.loadFromFile(paths.settings()),
}));
mock.module('../../../../src/utils/project-name.js', () => ({
  ...realProjectNameSnapshot,
  getProjectContext: () => ({
    primary: 'cmem-fallback-test',
    parent: null,
    isWorktree: false,
    allProjects: ['cmem-fallback-test'],
  }),
}));
mock.module('../../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: async () => 'context from worker',
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

afterAll(() => {
  mock.module('../../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

import { logger } from '../../../../src/utils/logger.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { OpenRouterProvider } from '../../../../src/services/worker/OpenRouterProvider.js';
import {
  CMEM_FALLBACK_RETRY_MS,
  releaseCmemGatewayProbe,
  selectProviderForGenerator,
} from '../../../../src/services/worker/provider-dispatch.js';
import { getQuotaCooldown, resetQuotaCooldownsForTesting } from '../../../../src/shared/quota-cooldown.js';
import { OBSERVER_HEALTH_FILENAME, readObserverHealth } from '../../../../src/shared/observer-health.js';
import { PRO_FALLBACK_NOTICE_MARKER } from '../../../../src/shared/cmem-gateway.js';
import { proTrialUrl } from '../../../../src/shared/pro-promo.js';
import { clearDependencyStatus } from '../../../../src/shared/dependency-health.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

const GATEWAY_BASE_URL = 'https://cmem.ai/api/inference/v1';
const MEMORY_KEY = 'cm_pro_0123456789abcdef01234567';
const FALLBACK_NOTICE = 'memory now runs on your Anthropic plan';

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CMEM_PRO_ORIGIN',
  'OPENROUTER_BASE_URL',
] as const;

const mockMode = {
  name: 'code',
  prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

const settingsPath = paths.settings();
const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
const noticeMarkerPath = join(paths.dataDir(), PRO_FALLBACK_NOTICE_MARKER);

function seedSettings(overrides: Record<string, string> = {}): void {
  writeFileSync(settingsPath, JSON.stringify({
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_BASE_URL: GATEWAY_BASE_URL,
    CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
    CLAUDE_MEM_OPENROUTER_API_KEY: MEMORY_KEY,
    CLAUDE_MEM_PRO_PLAN: 'trial',
    CLAUDE_MEM_PRO_FALLBACK_AT: '',
    ...overrides,
  }, null, 2), 'utf-8');
}

function persistedFallbackAt(): string {
  const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  return String((persisted.env ?? persisted).CLAUDE_MEM_PRO_FALLBACK_AT ?? '');
}

function gatewayRejection(status: number, code: string): Response {
  return new Response(JSON.stringify({
    error: {
      code,
      message: `gateway rejected the key: ${code}`,
      action: 'Subscribe to keep memory off your plan',
      url: 'https://cmem.ai/pro',
      request_id: 'req_cmem_test',
    },
  }), { status, headers: { 'content-type': 'application/json' } });
}

function makeSession(sessionDbId: number): ActiveSession {
  return {
    sessionDbId,
    contentSessionId: `content-${sessionDbId}`,
    // Preset so the provider never needs the database for a synthetic id.
    memorySessionId: `openrouter-content-${sessionDbId}-1`,
    project: 'cmem-fallback-test',
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
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

interface Harness {
  routes: SessionRoutes;
  sessions: Map<number, ActiveSession>;
  claudeAgent: { startSession: ReturnType<typeof mock> };
  completionHandler: { finalizeSession: ReturnType<typeof mock> };
}

let harness: Harness | null = null;

function makeHarness(
  sessionIds: number[],
  openRouterAgentOverride?: { startSession: ReturnType<typeof mock> },
): Harness {
  const sessions = new Map(sessionIds.map(id => [id, makeSession(id)] as const));
  const messageBuffer = {
    getPendingCount: mock(() => 1),
    peekTypes: mock(() => [] as Array<{ message_type: string; tool_name?: string }>),
  };
  const sessionManager = {
    getSession: mock((id: number) => sessions.get(id)),
    getMessageBuffer: mock(() => messageBuffer),
    removeSessionImmediate: mock(() => {}),
    getMessageIterator: async function* () { /* the init query fails first */ },
  };
  const completionHandler = { finalizeSession: mock(() => Promise.resolve()) };
  const claudeAgent = { startSession: mock(() => Promise.resolve()) };
  const geminiAgent = { startSession: mock(() => Promise.resolve()) };
  const openRouterAgent = openRouterAgentOverride
    ?? new OpenRouterProvider({} as any, sessionManager as any);

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any, // dbManager — unused by ensureGeneratorRunning
    claudeAgent as any,
    geminiAgent as any,
    openRouterAgent as any,
    {} as any, // eventBroadcaster
    {} as any, // workerService
    completionHandler as any,
  );
  harness = { routes, sessions, claudeAgent, completionHandler };
  return harness;
}

function session(id: number): ActiveSession {
  const found = harness?.sessions.get(id);
  if (!found) throw new Error(`no session ${id}`);
  return found;
}

/** Let a generator's .catch/.finally chain (handleGeneratorExit) finish. */
async function settle(sessionDbId: number): Promise<void> {
  const pending = session(sessionDbId).generatorPromise;
  if (pending) await pending;
  await new Promise(resolve => setTimeout(resolve, 0));
}

let requests: Array<{ url: string; authorization: string | null }> = [];
let respond: (url: string) => Promise<Response> = async () => {
  throw new Error('unexpected request');
};
let releaseHeldResponses: () => void = () => {};
const realFetch = globalThis.fetch;

function gatewayRequests(): Array<{ url: string; authorization: string | null }> {
  return requests.filter(request => request.url.startsWith(GATEWAY_BASE_URL));
}

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let modeSpy: ReturnType<typeof spyOn> | null = null;
let savedEnv: Record<string, string | undefined> = {};
let savedSettings: string | null = null;
let savedHealth: string | null = null;

/** Number of times the fallback marker was (re)written to settings.json. */
function fallbackRecordings(): number {
  const infoSpy = loggerSpies[0];
  return infoSpy.mock.calls.filter(call => String(call[1]).startsWith('Recorded cmem trial-expiry fallback')).length;
}

function restoreFile(filePath: string, content: string | null): void {
  if (content === null) rmSync(filePath, { force: true });
  else writeFileSync(filePath, content, 'utf-8');
}

// True top level, outside every describe: bun runs afterEach hooks
// inner-first, so this check runs after the describe's own cleanup.
guardSharedQuotaCooldownSingleton('session-routes-cmem-gateway-fallback.test.ts');

describe('SessionRoutes — cmem gateway integrity', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    savedSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : null;
    savedHealth = existsSync(healthPath) ? readFileSync(healthPath, 'utf-8') : null;
    rmSync(healthPath, { force: true });
    rmSync(noticeMarkerPath, { force: true });
    clearDependencyStatus('claude_cli');

    requests = [];
    respond = async () => { throw new Error('unexpected request'); };
    releaseHeldResponses = () => {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return respond(url);
    }) as unknown as typeof fetch;

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
    modeSpy = spyOn(ModeManager, 'getInstance').mockReturnValue({
      getActiveMode: () => mockMode,
    } as unknown as ModeManager);
  });

  afterEach(async () => {
    // Drain every generator this test started — including ones still waiting
    // on a held gateway response — so none of them books state into the next.
    releaseHeldResponses();
    for (const pending of [...(harness?.sessions.values() ?? [])].map(s => s.generatorPromise)) {
      if (pending) await pending.catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    harness = null;

    globalThis.fetch = realFetch;
    loggerSpies.forEach(spy => spy.mockRestore());
    modeSpy?.mockRestore();
    resetQuotaCooldownsForTesting();
    clearDependencyStatus('claude_cli');
    restoreFile(settingsPath, savedSettings);
    restoreFile(healthPath, savedHealth);
    rmSync(noticeMarkerPath, { force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('trial-expiry fallback on a terminal gateway rejection', () => {
    it.each([
      ['allowance_exhausted', 402],
      ['key_invalid', 401],
    ] as const)('%s: records the fallback, books no outage, and the next dispatch runs on claude', async (code, status) => {
      const id = 920001;
      seedSettings();
      respond = async () => gatewayRejection(status, code);
      const { routes, claudeAgent, completionHandler } = makeHarness([id]);

      await routes.ensureGeneratorRunning(id, 'observation');
      await settle(id);

      // The real provider paused on the rejection: it aborted the controller
      // before rethrowing, which is the path that skipped the fallback.
      expect(gatewayRequests()).toHaveLength(1);
      expect(gatewayRequests()[0].authorization).toBe(`Bearer ${MEMORY_KEY}`);
      expect(session(id).abortController.signal.aborted).toBe(true);

      // The fallback marker is written anyway (event-driven, never from dates).
      const fallbackAt = persistedFallbackAt();
      expect(fallbackAt).not.toBe('');
      expect(Math.abs(Date.now() - Date.parse(fallbackAt))).toBeLessThan(60_000);

      // A fallback is not an outage: no 30-minute provider breaker stacked on
      // the marker's own window, and nothing booked into the health ledger.
      expect(getQuotaCooldown('openrouter')).toBeNull();
      expect(readObserverHealth()?.consecutiveFailures ?? 0).toBe(0);
      expect(readObserverHealth()?.quotaCooldown ?? null).toBeNull();

      // Paused, not torn down: the buffered batch waits for the fallback.
      expect(completionHandler.finalizeSession).not.toHaveBeenCalled();

      // The next captured event dispatches to the Anthropic plan, and the
      // gateway is not asked again inside the window.
      expect(selectProviderForGenerator().provider).toBe('claude');
      await routes.ensureGeneratorRunning(id, 'observation');
      expect(claudeAgent.startSession).toHaveBeenCalledTimes(1);
      expect(gatewayRequests()).toHaveLength(1);
    });

    it('shows the one-time trial-ended notice with the renewal link at the next SessionStart', async () => {
      const id = 920002;
      seedSettings();
      respond = async () => gatewayRejection(402, 'allowance_exhausted');
      const { routes } = makeHarness([id]);

      await routes.ensureGeneratorRunning(id, 'observation');
      await settle(id);

      const { contextHandler } = await import('../../../../src/cli/handlers/context.js');
      const hookInput = { sessionId: 'session-start-after-fallback', cwd: process.cwd(), platform: 'claude-code' as const };

      const first = await contextHandler.execute(hookInput);
      const firstContext = first.hookSpecificOutput?.additionalContext ?? '';
      expect(firstContext).toContain('Your claude-mem free trial ended');
      expect(firstContext).toContain(FALLBACK_NOTICE);
      expect(firstContext).toContain(proTrialUrl('fallback'));
      expect(firstContext).toContain('context from worker');

      // Once: the notice marker suppresses it on the following session.
      const second = await contextHandler.execute(hookInput);
      expect(second.hookSpecificOutput?.additionalContext ?? '').not.toContain(FALLBACK_NOTICE);
    });

    it('keeps a personal openrouter.ai key on the outage path: breaker and ledger, never the marker', async () => {
      const id = 920003;
      seedSettings({
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_OPENROUTER_MODEL: 'some/model',
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-personal-test-key',
      });
      respond = async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 });
      const { routes } = makeHarness([id]);

      await routes.ensureGeneratorRunning(id, 'observation');
      await settle(id);

      expect(requests.filter(request => request.url.startsWith('https://openrouter.ai/'))).toHaveLength(1);
      expect(persistedFallbackAt()).toBe('');
      expect(getQuotaCooldown('openrouter')).not.toBeNull();
      expect(readObserverHealth()?.consecutiveFailures).toBe(1);
    });

    it('never records the fallback for an externally aborted generator', async () => {
      const id = 920004;
      seedSettings();
      const abortedAgent = {
        startSession: mock((s: ActiveSession) => {
          // Idle/shutdown abort: no classified gateway error, no preserving reason.
          s.abortController.abort();
          return Promise.reject(new Error('aborted'));
        }),
      };
      const { routes } = makeHarness([id], abortedAgent);

      await routes.ensureGeneratorRunning(id, 'observation');
      await settle(id);

      expect(abortedAgent.startSession).toHaveBeenCalledTimes(1);
      expect(persistedFallbackAt()).toBe('');
    });
  });

  describe('the single gateway re-probe after the fallback window', () => {
    it('admits exactly one of N concurrent sessions to the gateway; its failure re-arms the marker once', async () => {
      const ids = [921001, 921002, 921003, 921004, 921005];
      const elapsedFallbackAt = new Date(Date.now() - CMEM_FALLBACK_RETRY_MS - 60_000).toISOString();
      seedSettings({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt });

      // Hold the gateway's answer so every session decides while the probe is
      // still in flight — the herd the claim exists to stop.
      const held = new Promise<void>(resolve => { releaseHeldResponses = resolve; });
      respond = async () => {
        await held;
        return gatewayRejection(402, 'allowance_exhausted');
      };
      const { routes, claudeAgent } = makeHarness(ids);

      await Promise.all(ids.map(id => routes.ensureGeneratorRunning(id, 'observation')));

      const probing = ids.filter(id => session(id).currentProvider === 'openrouter');
      expect(probing).toHaveLength(1);
      expect(claudeAgent.startSession).toHaveBeenCalledTimes(ids.length - 1);

      const probe = session(probing[0]).generatorPromise;
      releaseHeldResponses();
      await probe;
      await new Promise(resolve => setTimeout(resolve, 0));

      // One gateway request, one settings.json rewrite — not one per session.
      expect(gatewayRequests()).toHaveLength(1);
      expect(fallbackRecordings()).toBe(1);
      expect(Date.parse(persistedFallbackAt())).toBeGreaterThan(Date.parse(elapsedFallbackAt));

      // The failed probe released its claim and restarted the window.
      const next = selectProviderForGenerator();
      releaseCmemGatewayProbe(next.gatewayProbeClaimId);
      expect(next.provider).toBe('claude');
    });
  });
});
