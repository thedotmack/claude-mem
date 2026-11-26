import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

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
          'main-hote': { modelID: HOST_ENDPOINT_MODEL },
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
      requests.push({ model: body.model, messages: body.messages });
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
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
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
    getMessageIterator: async function* () { yield observation; },
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

  return { requests, provider, makeSession, store };
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
