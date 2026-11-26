import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession, PendingMessageWithId } from '../../src/services/worker-types.js';

/**
 * End-to-end guard for the per-session observer model (issue #6486).
 *
 * The host's V1 `chat.message` hook forwards only `model.modelID` (the
 * endpoint-ready id, never `providerID/modelID`) as `observerModel` on session
 * init. The worker parks that id on the live ActiveSession, and the production
 * provider resolves it in `OpenAICompatibleProvider.startSession` via
 * `configForSession(session)` — NOT via the global `getConfig()`. The id then
 * goes out as `model` on a real `/chat/completions` request.
 *
 * This test therefore drives the real `startSession` against a local fake
 * OpenAI-compatible endpoint and asserts the model on the wire. Calling the
 * protected `configForSession` directly would not catch a revert of the
 * `startSession` wiring, which is the whole point of this guard.
 *
 * Lifecycle contract (docs/architecture/observer-lifecycle.md): the id is live
 * session state — never persisted, never replayed. A restart starts fresh on
 * the global model, with no stale paid call from buffered inference inputs.
 */
const GLOBAL_MODEL = 'global-fallback-model';
const ENDPOINT_MODEL = 'endpoint-model';
const FIRST_TURN_MODEL = 'model-a';
const SECOND_TURN_MODEL = 'model-b';

interface WireRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const stores: SessionStore[] = [];
const originalLoad = SettingsDefaultsManager.loadFromFile;

afterEach(() => {
  SettingsDefaultsManager.loadFromFile = originalLoad;
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(opts: { sessionModelOptIn?: boolean; observeBarePrompts?: boolean } = {}) {
  // The opt-in is worker-side: the plugin keeps sending observerModel, but the
  // provider only uses it when this gate is exactly 'true'. Default the harness
  // to on so the three original cases keep exercising the session model.
  const sessionModelOptIn = opts.sessionModelOptIn ?? true;
  const observeBarePrompts = opts.observeBarePrompts ?? true;
  // Private temp root + ephemeral loopback endpoint: no real settings file,
  // worker, .env credential or external network is ever touched.
  const root = mkdtempSync(path.join(tmpdir(), 'cmem-observer-model-live-'));
  roots.push(root);

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
    CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'custom',
    CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    CLAUDE_MEM_OPENAI_COMPAT_MODEL: GLOBAL_MODEL,
    CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION: sessionModelOptIn ? 'true' : 'false',
    // Non-empty fixture keys keep config resolution away from the real .env.
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'fixture-key',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEYS: 'fixture-key-2',
    // By default send the init prompt as its own (single) request and skip the
    // message loop: the assertion is about the model on that one paid request.
    // The mid-session switch test opts out so only queued turns are sent.
    CLAUDE_MEM_OBSERVE_BARE_PROMPTS: observeBarePrompts ? 'true' : 'false',
    CLAUDE_MEM_OBSERVER_ENABLED: 'true',
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    CLAUDE_MEM_AUTO_UPDATE: 'false',
  };
  // The worker never reads the host's real settings.json here.
  SettingsDefaultsManager.loadFromFile = (() => settings) as typeof originalLoad;
  ModeManager.getInstance().loadMode('code');

  const store = new SessionStore(':memory:');
  stores.push(store);
  const sessionDbId = store.createSDKSession('observer-model-live', 'acme/api', 'persisted anchor turn');
  const db = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null } as never;
  // An empty iterator ends the message loop immediately; the provider's init
  // request is then entirely real. A test can install a queued-turn iterator
  // with setIterator — the switch case mutates the live session between yields.
  let iterator: () => AsyncGenerator<PendingMessageWithId> = async function* () {};
  const manager = {
    getMessageIterator: () => iterator(),
    clearPendingForSession: async () => 0,
    // The OpenAI-compatible batching prompt and the answered-batch confirmation
    // touch these; a no-claim fixture keeps the test focused on the wire model.
    claimNextObservation: () => null,
    getClaimedMessages: () => [],
    confirmClaimedMessages: async () => {},
  } as never;
  const provider = new OpenAICompatProvider(db, manager);

  const makeSession = (overrides: Partial<ActiveSession> = {}): ActiveSession => ({
    sessionDbId,
    contentSessionId: 'observer-model-live',
    memorySessionId: 'observer-model-memory',
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

  return {
    requests, provider, makeSession, store,
    setIterator: (next: () => AsyncGenerator<PendingMessageWithId>) => { iterator = next; },
  };
}

describe('per-session observer model reaches the OpenAI-compatible endpoint', () => {
  it('v1-selected-model: modelID goes on the wire, never providerID/modelID', async () => {
    const h = harness();
    // What the V1 adapter extracts from chat.message.model: only modelID.
    const chatMessageModel = { providerID: 'custom', modelID: ENDPOINT_MODEL };
    const session = h.makeSession({
      observerModel: chatMessageModel.modelID,
      userPrompt: 'FIRST_SESSION_ONLY_INPUT',
    });

    await h.provider.startSession(session);

    expect(h.requests).toHaveLength(1);
    // This is the request body sent by the production provider, not a call to
    // configForSession: reverting startSession to getConfig() fails here.
    expect(h.requests[0].model).toBe(ENDPOINT_MODEL);
    expect(h.requests[0].model).not.toContain('custom/');
    expect(JSON.stringify(h.requests[0].messages)).toContain('FIRST_SESSION_ONLY_INPUT');
  });

  it('no-selected-model: falls back to CLAUDE_MEM_OPENAI_COMPAT_MODEL', async () => {
    const h = harness();
    const session = h.makeSession(); // no observerModel, as when the hook had none

    await h.provider.startSession(session);

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].model).toBe(GLOBAL_MODEL);
  });

  it('restart: global model is used and no persisted inference input is replayed', async () => {
    const h = harness();
    const first = h.makeSession({
      observerModel: ENDPOINT_MODEL,
      userPrompt: 'FIRST_SESSION_ONLY_INPUT',
    });
    await h.provider.startSession(first);

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].model).toBe(ENDPOINT_MODEL);
    // The first generation really carried that input, so its absence after the
    // restart is evidence of no replay rather than of an empty fixture.
    expect(JSON.stringify(first.conversationHistory)).toContain('FIRST_SESSION_ONLY_INPUT');

    // Worker/session restart: a fresh ActiveSession for the same durable id.
    // observerModel was live-only, so it is gone; no inference input was
    // persisted for a backfill. Exactly one fresh init call follows.
    const restarted = h.makeSession({ userPrompt: 'SECOND_SESSION_INPUT' });
    await h.provider.startSession(restarted);

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].model).toBe(GLOBAL_MODEL);
    expect(JSON.stringify(h.requests[1].messages)).not.toContain('FIRST_SESSION_ONLY_INPUT');
  });

  it('opt-in-disabled: the global model goes on the wire even with a selected session model', async () => {
    const h = harness({ sessionModelOptIn: false });
    // The plugin still transports observerModel when the gate is off; only the
    // worker's resolution ignores it.
    const session = h.makeSession({ observerModel: ENDPOINT_MODEL });
    await h.provider.startSession(session);

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].model).toBe(GLOBAL_MODEL);
    expect(h.requests[0].model).not.toBe(ENDPOINT_MODEL);
  });

  it('model-switch-mid-session: each queued turn uses the model selected when it is read', async () => {
    const h = harness({ observeBarePrompts: false });
    const session = h.makeSession({ observerModel: FIRST_TURN_MODEL });
    // A newer host selection arrives between two queued turns. Both requests
    // go through the real startSession/runMessageLoop and the real endpoint;
    // only the iterator is fake.
    h.setIterator(async function* () {
      yield {
        type: 'observation', _persistentId: 1, _originalTimestamp: Date.now(),
        tool_name: 'Read', tool_input: { path: 'a' }, tool_response: { text: 'a' }, prompt_number: 2,
      } satisfies PendingMessageWithId;
      session.observerModel = SECOND_TURN_MODEL;
      yield {
        type: 'observation', _persistentId: 2, _originalTimestamp: Date.now(),
        tool_name: 'Read', tool_input: { path: 'b' }, tool_response: { text: 'b' }, prompt_number: 3,
      } satisfies PendingMessageWithId;
    });

    await h.provider.startSession(session);

    expect(h.requests.map(request => request.model)).toEqual([FIRST_TURN_MODEL, SECOND_TURN_MODEL]);
  });
});
