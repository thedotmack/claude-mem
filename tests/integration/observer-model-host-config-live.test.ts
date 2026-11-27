import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  HOST_MODEL_NOT_SERVED_CODE,
  OpenAICompatProvider,
  resetRefusedHostModelsForTesting,
  resetServedModelsForTesting,
  resolveOpenAICompatConfig,
} from '../../src/services/worker/OpenAICompatProvider.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { logger } from '../../src/utils/logger.js';
import { paths } from '../../src/shared/paths.js';
import {
  getQuotaCooldown,
  QUOTA_COOLDOWN_FILENAME,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import { startGeneratorWithProvider } from '../../src/services/worker/session/GeneratorRunner.js';
import type { GeneratorRunnerDependencies } from '../../src/services/worker/session/GeneratorRunner.js';

/**
 * End-to-end guard for the host-configured observer model (issue #6485).
 *
 * With CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST='true' the worker reads the
 * host's own OpenCode config for live observation/summary turns (the init turn
 * stays pinned to startSession's base config). The host's selected model is a
 * `providerID/modelID` display key; it is translated through the host's
 * `provider` map before it reaches an OpenAI-compatible endpoint. The translated
 * id is asserted here on the wire of a real `/chat/completions` request, driven
 * through `startSession` -> `runMessageLoop` -> `configForSession(session, host)`
 * against a loopback fake endpoint.
 *
 * Calling the protected `configForSession` directly would not catch a revert of
 * the startSession/runMessageLoop wiring or of the host gate, which is the whole
 * point of this guard. Lifecycle contract (docs/architecture/observer-lifecycle.md):
 * the host id is read live per turn; no inference input is persisted or replayed.
 *
 * Isolation: a private temp root, an ephemeral loopback port, a stubbed settings
 * load and isolated OPENCODE_* / XDG_CONFIG_HOME env vars. No real settings.json,
 * worker, .env credential, host config or external network is ever touched.
 */
const PRESET = 'nvidia-nim';
const PRESET_MODEL = resolveOpenAICompatPreset(PRESET).defaultModel;
const HOST_DISPLAY_MODEL = 'host/main-hote';
const HOST_ENDPOINT_MODEL = 'endpoint-main';
const SESSION_MODEL = 'session-observer-model';

interface WireRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

const ENV_KEYS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const;

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const stores: SessionStore[] = [];
const originalLoad = SettingsDefaultsManager.loadFromFile;
const savedEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  SettingsDefaultsManager.loadFromFile = originalLoad;
  resetRefusedHostModelsForTesting();
  resetServedModelsForTesting();
  resetQuotaCooldownsForTesting();
  for (const key of ENV_KEYS) {
    const previous = savedEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface HarnessOptions {
  fromHost?: boolean;
  fromSession?: boolean;
  observerModel?: string;
  /** Ids the fake endpoint refuses: a host provider that is not the observer's service. */
  refusedModels?: string[];
  /** The status of that refusal; 403 is the real Windows incident (no API key to rotate). */
  refusedStatus?: 401 | 403 | 404;
  /** Endpoint id the host config translates to; defaults to a host-only model. */
  hostEndpointModel?: string;
  /** Also yield a summary turn on the host's small model (tier routing on). */
  withSummary?: boolean;
  /** Explicit summary-tier model, used with the tier-routing opt-in. */
  summaryModel?: string;
  /** Refuse a listed model only from this request number on (1-based). */
  refuseFromRequest?: number;
}

function harness(opts: HarnessOptions = {}) {
  const fromHost = opts.fromHost ?? true;
  const fromSession = opts.fromSession ?? false;

  const root = mkdtempSync(path.join(tmpdir(), 'cmem-host-observer-live-'));
  roots.push(root);

  // The explicit config always wins in readOpenCodeHostConfig; XDG keeps this
  // machine's real ~/.config/opencode out of the fixture as a second safeguard.
  const hostConfigPath = path.join(root, 'opencode.json');
  writeFileSync(hostConfigPath, JSON.stringify({
    model: HOST_DISPLAY_MODEL,
    agents: { title: { model: 'host/small-hote' } },
    provider: {
      host: {
        models: {
          'main-hote': { modelID: opts.hostEndpointModel ?? HOST_ENDPOINT_MODEL },
          'small-hote': { modelID: 'endpoint-small' },
        },
      },
    },
  }));
  process.env.OPENCODE_CONFIG = hostConfigPath;
  process.env.OPENCODE_CONFIG_DIR = path.join(root, 'opencode');
  process.env.XDG_CONFIG_HOME = root;

  const requests: WireRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as WireRequest;
      const requestNumber = requests.length + 1;
      requests.push({ model: body.model, messages: body.messages });
      if (opts.refusedModels?.includes(body.model)
        && (opts.refuseFromRequest === undefined || requestNumber >= opts.refuseFromRequest)) {
        const status = opts.refusedStatus ?? 404;
        const refusalBody = status === 403
          ? { error: { message: 'Model access is disabled', type: 'invalid_request_error', code: 'model_access_disabled' } }
          : { error: { message: `The model \`${body.model}\` does not exist`, type: 'invalid_request_error', code: 'model_not_found' } };
        return Response.json(refusalBody, { status });
      }
      return Response.json({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: '<skip_summary reason="noise" />' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    },
  });
  servers.push(server);

  const settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_PROVIDER: 'openai-compatible',
    CLAUDE_MEM_OPENAI_COMPAT_PRESET: PRESET,
    CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    // Empty explicit model: the host translated id (or the preset) is the
    // effective model. This is the production shape when relying on host mode.
    CLAUDE_MEM_OPENAI_COMPAT_MODEL: '',
    CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST: fromHost ? 'true' : 'false',
    CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION: fromSession ? 'true' : 'false',
    // Non-empty fixture keys keep config resolution away from the real .env.
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'fixture-key',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEYS: 'fixture-key-2',
    // One real paid request: the observation turn carries the init prompt, and
    // the init turn itself sends nothing.
    CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
    CLAUDE_MEM_OBSERVER_ENABLED: 'true',
    CLAUDE_MEM_TIER_ROUTING_ENABLED: opts.withSummary ? 'true' : 'false',
    CLAUDE_MEM_TIER_SUMMARY_MODEL: opts.summaryModel ?? '',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    CLAUDE_MEM_AUTO_UPDATE: 'false',
  };
  SettingsDefaultsManager.loadFromFile = (() => settings) as typeof originalLoad;
  ModeManager.getInstance().loadMode('code');

  const store = new SessionStore(':memory:');
  stores.push(store);
  const sessionDbId = store.createSDKSession('host-observer-live', 'acme/api', 'anchored user turn');
  const db = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null } as never;

  // One queued observation carrying cwd, so runMessageLoop resolves the host
  // config via configForSession(session, { cwd }) and the wire model is real.
  const observation = {
    type: 'observation',
    tool_name: 'Read',
    tool_input: { file_path: 'src/router.ts' },
    tool_response: 'the login redirect lives here',
    prompt_number: 1,
    cwd: root,
  };
  const manager = {
    getMessageIterator: async function* () {
      yield observation;
      if (opts.withSummary) {
        yield { type: 'summarize', last_assistant_message: 'done', prompt_number: 1, cwd: root };
      }
    },
    getClaimedMessages: () => [],
    confirmClaimedMessages: async () => 0,
    resetProcessingToPending: async () => 0,
    clearPendingForSession: async () => 0,
  } as never;
  const provider = new OpenAICompatProvider(db, manager);

  const makeSession = (overrides: Partial<ActiveSession> = {}): ActiveSession => ({
    sessionDbId,
    contentSessionId: 'host-observer-live',
    memorySessionId: 'host-observer-memory',
    project: 'acme/api',
    platformSource: 'opencode',
    userPrompt: 'a live user prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: 'openai-compatible',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  });

  /**
   * Drive the failure through GeneratorRunner, the only site that books an
   * auth_invalid failure into the long credential cooldown. Calling
   * provider.startSession() directly would leave bookClassifiedFailure out of
   * the path and prove nothing about the cooldown this guard is about.
   */
  const ensureGeneratorRunning = mock(async () => {});
  const runGenerator = async (session: ActiveSession): Promise<void> => {
    const sessionManager = {
      getMessageBuffer: () => ({ getPendingCount: () => 1 }),
      getSession: () => session,
      clearTransportResume: () => {},
      discardBufferedWork: () => 1,
      removeSessionImmediate: () => {},
    };
    const deps = {
      sessionManager,
      sdkAgent: undefined,
      geminiAgent: undefined,
      openRouterAgent: undefined,
      codexAgent: undefined,
      openAICompatAgent: provider,
      workerService: undefined,
      completionHandler: { finalizeSession: async () => {} },
      ensureGeneratorRunning,
      maybeSelfHealStaleClaudeSpawn: () => false,
    } as unknown as GeneratorRunnerDependencies;
    await startGeneratorWithProvider(session, 'openai-compatible', 'host-observer-live-test', null, null, deps);
    // startGeneratorWithProvider assigns and detaches the promise; its catch
    // (which books the failure) and finally (which handles the exit) live on
    // that promise, so the test must await it.
    await session.generatorPromise;
  };

  return { requests, provider, makeSession, store, root, runGenerator, ensureGeneratorRunning };
}

describe('host-configured observer model reaches the OpenAI-compatible endpoint', () => {
  it('host-on: the translated host model is on the wire, not the preset nor the global fallback', async () => {
    const h = harness({ fromHost: true, fromSession: false });

    await h.provider.startSession(h.makeSession());

    expect(h.requests).toHaveLength(1);
    expect(PRESET_MODEL).toBeTruthy();
    // The request body is sent by the production provider on the wire, not by
    // a direct call to the protected configForSession: reverting the host wiring
    // in startSession/runMessageLoop fails here.
    expect(h.requests[0].model).toBe(HOST_ENDPOINT_MODEL);
    expect(h.requests[0].model).not.toBe(PRESET_MODEL);
    expect(h.requests[0].model).not.toBe(HOST_DISPLAY_MODEL);
    expect(h.requests[0].model).not.toBe('');
  });

  it('host-on + session-on: the session observer model wins last', async () => {
    const h = harness({ fromHost: true, fromSession: true, observerModel: SESSION_MODEL });

    await h.provider.startSession(h.makeSession({ observerModel: SESSION_MODEL }));

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].model).toBe(SESSION_MODEL);
    expect(h.requests[0].model).not.toBe(HOST_ENDPOINT_MODEL);
  });

  it('independent gates: the host model still applies with the session gate off', async () => {
    const h = harness({ fromHost: true, fromSession: false, observerModel: SESSION_MODEL });

    // The plugin may still park an id on the session; with FROM_SESSION off the
    // worker ignores it, but FROM_HOST stays on and the host model is used.
    await h.provider.startSession(h.makeSession({ observerModel: SESSION_MODEL }));

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].model).toBe(HOST_ENDPOINT_MODEL);
    expect(h.requests[0].model).not.toBe(SESSION_MODEL);
  });

  it('host-off: the preset model stands even with a host config present', async () => {
    const h = harness({ fromHost: false, fromSession: false });

    await h.provider.startSession(h.makeSession());

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].model).toBe(PRESET_MODEL);
    expect(h.requests[0].model).not.toBe(HOST_ENDPOINT_MODEL);
  });
});

/**
 * The translated id is the host provider's. It is right for the observer only
 * when that provider is the observer endpoint's service; otherwise the endpoint
 * answers 404 for it, and the host config names it again on every turn.
 */
describe('a host-configured model the observer endpoint does not serve', () => {
  it('host-refused: the id is sent once, then the preset model serves and the failure names the host opt-in', async () => {
    const h = harness({ fromHost: true, refusedModels: [HOST_ENDPOINT_MODEL] });
    const warn = spyOn(logger, 'warn');
    try {
      const failure = await h.provider.startSession(h.makeSession()).catch((error: unknown) => error);

      expect(failure).toMatchObject({ kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE });
      const action = (failure as { action: string }).action;
      expect(action).toContain('CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');
      expect(action).toContain(HOST_ENDPOINT_MODEL);
      expect(action).not.toContain('and _MODEL');
      expect(h.requests.map(request => request.model)).toEqual([HOST_ENDPOINT_MODEL]);

      // The next generation reads the same host config again. It must not be refused again.
      await h.provider.startSession(h.makeSession());
      expect(h.requests.map(request => request.model)).toEqual([HOST_ENDPOINT_MODEL, PRESET_MODEL]);

      // Only the refused id is left out: the host's small model still feeds the summary tier.
      const resolved = resolveOpenAICompatConfig(undefined, { cwd: h.root });
      expect(resolved.model).toBe(PRESET_MODEL);
      expect(resolved.summaryModel).toBe('endpoint-small');

      const refusals = warn.mock.calls.filter(call => JSON.stringify(call).includes('CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST'));
      expect(refusals).toHaveLength(1);
      expect(JSON.stringify(refusals[0])).toContain(HOST_ENDPOINT_MODEL);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * The Windows incident: a 403 endpoint that does not serve the host's chosen
 * model must not be mistaken for a bad API key. GeneratorRunner is in the path
 * so the assertion on the cooldown is about the real booking site.
 */
describe('a host-chosen model refused with 403 is not a credential failure', () => {
  it('host-refused-403: no auth cooldown, no replay, and the next turn uses the fallback model', async () => {
    resetQuotaCooldownsForTesting();
    const cooldownPath = path.join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);
    expect(existsSync(cooldownPath)).toBe(false);

    const h = harness({ fromHost: true, refusedModels: [HOST_ENDPOINT_MODEL], refusedStatus: 403 });
    const session = h.makeSession();
    const errorLog = spyOn(logger, 'error');
    try {
      await h.runGenerator(session);

      // GeneratorRunner's one error line carries the real classification: the
      // 403 was refused on the host's id, not on our credential.
      const failed = errorLog.mock.calls.find(call => call[1] === 'Observer failed');
      expect(failed?.[2]).toMatchObject({ provider: 'openai-compatible', kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE });
      expect(failed?.[3]).toContain('CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');
      expect(failed?.[3]).not.toContain('CLAUDE_MEM_OPENAI_COMPAT_API_KEY');
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
      expect(existsSync(cooldownPath)).toBe(false);
      expect(h.requests.map(request => request.model)).toEqual([HOST_ENDPOINT_MODEL]);
      // The auth-category exit discards pending work: no summarize rescue and
      // no extra generation of the refused batch may be started by the failure.
      expect(h.ensureGeneratorRunning).not.toHaveBeenCalled();
      expect(session.pausedReason).toBe('auth');

      // A fresh turn starts a new generation; the refused id is remembered and
      // the configured model serves. No request for the refused batch is replayed.
      await h.runGenerator(h.makeSession());
      expect(h.requests.map(request => request.model)).toEqual([HOST_ENDPOINT_MODEL, PRESET_MODEL]);
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
      expect(existsSync(cooldownPath)).toBe(false);
    } finally {
      errorLog.mockRestore();
    }
  });
});

/**
 * Greptile P1 (2026-11-27): when the refused host id is also the preset
 * default, no model is left. Dispatch must not silently choose Claude (another
 * paid account); the real generator must stop on the classified refusal with
 * no network call, no paid send and no credential cooldown.
 */
describe('a refused preset default stops the provider instead of switching it', () => {
  it('host-refused-preset-default: no second request, no paid send, no cooldown', async () => {
    resetQuotaCooldownsForTesting();
    const cooldownPath = path.join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);
    expect(existsSync(cooldownPath)).toBe(false);

    const h = harness({
      fromHost: true,
      hostEndpointModel: PRESET_MODEL,
      refusedModels: [PRESET_MODEL],
      refusedStatus: 403,
    });
    const errorLog = spyOn(logger, 'error');
    try {
      const first = h.makeSession({ claimedMessageIds: [1] });
      await h.runGenerator(first);
      expect(h.requests.map(request => request.model)).toEqual([PRESET_MODEL]);
      const failed = errorLog.mock.calls.find(call => call[1] === 'Observer failed');
      expect(failed?.[2]).toMatchObject({
        provider: 'openai-compatible', kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE,
      });
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
      expect(first.paidSendBudget?.spentPaidSends ?? 0).toBe(0);
      expect(h.ensureGeneratorRunning).not.toHaveBeenCalled();

      const after = resolveOpenAICompatConfig();
      expect(after.model).toBe('');
      expect(after.allModelsRefused).toBe(true);

      const second = h.makeSession({ claimedMessageIds: [2] });
      await h.runGenerator(second);
      // The second generation stops before the socket: no request, no retry,
      // no rotation to a second key, and no paid send against the new budget.
      expect(h.requests.map(request => request.model)).toEqual([PRESET_MODEL]);
      const stopped = errorLog.mock.calls.filter(call => call[1] === 'Observer failed').at(-1);
      expect(stopped?.[2]).toMatchObject({
        provider: 'openai-compatible', kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE,
      });
      expect(stopped?.[3]).toContain('no request was sent');
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
      expect(existsSync(cooldownPath)).toBe(false);
      expect(second.paidSendBudget?.spentPaidSends ?? 0).toBe(0);
      expect(h.ensureGeneratorRunning).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});

/**
 * C3: the summary tier has its own host id. A 404 on that small model is
 * defused exactly like one on the main id: it is classified as an unserved
 * host model, only that id is dropped, and the main host model still serves.
 * This locks the documented rule that only the refused id is set aside.
 */
describe('a refused host summary model does not touch the main host model', () => {
  it('host-and-summary-404-still-defused: the small id is dropped, the main host model still serves', async () => {
    const h = harness({
      fromHost: true,
      withSummary: true,
      refusedModels: ['endpoint-small'],
      refusedStatus: 404,
    });
    const session = h.makeSession();
    const errorLog = spyOn(logger, 'error');
    try {
      await h.runGenerator(session);

      const failed = errorLog.mock.calls.find(call => call[1] === 'Observer failed');
      expect(failed?.[2]).toMatchObject({
        provider: 'openai-compatible',
        kind: 'unrecoverable',
        code: HOST_MODEL_NOT_SERVED_CODE,
      });
      expect(failed?.[3]).toContain('CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST');
      // The observation went out on the main host id; only the summary turn
      // carried the small id that the endpoint refused.
      expect(h.requests.map(request => request.model)).toEqual([HOST_ENDPOINT_MODEL, 'endpoint-small']);
      expect(session.pausedReason).toBe('auth');
      expect(getQuotaCooldown('openai-compatible')).toBeNull();

      // Only the refused id is left out: the main host id still wins and the
      // summary tier no longer names the small id.
      const resolved = resolveOpenAICompatConfig(undefined, { cwd: h.root });
      expect(resolved.model).toBe(HOST_ENDPOINT_MODEL);
      expect(resolved.summaryModel).toBeUndefined();

      // The next generation keeps the main model. The refused batch is not
      // replayed and no second request is sent on the refused small id.
      await h.runGenerator(h.makeSession());
      expect(h.requests.filter(request => request.model === 'endpoint-small')).toHaveLength(1);
      expect(h.requests.map(request => request.model)).toEqual([
        HOST_ENDPOINT_MODEL, 'endpoint-small', HOST_ENDPOINT_MODEL, HOST_ENDPOINT_MODEL,
      ]);
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  });
});

/**
 * B5 x C1: when the host's translated id IS the preset default and the endpoint
 * refuses it, no candidate is left. The empty sentinel must stop query() before
 * the network, not send the same refused id again on every turn.
 */
describe('a refused model equal to the preset default is never re-sent', () => {
  it('refused-preset-default-is-not-resent: no candidate means no doomed request', async () => {
    const h = harness({
      fromHost: true,
      hostEndpointModel: PRESET_MODEL,
      refusedModels: [PRESET_MODEL],
      refusedStatus: 404,
    });
    const failure = await h.provider.startSession(h.makeSession()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE });
    expect(h.requests.map(request => request.model)).toEqual([PRESET_MODEL]);

    const resolved = resolveOpenAICompatConfig(undefined, { cwd: h.root });
    // The refused id is dropped both as a host model and as the preset term,
    // leaving the empty sentinel that keeps query() off the wire.
    expect(resolved.model).toBe('');
    expect(resolved.hostChosenModels?.[PRESET_MODEL]).toBeUndefined();

    const second = await h.provider.startSession(h.makeSession()).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(Error);
    expect(h.requests.map(request => request.model)).toEqual([PRESET_MODEL]);
  });
});

/**
 * Greptile P1: `lastServed` is the observer model's fallback, so a summary must
 * not overwrite it with the summary tier's small id. Both generations go
 * through the real loopback endpoint and the real config resolver: the second
 * generation's observation must still be sent on the preset model.
 */
describe('a summary turn does not replace the remembered observer model', () => {
  it('summary-tier-model-does-not-become-last-served', async () => {
    const summaryModel = 'tier-only-small-model';
    const h = harness({ fromHost: false, fromSession: false, withSummary: true, summaryModel });

    await h.provider.startSession(h.makeSession());
    expect(h.requests.map(request => request.model)).toEqual([PRESET_MODEL, summaryModel]);

    const sent = h.requests.length;
    await h.provider.startSession(h.makeSession());
    expect(h.requests.slice(sent).map(request => request.model)).toEqual([PRESET_MODEL, summaryModel]);
  });
});

/**
 * Greptile P1: once `lastServed` supplies the session's own id, the equality
 * early return in configForSession used to drop the FROM_SESSION marker. A
 * later 403 was then booked as auth_invalid, with the long credential cooldown
 * this PR exists to avoid. GeneratorRunner is in the path so the cooldown is
 * asserted at its real booking site.
 */
describe('a session-chosen model refused after reuse is not a credential failure', () => {
  it('reused-session-model-403-keeps-no-auth-cooldown', async () => {
    resetQuotaCooldownsForTesting();
    const cooldownPath = path.join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);
    expect(existsSync(cooldownPath)).toBe(false);

    const h = harness({
      fromHost: false,
      fromSession: true,
      refusedModels: [SESSION_MODEL],
      refusedStatus: 403,
      refuseFromRequest: 2,
    });
    const errorLog = spyOn(logger, 'error');
    try {
      await h.runGenerator(h.makeSession({ observerModel: SESSION_MODEL }));
      expect(h.requests.map(request => request.model)).toEqual([SESSION_MODEL]);

      await h.runGenerator(h.makeSession({ observerModel: SESSION_MODEL }));
      const failed = errorLog.mock.calls.find(call => call[1] === 'Observer failed');
      expect(failed?.[2]).toMatchObject({ provider: 'openai-compatible', kind: 'unrecoverable', code: HOST_MODEL_NOT_SERVED_CODE });
      expect(failed?.[3]).toContain('CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION');
      expect(getQuotaCooldown('openai-compatible')).toBeNull();
      expect(existsSync(cooldownPath)).toBe(false);
    } finally {
      errorLog.mockRestore();
    }
  });
});
