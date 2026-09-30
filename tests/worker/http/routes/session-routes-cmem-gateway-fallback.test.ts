import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../../../src/shared/SettingsDefaultsManager.js';
import { paths } from '../../../../src/shared/paths.js';
import * as realHookSettings from '../../../../src/shared/hook-settings.js';
import * as realProjectName from '../../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../../src/shared/worker-utils.js';

/**
 * The cmem.ai gateway path through the worker, end to end.
 *
 * The gateway classifies once and sends `{code, message, action, url,
 * request_id}` (plans/2026-08-16-observer-error-path.md §1.2). Each code has
 * one outcome here:
 *   - allowance_exhausted / key_invalid / subscription_inactive: the
 *     trial-expiry fallback. Memory moves to the Anthropic plan at once, and
 *     the next SessionStart relays the gateway's own words and link (paid users
 *     at their monthly cap get allowance_exhausted too, so it must never claim
 *     a trial ended; a lapsed or cancelled trial gets subscription_inactive).
 *   - rate_limited: retryable. Never a spent allowance, never the 30-minute
 *     breaker; the session resumes once Retry-After has passed.
 * While a fallback is active, the single post-window re-probe that fails for
 * any reason keeps memory on Claude. A refused credential off the gateway is
 * booked with its detail and cooled down, never hammered once per event.
 *
 * Since #3999 the provider pauses on a classified error by aborting the
 * session's controller BEFORE rethrowing, so SessionRoutes must book those
 * errors even though the controller is aborted. This suite drives the REAL
 * OpenRouterProvider (only fetch is faked, as the gateway) through the REAL
 * SessionRoutes and dispatch, so it pins the whole chain rather than a
 * re-implementation of the provider.
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
  getCmemGatewayProbeClaim,
  releaseCmemGatewayProbe,
  resetCmemGatewayProbeForTesting,
  selectProviderForGenerator,
} from '../../../../src/services/worker/provider-dispatch.js';
import {
  getQuotaCooldown,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../../../src/shared/quota-cooldown.js';
import { OBSERVER_HEALTH_FILENAME, readObserverHealth } from '../../../../src/shared/observer-health.js';
import { observerHealthWarning } from '../../../../src/services/context/ContextBuilder.js';
import { PRO_FALLBACK_NOTICE_MARKER } from '../../../../src/shared/cmem-gateway.js';
import { proTrialUrl } from '../../../../src/shared/pro-promo.js';
import { clearDependencyStatus } from '../../../../src/shared/dependency-health.js';
import { telemetryBuffer } from '../../../../src/services/telemetry/buffer.js';
import { getProcessRegistry, isSessionParkedForSlot, waitForSlot } from '../../../../src/supervisor/process-registry.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import { guardSharedProcessRegistrySingleton } from '../../../supervisor/process-registry-singleton-guard.js';
import type { ActiveSession } from '../../../../src/services/worker-types.js';

const GATEWAY_BASE_URL = 'https://cmem.ai/api/inference/v1';
const MEMORY_KEY = 'cm_pro_0123456789abcdef01234567';
const ON_ANTHROPIC_PLAN = 'Memory is using your Anthropic plan for now.';

/** The gateway's own copy (plans/2026-08-16-observer-error-path.md §1.2). */
const GATEWAY = {
  allowance_exhausted: {
    status: 402,
    message: "You've used your $30 CMEM Pro inference allowance for this billing cycle.",
    action: 'It resets at the start of your next billing cycle. Need more before then? Email support@cmem.ai.',
    url: 'https://cmem.ai/dashboard',
  },
  key_invalid: {
    status: 401,
    message: "This CMEM Pro key isn't recognized.",
    action: 'Run `npx claude-mem pro-setup` to re-link this machine, or copy a fresh key from your dashboard.',
    url: 'https://cmem.ai/dashboard',
  },
  subscription_inactive: {
    status: 402,
    message: "Your CMEM Pro payment didn't go through, so the observer is paused.",
    action: 'Update your card in the dashboard and observations resume immediately.',
    url: 'https://cmem.ai/dashboard',
  },
  rate_limited: {
    status: 429,
    message: 'Too many observer requests in the last minute.',
    action: 'Retrying automatically in 60s — nothing to do.',
  },
  upstream_unavailable: {
    status: 503,
    message: 'The observer model is temporarily unavailable.',
    action: 'claude-mem retries automatically. If this lasts more than an hour, email support@cmem.ai with the request id.',
  },
  bad_request: {
    status: 400,
    message: "The observer sent a request the gateway couldn't parse.",
    action: 'This is a claude-mem bug — please open an issue with the request id.',
    url: 'https://github.com/thedotmack/claude-mem/issues',
  },
} as const;
type GatewayCode = keyof typeof GATEWAY;

function gatewayRejection(code: GatewayCode, headers: Record<string, string> = {}): Response {
  const { status, ...copy } = GATEWAY[code];
  return new Response(JSON.stringify({ error: { code, ...copy, request_id: `req_${code}` } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CLAUDE_MEM_PRO_FALLBACK_MESSAGE',
  'CLAUDE_MEM_PRO_FALLBACK_URL',
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

function persistedSettings(): Record<string, string> {
  const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  return persisted.env ?? persisted;
}

function persistedFallbackAt(): string {
  return String(persistedSettings().CLAUDE_MEM_PRO_FALLBACK_AT ?? '');
}

function elapsedFallbackAt(): string {
  return new Date(Date.now() - CMEM_FALLBACK_RETRY_MS - 60_000).toISOString();
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
/** Claude generators stay running (like a real one) until the test ends them. */
let claudeRuns: Array<() => void> = [];

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
    getMessageIterator: async function* () { /* the init query settles every run here */ },
  };
  const completionHandler = { finalizeSession: mock(() => Promise.resolve()) };
  const claudeAgent = {
    startSession: mock(() => new Promise<void>(resolve => { claudeRuns.push(resolve); })),
  };
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

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
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

/** Number of times the fallback marker was written to settings.json. */
function fallbackRecordings(): number {
  const infoSpy = loggerSpies[0];
  return infoSpy.mock.calls.filter(call => String(call[1]).startsWith('Recorded cmem trial-expiry fallback')).length;
}

function restoreFile(filePath: string, content: string | null): void {
  if (content === null) rmSync(filePath, { force: true });
  else writeFileSync(filePath, content, 'utf-8');
}

const registry = getProcessRegistry();
const registeredIds: string[] = [];

/** Fill the (limit=1) observer pool so a waitForSlot call parks. */
function registerFakeOccupant(sessionId: string): void {
  const id = `sdk:cmem-gateway-test-${sessionId}:${Math.random().toString(36).slice(2)}`;
  registry.register(id, { pid: process.pid, type: 'sdk', sessionId, startedAt: new Date().toISOString() });
  registeredIds.push(id);
}

// True top level, outside every describe: bun runs afterEach hooks
// inner-first, so these checks run after the describe's own cleanup.
guardSharedQuotaCooldownSingleton('session-routes-cmem-gateway-fallback.test.ts');
guardSharedProcessRegistrySingleton('session-routes-cmem-gateway-fallback.test.ts');

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
    claudeRuns = [];
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
    // End everything this test started — held gateway answers, running Claude
    // generators, and any resume the routes scheduled on their own — before
    // restoring state, so nothing books into the next test.
    respond = async () => gatewayRejection('bad_request');
    releaseHeldResponses();
    for (let round = 0; round < 10; round++) {
      claudeRuns.splice(0).forEach(finish => finish());
      const running = [...(harness?.sessions.values() ?? [])]
        .map(s => s.generatorPromise)
        .filter((pending): pending is Promise<void> => pending !== null);
      await Promise.allSettled(running);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    harness = null;
    while (registeredIds.length > 0) registry.unregister(registeredIds.pop()!);

    globalThis.fetch = realFetch;
    loggerSpies.forEach(spy => spy.mockRestore());
    modeSpy?.mockRestore();
    resetQuotaCooldownsForTesting();
    resetCmemGatewayProbeForTesting();
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
    it.each(['allowance_exhausted', 'key_invalid', 'subscription_inactive'] as const)(
      '%s records the fallback with the gateway\'s own words and books no outage',
      async (code) => {
        const id = 920001;
        seedSettings();
        respond = async () => gatewayRejection(code);
        const { routes, completionHandler } = makeHarness([id]);

        await routes.ensureGeneratorRunning(id, 'observation');
        await settle(id);

        // The real provider paused on the rejection (aborted, then rethrew).
        expect(gatewayRequests()).toHaveLength(1);
        expect(gatewayRequests()[0].authorization).toBe(`Bearer ${MEMORY_KEY}`);

        // The marker is event-driven, and it keeps what the gateway said.
        const persisted = persistedSettings();
        expect(Math.abs(Date.now() - Date.parse(persisted.CLAUDE_MEM_PRO_FALLBACK_AT))).toBeLessThan(60_000);
        expect(persisted.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe(GATEWAY[code].message);
        expect(persisted.CLAUDE_MEM_PRO_FALLBACK_ACTION).toBe(GATEWAY[code].action);
        expect(persisted.CLAUDE_MEM_PRO_FALLBACK_URL).toBe(GATEWAY[code].url);

        // A fallback is not an outage: no provider breaker stacked on the
        // marker's own window, and nothing booked into the health ledger.
        expect(getQuotaCooldown('openrouter')).toBeNull();
        expect(readObserverHealth()?.consecutiveFailures ?? 0).toBe(0);
        expect(readObserverHealth()?.quotaCooldown ?? null).toBeNull();
        expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
      },
    );

    it.each(['allowance_exhausted', 'subscription_inactive'] as const)(
      '%s resumes the buffered work on claude at once, without waiting for another capture',
      async (code) => {
        const id = 920007;
        seedSettings();
        respond = async () => gatewayRejection(code);
        const { routes, claudeAgent } = makeHarness([id]);

        await routes.ensureGeneratorRunning(id, 'observation');
        await waitFor(() => claudeAgent.startSession.mock.calls.length === 1, 'the resume on claude');

        expect(session(id).currentProvider).toBe('claude');
        expect(gatewayRequests()).toHaveLength(1);
      },
    );

    it.each(['allowance_exhausted', 'subscription_inactive'] as const)(
      '%s: the next SessionStart relays the gateway\'s own words and link, once — never "free trial ended"',
      async (code) => {
        const id = 920002;
        seedSettings();
        respond = async () => gatewayRejection(code);
        const { routes } = makeHarness([id]);

        await routes.ensureGeneratorRunning(id, 'observation');
        await settle(id);

        const { contextHandler } = await import('../../../../src/cli/handlers/context.js');
        const hookInput = { sessionId: 'session-start-after-fallback', cwd: process.cwd(), platform: 'claude-code' as const };

        // Paid accounts at their monthly cap get allowance_exhausted too, so
        // the notice says what the gateway said — not that a trial ended.
        const first = (await contextHandler.execute(hookInput)).hookSpecificOutput?.additionalContext ?? '';
        expect(first).toContain(GATEWAY[code].message);
        expect(first).toContain(GATEWAY[code].action);
        expect(first).toContain(ON_ANTHROPIC_PLAN);
        expect(first).toContain(GATEWAY[code].url);
        expect(first).not.toContain('free trial');
        expect(first).toContain('context from worker');

        // Once: the notice marker suppresses it on the following session.
        const second = (await contextHandler.execute(hookInput)).hookSpecificOutput?.additionalContext ?? '';
        expect(second).not.toContain(ON_ANTHROPIC_PLAN);
      },
    );

    it('without the gateway\'s words the notice is plan-neutral and keeps the renewal link', async () => {
      const id = 920008;
      seedSettings();
      // A legacy gateway 402 carries no taxonomy envelope.
      respond = async () => new Response('Payment required', { status: 402 });
      const { routes } = makeHarness([id]);

      await routes.ensureGeneratorRunning(id, 'observation');
      await settle(id);

      const { contextHandler } = await import('../../../../src/cli/handlers/context.js');
      const notice = (await contextHandler.execute({
        sessionId: 'session-start-legacy-fallback',
        cwd: process.cwd(),
        platform: 'claude-code',
      })).hookSpecificOutput?.additionalContext ?? '';
      expect(notice).toContain('cmem.ai memory is paused for this account');
      expect(notice).toContain(ON_ANTHROPIC_PLAN);
      expect(notice).toContain(proTrialUrl('fallback'));
      expect(notice).not.toContain('free trial');
    });

    it('writes the marker once when two sessions are rejected together', async () => {
      const ids = [920005, 920006];
      seedSettings();
      const held = new Promise<void>(resolve => { releaseHeldResponses = resolve; });
      respond = async () => {
        await held;
        return gatewayRejection('allowance_exhausted');
      };
      const { routes } = makeHarness(ids);

      await Promise.all(ids.map(id => routes.ensureGeneratorRunning(id, 'observation')));
      await waitFor(() => gatewayRequests().length === 2, 'both requests in flight');
      const running = ids.map(id => session(id).generatorPromise);
      releaseHeldResponses();
      await Promise.all(running);

      expect(fallbackRecordings()).toBe(1);
      expect(persistedFallbackAt()).not.toBe('');
    });

    it('keeps a personal openrouter.ai key on the outage path, booked once with the provider\'s words', async () => {
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
      expect(getQuotaCooldown('openrouter')?.message).toContain('Insufficient credits');
      const health = readObserverHealth();
      expect(health?.consecutiveFailures).toBe(1);
      expect(health?.lastErrorKind).toBe('quota_exhausted');
      expect(health?.lastErrorMessage).toContain('Insufficient credits');
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
      expect(readObserverHealth()?.consecutiveFailures ?? 0).toBe(0);
    });
  });

  describe('other classified failures are booked once, with the provider\'s words', () => {
    it('a refused non-gateway credential is booked with its detail, shown at the next SessionStart, and cooled down', async () => {
      const id = 923001;
      seedSettings({
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_OPENROUTER_MODEL: 'some/model',
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-revoked-test-key',
      });
      respond = async () => new Response(JSON.stringify({ error: { message: 'User not found.', code: 401 } }), { status: 401 });
      const telemetrySpy = spyOn(telemetryBuffer, 'record');
      try {
        const { routes } = makeHarness([id]);
        const openRouterRequests = () => requests.filter(request => request.url.startsWith('https://openrouter.ai/'));

        await routes.ensureGeneratorRunning(id, 'observation');
        await settle(id);

        // Not the cmem gateway, so never the fallback.
        expect(persistedFallbackAt()).toBe('');
        const health = readObserverHealth();
        expect(health?.lastErrorKind).toBe('auth_invalid');
        expect(health?.lastErrorMessage).toContain('User not found.');

        // The very next SessionStart shows it, with the key remedy and no
        // restart advice — a restart cannot fix a refused key.
        const notice = observerHealthWarning();
        expect(notice).toContain('User not found.');
        expect(notice).toContain('~/.claude-mem/settings.json');
        expect(notice).not.toContain('npx claude-mem restart');

        // A cooldown, so the next captured event does not buy the same refusal.
        expect(getQuotaCooldown('openrouter')).not.toBeNull();
        await routes.ensureGeneratorRunning(id, 'observation');
        await settle(id);
        expect(openRouterRequests()).toHaveLength(1);

        const aborted = telemetrySpy.mock.calls.find(([event, sessionId, props]) =>
          event === 'session_compressed' && sessionId === id && (props as { outcome?: string })?.outcome === 'aborted');
        expect((aborted?.[2] as { abort_reason?: string } | undefined)?.abort_reason).toBe('auth');
      } finally {
        telemetrySpy.mockRestore();
      }
    });

    it('a rate limit that outlives the retries is never a spent allowance, and resumes after Retry-After', async () => {
      const id = 923002;
      seedSettings();
      let answered = 0;
      const held = new Promise<void>(resolve => { releaseHeldResponses = resolve; });
      respond = async () => {
        answered++;
        // The provider's own attempt plus its two in-place retries.
        if (answered <= 3) return gatewayRejection('rate_limited', { 'retry-after': '0' });
        await held;
        return gatewayRejection('bad_request');
      };
      const { routes } = makeHarness([id]);

      await routes.ensureGeneratorRunning(id, 'observation');
      await settle(id);

      // Retry-After 0: the resume may already be on the wire.
      expect(gatewayRequests().length).toBeGreaterThanOrEqual(3);
      expect(getQuotaCooldown('openrouter')).toBeNull();
      const health = readObserverHealth();
      expect(health?.lastErrorKind).toBe('rate_limit');
      expect(health?.lastErrorCode).toBe('rate_limited');

      // Retry-After has passed: the paused session tries again on its own.
      await waitFor(() => gatewayRequests().length === 4, 'the resumed request');
    });
  });

  describe('the single gateway re-probe after the fallback window', () => {
    it('admits exactly one of N concurrent sessions to the gateway; its failure re-arms the marker once', async () => {
      const ids = [921001, 921002, 921003, 921004, 921005];
      const elapsed = elapsedFallbackAt();
      seedSettings({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsed });

      // Hold the gateway's answer so every session decides while the probe is
      // still in flight — the herd the claim exists to stop.
      const held = new Promise<void>(resolve => { releaseHeldResponses = resolve; });
      respond = async () => {
        await held;
        return gatewayRejection('allowance_exhausted');
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
      expect(Date.parse(persistedFallbackAt())).toBeGreaterThan(Date.parse(elapsed));

      // The failed probe released its claim and restarted the window.
      const next = selectProviderForGenerator();
      releaseCmemGatewayProbe(next.gatewayProbeClaimId);
      expect(next.provider).toBe('claude');
    });

    it.each([
      ['upstream_unavailable', {}],
      ['rate_limited', { 'retry-after': '0' }],
    ] as const)('a probe that fails with %s keeps memory on claude: re-stamped marker, no breaker, resumed at once', async (code, headers) => {
      const id = 921101;
      const elapsed = elapsedFallbackAt();
      seedSettings({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsed });
      respond = async () => gatewayRejection(code, headers);
      const { routes, claudeAgent } = makeHarness([id]);

      await routes.ensureGeneratorRunning(id, 'observation');
      expect(session(id).currentProvider).toBe('openrouter');
      await settle(id);

      expect(Date.parse(persistedFallbackAt())).toBeGreaterThan(Date.parse(elapsed));
      expect(getQuotaCooldown('openrouter')).toBeNull();
      expect(readObserverHealth()?.consecutiveFailures ?? 0).toBe(0);
      await waitFor(() => claudeAgent.startSession.mock.calls.length === 1, 'the resume on claude');
      expect(getCmemGatewayProbeClaim()).toBeNull();
    });

    it('a Telegram wrap-up that holds the probe claim re-stamps the marker when it fails', async () => {
      const elapsed = elapsedFallbackAt();
      seedSettings({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsed });
      respond = async () => gatewayRejection('bad_request');
      // No active session for the wrap-up, so dispatch takes the probe claim.
      const { routes } = makeHarness([]);

      await expect((routes as any).formatTelegramWrapup({
        sessionDbId: 921201,
        contentSessionId: 'content-921201',
        project: 'cmem-fallback-test',
        platformSource: 'claude',
        summaryText: 'request\ninvestigated\ncompleted',
      })).rejects.toThrow();

      expect(gatewayRequests()).toHaveLength(1);
      expect(Date.parse(persistedFallbackAt())).toBeGreaterThan(Date.parse(elapsed));
      expect(getCmemGatewayProbeClaim()).toBeNull();
    });
  });

  describe('claims never outlive a run that did not start', () => {
    it('releases the quota-probe and gateway claims when the start throws after admission', async () => {
      const id = 924001;
      seedSettings({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt() });
      // An elapsed openrouter breaker, so admission takes a probe claim too.
      recordQuotaExhausted('openrouter', 'test breaker', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1_000);
      const { routes } = makeHarness([id]);
      (routes as any).applyTierRouting = async () => { throw new Error('tier routing failed'); };

      await expect(routes.ensureGeneratorRunning(id, 'observation')).rejects.toThrow('tier routing failed');

      expect(getQuotaCooldown('openrouter')?.probeClaimId).toBeNull();
      expect(getCmemGatewayProbeClaim()).toBeNull();
    });

    it('releases the gateway claim when a parked switch\'s old generator fails to exit', async () => {
      const id = 924002;
      seedSettings({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt() });
      const { routes } = makeHarness([id]);
      const parkedSession = session(id);

      // A Claude generator parked in waitForSlot whose exit handling then fails.
      registerFakeOccupant(`occupant-for-${id}`);
      const parkedController = parkedSession.abortController;
      parkedSession.currentProvider = 'claude';
      const parkedGenerator = waitForSlot(1, parkedController.signal, id).then(
        () => { throw new Error('unexpected slot'); },
        () => { throw new Error('old generator exit handling failed'); },
      );
      // Handled here as well, so the cleanup abort below can never surface as
      // an unhandled rejection; the route still sees the rejection it awaits.
      parkedGenerator.catch(() => {});
      parkedSession.generatorPromise = parkedGenerator;
      try {
        expect(isSessionParkedForSlot(id)).toBe(true);

        // Dispatch claims the gateway probe, sees the parked Claude generator,
        // and switches — then the old generator's exit throws.
        await expect(routes.ensureGeneratorRunning(id, 'observation')).rejects.toThrow('old generator exit handling failed');

        expect(getCmemGatewayProbeClaim()).toBeNull();
      } finally {
        // Never leave the parked waiter behind for a later test.
        parkedController.abort();
        parkedSession.generatorPromise = null;
      }
    });
  });
});
