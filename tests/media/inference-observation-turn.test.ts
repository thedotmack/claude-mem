// Phase 4 end to end through the real OpenRouterProvider observation turn,
// real ingest capture, real SQLite (v61/v62), real MediaStore derivatives and
// the real response processor, with HTTP mocked at fetch. Scratch files live
// in the project-local, gitignored .scratch directory.
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MediaStore } from '../../src/services/media/store.js';
import { ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { __resetContextWindowCacheForTests } from '../../src/services/worker/context-window.js';
import { __resetMediaCapabilityCacheForTests } from '../../src/services/worker/media-capability.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { logger } from '../../src/utils/logger.js';
import type { ActiveSession, PendingMessageWithId } from '../../src/services/worker-types.js';
import { processAgentResponse, snapshotResponseContext } from '../../src/services/worker/agents/ResponseProcessor.js';
import { freezeResponseMedia, prepareTurnImages } from '../../src/services/media/inference.js';
import { LOCAL_IMAGE_REQUEST_BOUNDS } from '../../src/services/worker/media-capability.js';
import { fitTurnImagesToBody, buildOpenRouterRequestBody } from '../../src/services/worker/OpenRouterProvider.js';

const SCRATCH = join(import.meta.dir, '../../.scratch');
const fixtureText = (name: string) => readFileSync(new URL(`../fixtures/media-v1/inference/${name}`, import.meta.url), 'utf8');
const capabilityFixture = JSON.parse(fixtureText('capability.json'));
const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const GATEWAY_CHAT = 'https://cmem.ai/api/inference/v1/chat/completions';
const GATEWAY_CAPABILITIES = 'https://cmem.ai/api/inference/v1/capabilities';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MEMORY_KEY = 'cm_pro_0123456789abcdef01234567';
const IMAGE_MODEL = '~deepseek/deepseek-flash-latest';
const IMAGE_CATALOG = capabilityFixture.qualification_cases.find((entry: { name: string }) => entry.name === 'alias_to_image_capable').catalog;
const TEXT_ONLY_CATALOG = capabilityFixture.qualification_cases.find((entry: { name: string }) => entry.name === 'alias_to_text_only').catalog;
const QUALIFIED_RESPONSE = capabilityFixture.responses.find((entry: { name: string }) => entry.name === 'qualified').body;

const RED = { r: 220, g: 30, b: 40 };
const BLUE = { r: 20, g: 60, b: 210 };
let redPng: string;
let bluePng: string;

let dir: string;
let db: Database;
let sessions: SessionStore;
let media: MediaStore;
let queued: any[];
let settings: Record<string, string>;
let settingsSpy: ReturnType<typeof spyOn>;
let modeSpy: ReturnType<typeof spyOn>;
let logSpies: ReturnType<typeof spyOn>[];
let originalFetch: typeof fetch;
let chatBodies: string[];
let chatReplies: Array<() => Response>;
let catalog: unknown[];
let otherCalls: string[];
let capabilityBody: Record<string, unknown>;
let cloudNotifies: number;
let confirmed: number;
let confirmHook: () => void;

beforeAll(async () => {
  const make = (color: typeof RED) => sharp({ create: { width: 320, height: 180, channels: 3, background: color } }).png().toBuffer();
  redPng = (await make(RED)).toString('base64');
  bluePng = (await make(BLUE)).toString('base64');
});

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = realpathSync(mkdtempSync(join(SCRATCH, 'media-inference-')));
  mkdirSync(join(dir, 'project'));
  db = new Database(':memory:');
  sessions = new SessionStore(db);
  media = new MediaStore(db, join(dir, 'data'));
  queued = [];
  cloudNotifies = 0;
  confirmed = 0;
  confirmHook = () => {};
  settings = {
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'true',
    CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'true',
  };
  settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => settings as never);
  modeSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
    getActiveMode: () => ({
      name: 'code',
      prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
      observation_types: [{ id: 'discovery' }, { id: 'change' }],
      observation_concepts: [],
    }),
  }) as never);
  logSpies = (['info', 'debug', 'warn', 'error', 'success', 'failure'] as const)
    .map(level => spyOn(logger, level as never).mockImplementation((() => {}) as never));
  __resetContextWindowCacheForTests();
  __resetMediaCapabilityCacheForTests();
  catalog = IMAGE_CATALOG;
  capabilityBody = QUALIFIED_RESPONSE;
  chatBodies = [];
  chatReplies = [];
  otherCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === MODELS_URL) {
      otherCalls.push(url);
      return new Response(JSON.stringify({ data: catalog }), { status: 200 });
    }
    if (url === GATEWAY_CAPABILITIES) {
      otherCalls.push(url);
      return new Response(JSON.stringify(capabilityBody), { status: 200 });
    }
    chatBodies.push(String(init?.body));
    const reply = chatReplies.shift();
    if (!reply) throw new Error(`unexpected chat call to ${url}`);
    return reply();
  }) as typeof fetch;
  setIngestContext({
    dbManager: { getSessionStore: () => sessions, getMediaStore: () => media } as any,
    sessionManager: { queueObservation: async (_id: number, observation: any) => { queued.push(observation); } } as any,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {},
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  settingsSpy.mockRestore();
  modeSpy.mockRestore();
  logSpies.forEach(spy => spy.mockRestore());
  db.close();
  rmSync(dir, { recursive: true, force: true });
});


const screenshotResponse = (...images: string[]) => ({
  content: [
    { type: 'text', text: 'Took screenshots of the viewport.' },
    ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
  ],
});

async function ingest(toolUseId: string, ...images: string[]) {
  return ingestObservation({
    contentSessionId: 'media-session', toolName: 'mcp__browser__screenshot', toolInput: { action: 'screenshot' },
    toolResponse: screenshotResponse(...images), cwd: join(dir, 'project'), platformSource: 'claude', toolUseId,
  } as any);
}

function sessionDbId(): number {
  return (db.prepare(`SELECT id FROM sdk_sessions WHERE content_session_id='media-session'`).get() as { id: number }).id;
}

function makeSession(): ActiveSession {
  const id = sessionDbId();
  sessions.updateMemorySessionId(id, 'openrouter-media-session-1');
  return {
    sessionDbId: id, contentSessionId: 'media-session', memorySessionId: 'openrouter-media-session-1',
    project: 'project', platformSource: 'claude', userPrompt: 'look at the UI',
    abortController: new AbortController(), generatorPromise: null, lastPromptNumber: 1, startTime: Date.now(),
    cumulativeInputTokens: 0, cumulativeOutputTokens: 0, earliestPendingTimestamp: null, claimedMessageIds: [1],
    conversationHistory: [
      { role: 'user', content: 'Start observing the primary session.' },
      { role: 'assistant', content: '<skip_summary reason="noise" />' },
    ],
    currentProvider: 'openrouter', consecutiveRestarts: 0, lastGeneratorActivity: Date.now(),
  } as unknown as ActiveSession;
}

function pending(observation: any, id = 1): PendingMessageWithId {
  return { ...observation, type: 'observation', _persistentId: id, _originalTimestamp: Date.now() };
}

function provider(claimed: () => PendingMessageWithId[]) {
  const dbManager = {
    getSessionStore: () => sessions,
    getMediaStore: () => media,
    getChromaSync: () => null,
    getCloudSync: () => ({ notify: () => { cloudNotifies++; } }),
  };
  const sessionManager = {
    getClaimedMessages: claimed,
    confirmClaimedMessages: async () => { confirmHook(); confirmed++; return 1; },
    resetProcessingToPending: async () => 0,
  };
  return new OpenRouterProvider(dbManager as any, sessionManager as any);
}

const directConfig = (model = IMAGE_MODEL) => ({
  apiKey: 'sk-or-test', apiKeys: ['sk-or-test'], model, fallbackModels: [], apiUrl: OPENROUTER_CHAT, appName: 'claude-mem',
});
const gatewayConfig = () => ({
  apiKey: MEMORY_KEY, apiKeys: [MEMORY_KEY], model: 'cmem-observer', fallbackModels: [], apiUrl: GATEWAY_CHAT, appName: 'claude-mem',
});

async function runTurn(message: PendingMessageWithId, config: object, session = makeSession()) {
  // makeSession registers the memory session id the stored rows reference.
  const observer = provider(() => [message]);
  await (observer as any).processObservationMessage(session, message, undefined, config, message._originalTimestamp, join(dir, 'project'));
  return session;
}

const reply = (xml: string) => () => new Response(JSON.stringify({ choices: [{ message: { content: xml } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200 });
const rows = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params as never[]) as any[];
const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params as never[]) as { n: number }).n;

async function decodedPixel(dataUrl: string) {
  expect(dataUrl.startsWith('data:image/webp;base64,')).toBe(true);
  const bytes = Buffer.from(dataUrl.slice('data:image/webp;base64,'.length), 'base64');
  const metadata = await sharp(bytes).metadata();
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  return { format: metadata.format, width: metadata.width, height: metadata.height, bytes: bytes.length, rgb: [data[0], data[1], data[2]] };
}

const near = (actual: number[], expected: typeof RED) =>
  Math.abs(actual[0] - expected.r) <= 6 && Math.abs(actual[1] - expected.g) <= 6 && Math.abs(actual[2] - expected.b) <= 6;

describe('image request boundary', () => {
  it('sends the derivative pixels text-first on the final user message only, with labels and no base64 in text', async () => {
    await ingest('toolu_two', redPng, bluePng);
    const message = pending(queued[0]);
    expect(message.mediaRefs?.map(ref => ref.label)).toEqual(['event1_image1', 'event1_image2']);
    chatReplies.push(reply(fixtureText('observation-with-refs.xml')));

    const session = await runTurn(message, directConfig());

    expect(chatBodies).toHaveLength(1);
    const body = JSON.parse(chatBodies[0]);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    for (const earlier of messages.slice(0, -1)) expect(typeof earlier.content).toBe('string');
    const parts = messages.at(-1)!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(messages.at(-1)!.role).toBe('user');
    expect(parts.map(part => part.type)).toEqual(['text', 'text', 'text', 'image_url', 'text', 'image_url']);
    expect(parts[0].text).toBe(session.conversationHistory.find(turn => turn.content.includes('<observed_from_primary_session>'))!.content);
    expect(parts[1].text).toBe('Images attached to this turn: event1_image1, event1_image2. Each image follows a line [image LABEL]. In each <observation> informed by an image, list the label inside <attachments><attachment>LABEL</attachment></attachments>. Use only these labels.');
    expect(parts[2].text).toBe('[image event1_image1]');
    expect(parts[4].text).toBe('[image event1_image2]');
    expect(Object.keys(parts[3].image_url!)).toEqual(['url']);
    expect('input_references' in body).toBe(false);

    const first = await decodedPixel(parts[3].image_url!.url);
    const second = await decodedPixel(parts[5].image_url!.url);
    expect(first).toMatchObject({ format: 'webp', width: 320, height: 180 });
    expect(first.bytes).toBeLessThanOrEqual(262_144);
    expect(near(first.rgb, RED)).toBe(true);
    expect(near(second.rgb, BLUE)).toBe(true);
    // The LLM derivative, never the source PNG.
    expect(chatBodies[0]).not.toContain(redPng.slice(0, 48));

    // No encoded payload in any text part or history turn (the descriptor's
    // `"type":"base64"` source tag is text, not data).
    const encodedRun = /[A-Za-z0-9+/]{120,}/;
    for (const part of parts.filter(part => part.type === 'text')) {
      expect(part.text).not.toMatch(encodedRun);
      expect(part.text).not.toContain('data:image');
    }
    for (const turn of session.conversationHistory) {
      expect(typeof turn.content).toBe('string');
      expect(turn.content).not.toContain('data:image');
      expect(turn.content).not.toMatch(encodedRun);
    }
  });

  it('a text-only turn is byte-identical whether or not its event has images, when inference is off', async () => {
    await ingest('toolu_off', redPng);
    const withRefs = pending(queued[0]);
    const withoutRefs = pending({ ...queued[0], mediaRefs: undefined, mediaEventKey: undefined });
    settings.CLAUDE_MEM_MEDIA_INFERENCE_ENABLED = 'false';
    const xml = '<observation><type>discovery</type><title>Viewport</title></observation>';
    chatReplies.push(reply(xml), reply(xml));
    const fixedNow = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => fixedNow);
    try {
      await runTurn({ ...withoutRefs, _originalTimestamp: fixedNow }, directConfig());
      await runTurn({ ...withRefs, _originalTimestamp: fixedNow }, directConfig());
    } finally {
      clock.mockRestore();
    }
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]).toBe(chatBodies[0]);
    expect(chatBodies[0]).not.toContain('image_url');
    expect(otherCalls).toEqual([]);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
  });

  it('an unqualified model sends today\'s text-only request and claims no images were read', async () => {
    await ingest('toolu_text_model', redPng);
    catalog = TEXT_ONLY_CATALOG;
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title><attachments><attachment>event1_image1</attachment></attachments></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    expect(chatBodies[0]).not.toContain('image_url');
    expect(JSON.parse(chatBodies[0]).messages.every((entry: { content: unknown }) => typeof entry.content === 'string')).toBe(true);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    const metadata = rows('SELECT metadata FROM observations')[0].metadata;
    expect(metadata).toBeNull();
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
    expect(count('SELECT COUNT(*) n FROM media_event_refs')).toBe(1);
  });

  it('later requests carry no image parts: refs never enter history', async () => {
    await ingest('toolu_once', redPng);
    await ingest('toolu_text', );
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport red</title></observation>'));
    chatReplies.push(reply('<observation><type>change</type><title>Next step</title></observation>'));
    const session = await runTurn(pending(queued[0], 1), directConfig());
    const observer = provider(() => [pending(queued[1], 2)]);
    await (observer as any).processObservationMessage(session, pending(queued[1], 2), undefined, directConfig(), Date.now(), join(dir, 'project'));
    expect(chatBodies[0]).toContain('image_url');
    expect(chatBodies[1]).not.toContain('image_url');
    expect(chatBodies[1]).not.toContain('data:image');
    expect(JSON.parse(chatBodies[1]).messages.every((entry: { content: unknown }) => typeof entry.content === 'string')).toBe(true);
  });
});

describe('gateway lane', () => {
  it('uses the gateway capability response and resends once text-only on media_request_invalid', async () => {
    await ingest('toolu_gateway', redPng);
    catalog = TEXT_ONLY_CATALOG; // local catalogue disagrees; the gateway decides
    chatReplies.push(
      () => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'Bad request', detail: 'media_request_invalid:too_many_images', request_id: 'req_1' } }), { status: 400 }),
      reply('<observation><type>discovery</type><title>Viewport</title><attachments><attachment>event1_image1</attachment></attachments></observation>'),
    );
    await runTurn(pending(queued[0]), gatewayConfig());
    expect(otherCalls).toEqual([GATEWAY_CAPABILITIES]);
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]).toContain('image_url');
    expect(chatBodies[1]).not.toContain('image_url');
    expect(JSON.parse(chatBodies[1]).messages.every((entry: { content: unknown }) => typeof entry.content === 'string')).toBe(true);
    // Text outcome stored; the image stays uninspected on its event.
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(rows('SELECT metadata FROM observations')[0].metadata).toBeNull();
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
  });

  it('a gateway-qualified turn links inspected refs', async () => {
    await ingest('toolu_gateway_ok', redPng);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(pending(queued[0]), gatewayConfig());
    expect(JSON.parse(chatBodies[0]).model).toBe('cmem-observer');
    expect(rows('SELECT label, inspection FROM observation_media_links')).toEqual([{ label: 'event1_image1', inspection: 'inspected' }]);
  });
});

describe('linkage and durable results', () => {
  const manifestOf = (observationId: number) => JSON.parse(rows('SELECT metadata FROM observations WHERE id=?', observationId)[0].metadata).cmem_media_v1;

  it('explicit refs on two observations become inspected links, committed before the batch is confirmed', async () => {
    await ingest('toolu_links', redPng, bluePng);
    const message = pending(queued[0]);
    const [first, second] = message.mediaRefs!;
    chatReplies.push(reply(fixtureText('observation-with-refs.xml')));
    let linksAtConfirm = -1;
    confirmHook = () => { linksAtConfirm = count('SELECT COUNT(*) n FROM observation_media_links'); };
    await runTurn(message, directConfig());

    expect(confirmed).toBe(1);
    expect(linksAtConfirm).toBe(3);
    const observations = rows('SELECT id, title FROM observations ORDER BY id');
    expect(observations).toHaveLength(2);
    expect(manifestOf(observations[0].id)).toEqual({ version: 1, attachments: [{ id: first.id, label: 'event1_image1', inspection: 'inspected' }] });
    expect(manifestOf(observations[1].id)).toEqual({ version: 1, attachments: [
      { id: second.id, label: 'event1_image2', inspection: 'inspected' },
      { id: first.id, label: 'event1_image1', inspection: 'inspected' },
    ] });
    expect(rows('SELECT observation_id, attachment_id, label, inspection FROM observation_media_links ORDER BY observation_id, label')).toEqual([
      { observation_id: observations[0].id, attachment_id: first.id, label: 'event1_image1', inspection: 'inspected' },
      { observation_id: observations[1].id, attachment_id: first.id, label: 'event1_image1', inspection: 'inspected' },
      { observation_id: observations[1].id, attachment_id: second.id, label: 'event1_image2', inspection: 'inspected' },
    ]);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
    expect(rows('SELECT observation_id FROM media_event_results ORDER BY observation_id').map(row => row.observation_id)).toEqual(observations.map(row => row.id));
    // Freshly inserted rows keep their first revision; they never synced.
    expect(rows('SELECT CAST(sync_rev AS TEXT) AS rev FROM observations').map(row => row.rev)).toEqual(['1', '1']);
    // The stored assistant turn has labels only.
    expect(rows('SELECT metadata FROM observations').every(row => !String(row.metadata).includes('base64'))).toBe(true);
  });

  it('a single observation that omits labels links every supplied image', async () => {
    await ingest('toolu_single', redPng, bluePng);
    chatReplies.push(reply('<observation><type>discovery</type><title>Two screenshots</title></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    expect(rows('SELECT label, inspection FROM observation_media_links ORDER BY label')).toEqual([
      { label: 'event1_image1', inspection: 'inspected' },
      { label: 'event1_image2', inspection: 'inspected' },
    ]);
  });

  it('multiple observations that omit labels link nothing; images stay event-level and uninspected', async () => {
    await ingest('toolu_multi', redPng, bluePng);
    chatReplies.push(reply('<observation><type>discovery</type><title>First</title></observation><observation><type>change</type><title>Second</title></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    expect(count('SELECT COUNT(*) n FROM observations')).toBe(2);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM media_event_refs')).toBe(2);
    expect(rows('SELECT metadata FROM observations').every(row => row.metadata === null)).toBe(true);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
  });

  it('invalid and unknown labels link nothing and never fall back to implicit association', async () => {
    await ingest('toolu_invalid', redPng);
    chatReplies.push(reply('<observation><type>discovery</type><title>Shot</title><attachments><attachment>../secret.png</attachment><attachment>event1_image3</attachment></attachments></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    const logged = JSON.stringify(logSpies.flatMap(spy => spy.mock.calls));
    expect(logged).not.toContain('secret.png');
    expect(logged).toContain('invalid_label');
  });

  it('a skip records the event result as skipped and links nothing', async () => {
    await ingest('toolu_skip', redPng);
    chatReplies.push(reply('<skip_summary reason="noise" />'));
    await runTurn(pending(queued[0]), directConfig());
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'skipped' }]);
  });

  it('merging into an already-synced native row keeps old refs and emits a higher revision', async () => {
    await ingest('toolu_merge', redPng);
    const message = pending(queued[0]);
    const oldRef = { id: '99999999-9999-4999-8999-999999999999', label: 'event1_image1', inspection: 'inspected' };
    // The same title/narrative in this memory session is an exact duplicate: storage returns the existing row.
    makeSession();
    sessions.storeObservations('openrouter-media-session-1', 'project', [{
      type: 'discovery', title: 'Viewport', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
      metadata: JSON.stringify({ other_namespace: { keep: true }, cmem_media_v1: { version: 1, attachments: [oldRef] } }),
    }], null, 1);
    const existing = rows('SELECT id FROM observations')[0].id;
    db.prepare(`UPDATE observations SET sync_rev='7', synced_at=123 WHERE id=?`).run(existing);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(message, directConfig());

    expect(count('SELECT COUNT(*) n FROM observations')).toBe(1);
    const row = rows('SELECT metadata, CAST(sync_rev AS TEXT) AS rev, synced_at FROM observations WHERE id=?', existing)[0];
    expect(row.rev).toBe('8');
    expect(row.synced_at).toBeNull();
    const metadata = JSON.parse(row.metadata);
    expect(metadata.other_namespace).toEqual({ keep: true });
    expect(metadata.cmem_media_v1.attachments).toEqual([oldRef, { id: message.mediaRefs![0].id, label: 'event1_image1', inspection: 'inspected' }]);
    expect(cloudNotifies).toBeGreaterThan(0);

    // A re-link that changes nothing changes no revision.
    queued.length = 0;
    await ingest('toolu_merge_again', redPng);
    db.prepare(`UPDATE observations SET synced_at=456 WHERE id=?`).run(existing);
    const replayRef = queued[0].mediaRefs[0];
    expect(replayRef.id).not.toBe(message.mediaRefs![0].id);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    expect(rows('SELECT CAST(sync_rev AS TEXT) AS rev FROM observations WHERE id=?', existing)[0].rev).toBe('9');
    const unchangedBefore = rows('SELECT metadata FROM observations WHERE id=?', existing)[0].metadata;
    db.prepare(`UPDATE observations SET synced_at=789 WHERE id=?`).run(existing);
    // Same event again (explicit replay of an identical link set) through the writer.
    const { writeObservationMediaLinks } = await import('../../src/services/media/linkage.js');
    const relink = db.transaction(() => writeObservationMediaLinks(db, [{ observationId: existing, insertedThisTurn: false, refs: [{ ...replayRef, inspection: 'inspected', eventKey: queued[0].mediaEventKey }] }]))();
    expect(relink.changedNativeRows).toEqual([]);
    expect(rows('SELECT metadata, CAST(sync_rev AS TEXT) AS rev, synced_at FROM observations WHERE id=?', existing)[0]).toEqual({ metadata: unchangedBefore, rev: '9', synced_at: 789 });
  });

  it('never mutates a replica row: its refs stay event-level', async () => {
    await ingest('toolu_replica', redPng);
    makeSession();
    sessions.storeObservations('openrouter-media-session-1', 'project', [{
      type: 'discovery', title: 'Viewport', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
    }], null, 1);
    const replica = rows('SELECT id FROM observations')[0].id;
    db.prepare(`UPDATE observations SET origin_device_id='other-device', sync_rev='5', synced_at=1 WHERE id=?`).run(replica);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    expect(rows('SELECT metadata, CAST(sync_rev AS TEXT) AS rev, synced_at FROM observations WHERE id=?', replica)[0]).toEqual({ metadata: null, rev: '5', synced_at: 1 });
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM media_event_refs')).toBe(1);
  });

  it('a full row keeps its 32 refs, marks overflow and leaves the new image on its event', async () => {
    await ingest('toolu_overflow', redPng);
    const attachments = Array.from({ length: 32 }, (_, index) => ({
      id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`, label: 'event1_image1', inspection: 'inspected',
    }));
    makeSession();
    sessions.storeObservations('openrouter-media-session-1', 'project', [{
      type: 'discovery', title: 'Viewport', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
      metadata: JSON.stringify({ cmem_media_v1: { version: 1, attachments } }),
    }], null, 1);
    const full = rows('SELECT id FROM observations')[0].id;
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    const manifest = manifestOf(full);
    expect(manifest.attachments).toEqual(attachments);
    expect(manifest.overflow).toBe(true);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM media_event_refs')).toBe(1);
  });

  it('an invalid existing manifest is never overwritten and the text result still commits', async () => {
    await ingest('toolu_bad_manifest', redPng);
    makeSession();
    sessions.storeObservations('openrouter-media-session-1', 'project', [{
      type: 'discovery', title: 'Viewport', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
      metadata: JSON.stringify({ cmem_media_v1: { version: 2, attachments: [] } }),
    }], null, 1);
    const id = rows('SELECT id FROM observations')[0].id;
    const before = rows('SELECT metadata FROM observations WHERE id=?', id)[0].metadata;
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    expect(rows('SELECT metadata FROM observations WHERE id=?', id)[0].metadata).toBe(before);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
  });

  it('a crash after the observation write keeps the links, and replay recovers without another model call', async () => {
    await ingest('toolu_crash', redPng);
    const message = pending(queued[0]);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    confirmHook = () => { throw new Error('worker died before confirming the RAM batch'); };
    await expect(runTurn(message, directConfig())).rejects.toThrow('worker died');
    expect(chatBodies).toHaveLength(1);
    expect(rows('SELECT label, inspection FROM observation_media_links')).toEqual([{ label: 'event1_image1', inspection: 'inspected' }]);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);

    // The same platform event arrives again after restart.
    queued.length = 0;
    const replay = await ingest('toolu_crash', redPng);
    expect(replay).toEqual({ ok: true, status: 'skipped', reason: 'already_processed' });
    expect(queued).toEqual([]);
    expect(chatBodies).toHaveLength(1);
    expect(count('SELECT COUNT(*) n FROM media_attachments')).toBe(1);
    expect(count('SELECT COUNT(*) n FROM observations')).toBe(1);
  });

  it('an unprocessed event is re-queued on replay as before', async () => {
    await ingest('toolu_unprocessed', redPng);
    queued.length = 0;
    expect(await ingest('toolu_unprocessed', redPng)).toEqual({ ok: true, sessionDbId: sessionDbId() });
    expect(queued).toHaveLength(1);
  });

  it('deleting a linked observation removes its links and results through the trigger', async () => {
    await ingest('toolu_delete', redPng);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(pending(queued[0]), directConfig());
    const id = rows('SELECT id FROM observations')[0].id;
    db.prepare('DELETE FROM observations WHERE id=?').run(id);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM media_event_results')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM media_event_refs')).toBe(1);
  });

  it('a batch of two source events maps request labels to each event and stores event labels', async () => {
    await ingest('toolu_batch_a', redPng);
    await ingest('toolu_batch_b', bluePng);
    const messages = [pending(queued[0], 1), pending(queued[1], 2)];
    const prepared = await prepareTurnImages(messages, id => media.readVariant(id, 'llm'), LOCAL_IMAGE_REQUEST_BOUNDS);
    expect(prepared.images.map(image => [image.requestLabel, image.eventLabel])).toEqual([
      ['event1_image1', 'event1_image1'],
      ['event2_image1', 'event1_image1'],
    ]);
    const session = makeSession();
    const context = snapshotResponseContext(session, freezeResponseMedia(prepared, true));
    expect(Object.isFrozen(context.media)).toBe(true);
    expect(JSON.stringify(context.media)).not.toContain('data:image');
    const xml = '<observation><type>discovery</type><title>Before</title><attachments><attachment>event1_image1</attachment></attachments></observation>'
      + '<observation><type>change</type><title>After</title><attachments><attachment>event2_image1</attachment></attachments></observation>'
      + '<observation><type>change</type><title>Both</title><attachments><attachment>event1_image1</attachment><attachment>event2_image1</attachment></attachments></observation>';
    // Mutating session state after the send cannot re-target labels.
    session.claimedMessageIds = [];
    await processAgentResponse(xml, session, {
      getSessionStore: () => sessions, getMediaStore: () => media, getChromaSync: () => null, getCloudSync: () => ({ notify: () => {} }),
    } as any, {
      getClaimedMessages: () => [], confirmClaimedMessages: async () => 1, resetProcessingToPending: async () => 0,
    } as any, undefined, 0, Date.now(), 'OpenRouter', join(dir, 'project'), IMAGE_MODEL, context);

    const observations = rows('SELECT id, title FROM observations ORDER BY id');
    expect(observations.map(row => row.title)).toEqual(['Before', 'After', 'Both']);
    const links = rows('SELECT observation_id, attachment_id, event_key, label FROM observation_media_links ORDER BY observation_id');
    expect(links).toEqual([
      { observation_id: observations[0].id, attachment_id: messages[0].mediaRefs![0].id, event_key: messages[0].mediaEventKey, label: 'event1_image1' },
      { observation_id: observations[1].id, attachment_id: messages[1].mediaRefs![0].id, event_key: messages[1].mediaEventKey, label: 'event1_image1' },
    ]);
    // Cross-event refs on the third observation link nothing.
    expect(rows('SELECT metadata FROM observations WHERE id=?', observations[2].id)[0].metadata).toBeNull();
    expect(rows('SELECT result_state FROM media_events ORDER BY event_key').map(row => row.result_state)).toEqual(['stored', 'stored']);
  });
});

describe('turn image selection', () => {
  it('sends at most four images in event then ordinal order, skipping unreadable derivatives', async () => {
    const refs = (eventLabel: number[]) => eventLabel.map(ordinal => ({
      id: `0000000${ordinal}-1111-4111-8111-11111111111${ordinal}`, label: `event1_image${ordinal}`, inspection: 'uninspected' as const,
    }));
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: RED } }).webp().toBuffer();
    const messages = [
      { mediaEventKey: 'a'.repeat(64), mediaRefs: refs([2, 1, 3]) },
      { mediaEventKey: 'b'.repeat(64), mediaRefs: refs([1, 2]) },
    ];
    const unreadable = '00000003-1111-4111-8111-111111111113';
    const prepared = await prepareTurnImages(messages, async id => {
      if (id === unreadable) throw new Error('not ready');
      return webp;
    }, LOCAL_IMAGE_REQUEST_BOUNDS);
    expect(prepared.images.map(image => image.requestLabel)).toEqual(['event1_image1', 'event1_image2', 'event2_image1', 'event2_image2']);
    expect(prepared.events.map(event => event.ordinal)).toEqual([1, 2]);
  });

  it('honors the capability bounds and rejects non-WebP or oversized derivatives', async () => {
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: RED } }).webp().toBuffer();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: RED } }).png().toBuffer();
    const messages = [{ mediaEventKey: 'c'.repeat(64), mediaRefs: [1, 2, 3].map(ordinal => ({
      id: `0000000${ordinal}-1111-4111-8111-11111111111${ordinal}`, label: `event1_image${ordinal}`, inspection: 'uninspected' as const,
    })) }];
    const bytesById: Record<string, Buffer> = {
      '00000001-1111-4111-8111-111111111111': png,
      '00000002-1111-4111-8111-111111111112': Buffer.concat([webp, Buffer.alloc(262_145)]),
      '00000003-1111-4111-8111-111111111113': webp,
    };
    const prepared = await prepareTurnImages(messages, async id => bytesById[id], LOCAL_IMAGE_REQUEST_BOUNDS);
    expect(prepared.images.map(image => image.requestLabel)).toEqual(['event1_image3']);
    const one = await prepareTurnImages(messages, async () => webp, { ...LOCAL_IMAGE_REQUEST_BOUNDS, max_images_per_request: 1 });
    expect(one.images).toHaveLength(1);
    const noWebp = await prepareTurnImages(messages, async () => webp, { ...LOCAL_IMAGE_REQUEST_BOUNDS, image_mime_types: ['image/png'] });
    expect(noWebp.images).toHaveLength(0);
  });
});

describe('verification fixes', () => {
  it('a failed link write keeps the observation and the durable event result; replay makes no second model call', async () => {
    await ingest('toolu_link_fail', redPng);
    const message = pending(queued[0]);
    db.exec(`CREATE TRIGGER fail_links BEFORE INSERT ON observation_media_links BEGIN SELECT RAISE(ABORT,'disk failure'); END;`);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(message, directConfig());

    expect(confirmed).toBe(1);
    expect(count('SELECT COUNT(*) n FROM observations')).toBe(1);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    // The manifest write rolled back with the junctions (same savepoint).
    expect(rows('SELECT metadata FROM observations')[0].metadata).toBeNull();
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
    expect(count('SELECT COUNT(*) n FROM media_event_results')).toBe(1);
    const errorCalls = (logSpies[3] as any).mock.calls.filter((call: any[]) => String(call[1]).includes('media links were not written'));
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][2]).toEqual({ sessionId: sessionDbId(), code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(JSON.stringify(errorCalls)).not.toContain('disk failure');

    queued.length = 0;
    expect(await ingest('toolu_link_fail', redPng)).toEqual({ ok: true, status: 'skipped', reason: 'already_processed' });
    expect(queued).toEqual([]);
    expect(chatBodies).toHaveLength(1);
  });

  it('a skip whose event result cannot be written is not confirmed', async () => {
    await ingest('toolu_skip_fail', redPng);
    db.exec(`CREATE TRIGGER fail_results BEFORE UPDATE ON media_events BEGIN SELECT RAISE(ABORT,'disk failure'); END;`);
    chatReplies.push(reply('<skip_summary reason="noise" />'));
    const session = makeSession();
    session.memorySessionId = null;
    await expect(runTurn(pending(queued[0]), directConfig(), session))
      .rejects.toThrow();
    expect(confirmed).toBe(0);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'unprocessed' }]);
  });

  it('images that would push the body past the capability bound are left out, uninspected', async () => {
    await ingest('toolu_body_bound', redPng);
    capabilityBody = { ...QUALIFIED_RESPONSE, bounds: { ...QUALIFIED_RESPONSE.bounds, max_body_bytes: 1 } };
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    await runTurn(pending(queued[0]), gatewayConfig());
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).not.toContain('image_url');
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
    expect(rows('SELECT result_state FROM media_events')).toEqual([{ result_state: 'stored' }]);
  });

  it('fits images in request order within the serialized body bound', () => {
    const small = { requestLabel: 'event1_image1', eventOrdinal: 1, eventKey: 'k', attachmentId: 'a', eventLabel: 'event1_image1', dataUrl: 'data:image/webp;base64,' + 'A'.repeat(400) };
    const large = { ...small, requestLabel: 'event1_image2', eventLabel: 'event1_image2', dataUrl: 'data:image/webp;base64,' + 'A'.repeat(4000) };
    const third = { ...small, requestLabel: 'event1_image3', eventLabel: 'event1_image3' };
    const messages = [{ role: 'user' as const, content: 'turn' }];
    const build = (body: any) => buildOpenRouterRequestBody({ model: 'm', fallbackModels: [], messages: body, apiUrl: OPENROUTER_CHAT, maxOutputTokens: 4096 });
    const textBytes = Buffer.byteLength(JSON.stringify(build(messages)));
    const fitted = fitTurnImagesToBody(messages, { images: [small, large, third], maxBodyBytes: textBytes + 1500 }, build)!;
    expect(fitted.images.map(image => image.requestLabel)).toEqual(['event1_image1', 'event1_image3']);
    expect(Buffer.byteLength(JSON.stringify(build(fitted.messages)))).toBeLessThanOrEqual(textBytes + 1500);
    expect(JSON.stringify(fitted.messages)).toContain('Images attached to this turn: event1_image1, event1_image3.');
    expect(fitTurnImagesToBody(messages, { images: [large], maxBodyBytes: textBytes + 10 }, build)).toBeNull();
  });

  it('never sends max_completion_tokens with images: that endpoint gets the turn text-only', async () => {
    await ingest('toolu_compat', redPng);
    chatReplies.push(
      () => new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }), { status: 400 }),
      reply('<observation><type>discovery</type><title>Viewport</title></observation>'),
    );
    await runTurn(pending(queued[0]), directConfig());
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]).toContain('image_url');
    expect(chatBodies[1]).not.toContain('image_url');
    expect(chatBodies.some(body => body.includes('image_url') && body.includes('max_completion_tokens'))).toBe(false);
    expect(count('SELECT COUNT(*) n FROM observation_media_links')).toBe(0);
  });

  it('leftover claimed events get a result but none of this turn\'s observation rows', async () => {
    await ingest('toolu_turn', redPng);
    await ingest('toolu_leftover', bluePng);
    const message = pending(queued[0], 1);
    const leftover = pending(queued[1], 2);
    chatReplies.push(reply('<observation><type>discovery</type><title>Viewport</title></observation>'));
    const observer = provider(() => [message, leftover]);
    await (observer as any).processObservationMessage(makeSession(), message, undefined, directConfig(), Date.now(), join(dir, 'project'));
    const stateOf = (key: string) => rows('SELECT result_state FROM media_events WHERE event_key=?', key)[0].result_state;
    expect(stateOf(message.mediaEventKey!)).toBe('stored');
    expect(stateOf(leftover.mediaEventKey!)).toBe('skipped');
    expect(count('SELECT COUNT(*) n FROM media_event_results WHERE event_key=?', message.mediaEventKey)).toBe(1);
    expect(count('SELECT COUNT(*) n FROM media_event_results WHERE event_key=?', leftover.mediaEventKey)).toBe(0);
  });
});
