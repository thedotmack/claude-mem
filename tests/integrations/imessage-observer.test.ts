import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatWindowBatcher, type BatcherAction } from '../../src/integrations/imessage-observer/batcher';
import { GroupChatObserver, projectNameFor, slugify } from '../../src/integrations/imessage-observer/observer';
import { ReplaySource } from '../../src/integrations/imessage-observer/replay-source';
import { cleanMessageText, formatTranscript, normalizeNames, personLabel } from '../../src/integrations/imessage-observer/transcript';
import { fromPhotonGroupEvent, fromPhotonMessageEvent, PhotonSource } from '../../src/integrations/imessage-observer/photon-source';
import { PhotonCloudError, PhotonCloudLines, SHARED_LINE_MESSAGE } from '../../src/integrations/imessage-observer/photon-cloud';
import { PhotonSignupError, signInWithPhoton, type CliResult } from '../../src/integrations/imessage-observer/photon-signup';
import type { ObserverEvent } from '../../src/integrations/imessage-observer/types';
import { envCredentials, pickSetupMode } from '../../src/npx-cli/commands/imessage';

const FEED = join(import.meta.dir, '..', 'fixtures', 'imessage', 'group-chats.jsonl');
const MIN = 60_000;
const silent = { info: () => {}, warn: () => {} };

function message(id: string, at: number, text = id, sender = '+15551230001'): ObserverEvent {
  return { type: 'message', chatGuid: 'any;+;g', messageGuid: id, sender, isFromMe: false, occurredAt: new Date(at), text, attachments: [] };
}

function windows(actions: BatcherAction[]) {
  return actions.filter((action): action is Extract<BatcherAction, { kind: 'window' }> => action.kind === 'window');
}

describe('ChatWindowBatcher', () => {
  const t0 = Date.parse('2026-11-21T10:00:00-08:00');

  it('hands over a window once the chat has been quiet', () => {
    const batcher = new ChatWindowBatcher();
    batcher.add(message('a', t0));
    batcher.add(message('b', t0 + MIN));
    expect(batcher.tick(t0 + 5 * MIN)).toEqual([]);
    const [window] = windows(batcher.tick(t0 + 11 * MIN));
    expect(window!.entries.map(entry => entry.id)).toEqual(['a', 'b']);
    expect(window!.first).toBe(true);
    expect(batcher.pendingEntries()).toBe(0);
  });

  it('hands over at the size cap and when a busy window gets old', () => {
    const batcher = new ChatWindowBatcher({ quietMs: 10 * MIN, maxEntries: 3, maxWindowMs: 30 * MIN, conversationGapMs: 4 * 60 * MIN });
    batcher.add(message('a', t0));
    batcher.add(message('b', t0 + MIN));
    expect(windows(batcher.add(message('c', t0 + 2 * MIN)))[0]!.entries).toHaveLength(3);
    for (let i = 0; i < 2; i += 1) batcher.add(message(`x${i}`, t0 + (5 + i * 9) * MIN));
    const [late] = windows(batcher.tick(t0 + 36 * MIN));
    expect(late!.first).toBe(false);
    expect(late!.entries.map(entry => entry.id)).toEqual(['x0', 'x1']);
  });

  it('starts a new conversation after a long silence and ends the old one', () => {
    const batcher = new ChatWindowBatcher();
    batcher.add(message('a', t0));
    const firstConversation = windows(batcher.tick(t0 + 15 * MIN))[0]!.conversation.id;
    const actions = batcher.add(message('b', t0 + 5 * 60 * MIN));
    expect(actions.map(action => action.kind)).toEqual(['end']);
    const next = windows(batcher.drain())[0]!;
    expect(next.conversation.id).not.toBe(firstConversation);
    expect(next.first).toBe(true);
  });

  it('applies edits, unsends and tapbacks to the open window only', () => {
    const batcher = new ChatWindowBatcher();
    batcher.add(message('a', t0, 'see you at 8'));
    batcher.add({ type: 'edited', chatGuid: 'any;+;g', messageGuid: 'a', text: 'see you at 7', occurredAt: new Date(t0 + 1000) });
    batcher.add(message('b', t0 + 2000, 'wrong chat'));
    batcher.add({ type: 'unsent', chatGuid: 'any;+;g', messageGuid: 'b', occurredAt: new Date(t0 + 3000) });
    batcher.add({ type: 'reaction', chatGuid: 'any;+;g', messageGuid: 'a', sender: '+15551230002', isFromMe: false, reaction: 'like', occurredAt: new Date(t0 + 4000) });
    const [window] = windows(batcher.tick(t0 + 20 * MIN));
    expect(window!.entries.map(entry => [entry.kind, entry.text])).toEqual([
      ['message', 'see you at 7'],
      ['reaction', 'liked "see you at 7"'],
    ]);
    // Changes to a message that was already handed over are never re-sent.
    expect(batcher.add({ type: 'edited', chatGuid: 'any;+;g', messageGuid: 'a', text: 'never mind', occurredAt: new Date(t0 + 21 * MIN) })).toEqual([]);
    expect(batcher.add({ type: 'reaction', chatGuid: 'any;+;g', messageGuid: 'a', isFromMe: true, reaction: 'love', occurredAt: new Date(t0 + 22 * MIN) })).toEqual([]);
    expect(batcher.pendingEntries()).toBe(0);
  });

  it('keeps tapbacks in step with the message they quote', () => {
    const batcher = new ChatWindowBatcher();
    const tapback = (id: string, at: number) => ({ type: 'reaction' as const, chatGuid: 'any;+;g', messageGuid: id, sender: '+15551230002', isFromMe: false, reaction: 'like', occurredAt: new Date(at) });
    batcher.add(message('a', t0, 'meet at 8'));
    batcher.add(tapback('a', t0 + 1000));
    batcher.add({ type: 'edited', chatGuid: 'any;+;g', messageGuid: 'a', text: 'meet at 9', occurredAt: new Date(t0 + 2000) });
    batcher.add(message('b', t0 + 3000, 'my code is <private>4821</private> ok'));
    batcher.add(tapback('b', t0 + 4000));
    batcher.add(message('c', t0 + 5000, 'oops'));
    batcher.add(tapback('c', t0 + 6000));
    batcher.add({ type: 'unsent', chatGuid: 'any;+;g', messageGuid: 'c', occurredAt: new Date(t0 + 7000) });
    const [window] = windows(batcher.tick(t0 + 20 * MIN));
    expect(window!.entries.map(entry => entry.text)).toEqual([
      'meet at 9',
      'liked "meet at 9"',
      'my code is <private>4821</private> ok',
      'liked "my code is ok"',
    ]);
  });

  it('starts the window clock again when an unsend empties the window', () => {
    const batcher = new ChatWindowBatcher({ quietMs: 10 * MIN, maxEntries: 50, maxWindowMs: 30 * MIN, conversationGapMs: 4 * 60 * MIN });
    batcher.add(message('a', t0));
    batcher.add({ type: 'unsent', chatGuid: 'any;+;g', messageGuid: 'a', occurredAt: new Date(t0 + MIN) });
    batcher.add(message('b', t0 + 25 * MIN), t0 + 25 * MIN);
    // Measured from the old message, the window would already be 31 minutes old.
    expect(batcher.tick(t0 + 31 * MIN)).toEqual([]);
  });
});

describe('transcript', () => {
  it('names people from contacts and never writes an unnamed full phone number', () => {
    const book = { names: normalizeNames({ '+1 (555) 123-0001': 'Jordan', 'Sam@Example.com': 'Sam' }), meLabel: 'Alex' };
    expect(personLabel('+15551230001', book)).toBe('Jordan');
    expect(personLabel('sam@example.com', book)).toBe('Sam');
    expect(personLabel('me', book)).toBe('Alex');
    expect(personLabel('+15551239876', book)).toBe('Phone ending 9876');
    const text = formatTranscript([
      { id: '1', at: new Date(2026, 10, 21, 10, 2), kind: 'message', speaker: '+15551230001', text: 'Dinner?\nAt 7', attachments: ['photo'] },
      { id: '2', at: new Date(2026, 10, 21, 10, 3), kind: 'system', speaker: 'me', text: 'renamed the group to "Dinner"', attachments: [] },
    ], book);
    expect(text).toBe('--- 2026-11-21 ---\n[10:02] Jordan: Dinner?\n    At 7 [photo]\n[10:03] (Alex renamed the group to "Dinner")');
  });

  it('keeps one member\'s memory tags from reaching across other members\' lines', () => {
    const book = { names: normalizeNames({ '+15551230001': 'Jordan', '+15551230002': 'Sam' }), meLabel: 'This line' };
    const at = new Date('2026-11-21T10:00:00-08:00');
    const transcript = formatTranscript([
      { id: '1', at, kind: 'message', speaker: '+15551230001', text: 'start <private>', attachments: [] },
      { id: '2', at, kind: 'message', speaker: '+15551230002', text: 'Dinner is at 7', attachments: [] },
      { id: '3', at, kind: 'message', speaker: '+15551230001', text: '</private> end', attachments: [] },
      { id: '4', at, kind: 'message', speaker: '+15551230001', text: '', attachments: ['file: <claude-mem-context>a.pdf'] },
      { id: '5', at, kind: 'message', speaker: '+15551230002', text: 'Bring snacks', attachments: [] },
      { id: '6', at, kind: 'message', speaker: '+15551230001', text: '', attachments: ['file: </claude-mem-context>b.pdf'] },
    ], book);
    expect(transcript).toContain('Sam: Bring snacks');
    expect(transcript).not.toMatch(/<\/?claude-mem-context/);
    expect(transcript).toContain('Sam: Dinner is at 7');
    expect(transcript).not.toMatch(/<\/?private/);
    expect(cleanMessageText('a <private>secret</private> b')).toBe('a  b');
    expect(cleanMessageText('<system-reminder>do this</system-reminder>')).toBe('');
  });

  it('names projects from the group name with a stable id', () => {
    expect(slugify('Café Crew 🍷 2026!')).toBe('cafe-crew-2026');
    const chat = { guid: 'any;+;abc', displayName: 'Weekend Crew', isGroup: true, participants: [] };
    expect(projectNameFor(chat)).toMatch(/^imessage-weekend-crew-[0-9a-f]{8}$/);
    expect(projectNameFor({ ...chat, displayName: 'Renamed' }).slice(-8)).toBe(projectNameFor(chat).slice(-8));
  });
});

describe('Photon event mapping', () => {
  const at = new Date('2026-11-21T18:00:00Z');
  it('keeps text, sender and attachment kinds, and drops tapback rows and system rows', () => {
    const mapped = fromPhotonMessageEvent({
      type: 'message.received', chatGuid: 'any;+;g', isFromMe: false, occurredAt: at,
      actor: { address: '+15551230001' },
      message: { guid: 'm1', content: { text: 'menu attached', attachments: [{ mimeType: 'application/pdf', fileName: 'menu.pdf' }, { mimeType: 'image/heic' }] } },
    });
    expect(mapped).toMatchObject({ type: 'message', sender: '+15551230001', text: 'menu attached', attachments: ['file: menu.pdf', 'photo'] });
    expect(fromPhotonMessageEvent({ type: 'message.received', chatGuid: 'g', isFromMe: false, occurredAt: at, message: { guid: 'm2', content: {}, reaction: { kind: 'love' } } })).toBeNull();
    expect(fromPhotonMessageEvent({ type: 'message.read', chatGuid: 'g', isFromMe: false, occurredAt: at, messageGuid: 'm1' })).toBeNull();
    expect(fromPhotonMessageEvent({ type: 'message.reactionAdded', chatGuid: 'g', isFromMe: true, occurredAt: at, messageGuid: 'm1', reaction: { kind: 'emoji', emoji: '🔥' } }))
      .toMatchObject({ type: 'reaction', reaction: '🔥', isFromMe: true });
  });

  it('maps group renames and member changes', () => {
    expect(fromPhotonGroupEvent({ type: 'group.changed', chatGuid: 'g', isFromMe: false, occurredAt: at, change: { type: 'displayNameChanged', displayName: 'New' } }))
      .toMatchObject({ type: 'renamed', displayName: 'New' });
    expect(fromPhotonGroupEvent({ type: 'group.changed', chatGuid: 'g', isFromMe: false, occurredAt: at, change: { type: 'participantLeft', participant: { address: 'x@example.com' } } }))
      .toMatchObject({ type: 'membership', change: 'left', person: 'x@example.com' });
  });
});

describe('GroupChatObserver end to end with a stub worker', () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ route: string; body: Record<string, any> }>;
  let failRoute: ((route: string, count: number) => boolean) | null;
  let dir: string;

  beforeEach(async () => {
    requests = [];
    failRoute = null;
    dir = mkdtempSync(join(tmpdir(), 'imessage-observer-'));
    let observationCount = 0;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const route = req.url ?? '';
        const body = JSON.parse(raw || '{}');
        if (route === '/api/sessions/observations') observationCount += 1;
        if (failRoute?.(route, observationCount)) {
          res.writeHead(503).end('{}');
          return;
        }
        requests.push({ route, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(route === '/api/sessions/init' ? { sessionDbId: requests.length, promptNumber: 1 } : { status: 'queued' }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const post = async (route: string, body: unknown) => {
    const response = await fetch(baseUrl + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${route} returned ${response.status}`);
    return response.json();
  };

  function observer() {
    return new GroupChatObserver({
      source: ReplaySource.fromFile(FEED),
      post,
      log: silent,
      statePath: join(dir, 'chats.json'),
      contacts: { '+15551230001': 'Jordan', '+15551230002': 'Alex', 'sam@example.com': 'Sam', '+15551230003': 'Priya' },
      clock: 'event',
    });
  }

  it('turns each group chat into its own project, with who said what', async () => {
    const run = observer();
    await run.run();

    const inits = requests.filter(request => request.route === '/api/sessions/init');
    const observations = requests.filter(request => request.route === '/api/sessions/observations');
    const projects = new Set(inits.map(request => request.body.project));
    // Two group chats; the direct chat is ignored; the weekend chat's 6-hour silence makes two conversations.
    expect(inits).toHaveLength(3);
    expect(projects.size).toBe(2);
    expect([...projects].every(project => /^imessage-(weekend-crew|launch-squad)-[0-9a-f]{8}$/.test(project))).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('This direct message must not be observed');
    expect(observations).toHaveLength(3);

    for (const request of requests) expect(request.body.platformSource).toBe('imessage');
    // Each conversation's init comes before its first window.
    for (const window of observations) {
      const initIndex = requests.findIndex(request => request.route === '/api/sessions/init' && request.body.contentSessionId === window.body.contentSessionId);
      expect(initIndex).toBeGreaterThanOrEqual(0);
      expect(initIndex).toBeLessThan(requests.indexOf(window));
    }

    const dinner = observations[0]!.body;
    expect(dinner.tool_name).toBe('iMessageGroupChat');
    expect(dinner.tool_input).toMatchObject({ chat: 'Weekend Crew', messages: 4 });
    expect(dinner.tool_input.members).toEqual(['Jordan', 'Alex', 'Sam']);
    expect(dinner.tool_response).toContain('Jordan: Dinner Saturday? I can book Flour + Water');
    expect(dinner.tool_response).toContain('Sam: Yes! 7pm works for me');
    expect(dinner.tool_response).toContain('Alex: I\'m in. Can we do 7:30 instead?');
    expect(dinner.tool_response).toContain('Jordan: Booked 7:30 for 4 under Jordan [photo]');
    expect(dinner.tool_response).toContain('(Sam loved "Booked 7:30 for 4 under Jordan")');
    expect(dinner.tool_response).not.toContain('oops wrong chat');
    expect(JSON.stringify(observations)).not.toMatch(/\+1555123000\d/);

    const dinnerInit = inits.find(request => request.body.contentSessionId === dinner.contentSessionId)!.body;
    expect(dinnerInit.prompt).toContain('Observe the iMessage group chat "Weekend Crew"');
    expect(dinnerInit.prompt).toContain('not a coding session');

    // The rename and the new member stay in the same project.
    const evening = observations.find(request => request.body.tool_response.includes('bring wine'))!.body;
    expect(evening.tool_response).toContain('(Sam renamed the group to "Saturday Dinner")');
    expect(evening.tool_response).toContain('(Jordan added Phone ending 0005)');
    expect(evening.tool_input.chat).toBe('Saturday Dinner');
    const projectOf = (contentSessionId: string) => inits.find(request => request.body.contentSessionId === contentSessionId)!.body.project;
    expect(projectOf(evening.contentSessionId)).toBe(projectOf(dinner.contentSessionId));

    // Every conversation that sent a window is summarized and closed.
    const summaries = requests.filter(request => request.route === '/api/sessions/summarize');
    const ends = requests.filter(request => request.route === '/api/sessions/session-end');
    expect(summaries).toHaveLength(3);
    expect(ends).toHaveLength(3);
    // The summary is written from the conversation's latest messages, not from nothing.
    const dinnerSummary = summaries.find(request => request.body.contentSessionId === dinner.contentSessionId)!;
    expect(dinnerSummary.body.last_assistant_message).toContain('"Weekend Crew"');
    expect(dinnerSummary.body.last_assistant_message).toContain('Flour + Water');

    const saved = JSON.parse(readFileSync(join(dir, 'chats.json'), 'utf8'));
    expect(Object.keys(saved.chats).sort()).toEqual(['any;+;chat-launch', 'any;+;chat-weekend-crew']);
    expect(JSON.stringify(saved)).not.toContain('Flour');
    expect(run.deliveredWindows).toHaveLength(3);
  });

  it('skips a window the worker could not take and never sends it later', async () => {
    failRoute = (route, count) => route === '/api/sessions/observations' && count === 1;
    const run = observer();
    await run.run();
    const observations = requests.filter(request => request.route === '/api/sessions/observations');
    expect(run.skippedWindows).toBe(1);
    expect(observations).toHaveLength(2);
    expect(JSON.stringify(observations)).not.toContain('Flour + Water');
    // Later conversations still start fresh.
    expect(observations.some(request => request.body.tool_response.includes('Launch moves to Tuesday'))).toBe(true);
  });

  it('starts nothing when the worker says the conversation is excluded', async () => {
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requests.push({ route: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/api/sessions/init' ? { skipped: true, reason: 'private' } : {}));
      });
    });
    await observer().run();
    expect(requests.every(request => request.route === '/api/sessions/init')).toBe(true);
  });

  it('sends nothing for a chat whose project matches CLAUDE_MEM_EXCLUDED_PROJECTS', async () => {
    const run = new GroupChatObserver({
      source: ReplaySource.fromFile(FEED), post, log: silent, statePath: join(dir, 'chats.json'), clock: 'event',
      excludedProjects: 'imessage-launch-*',
    });
    await run.run();
    expect(requests.some(request => JSON.stringify(request.body).includes('Launch'))).toBe(false);
    const observations = requests.filter(request => request.route === '/api/sessions/observations');
    expect(observations.length).toBeGreaterThan(0);
    for (const request of observations) expect(typeof request.body.enqueuedAtEpochMs).toBe('number');
  });

  it('sends nothing under a made-up name when the chat details cannot be read', async () => {
    const replay = ReplaySource.fromFile(FEED);
    const source = { name: 'stub', events: () => replay.events(), chat: async () => null, stop: () => replay.stop() };
    const run = new GroupChatObserver({ source, post, log: silent, statePath: join(dir, 'chats.json'), clock: 'event' });
    await run.run();
    expect(requests).toHaveLength(0);
    expect(run.skippedWindows).toBeGreaterThan(0);
    expect(() => readFileSync(join(dir, 'chats.json'), 'utf8')).toThrow();
  });

  it('keeps nothing of a window the worker skipped, so it is never summarized later', async () => {
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requests.push({ route: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/api/sessions/observations' ? { status: 'skipped', reason: 'expired_live_capture' } : { status: 'ok' }));
      });
    });
    const run = observer();
    await run.run();
    expect(run.skippedWindows).toBe(3);
    expect(requests.some(request => request.route === '/api/sessions/summarize')).toBe(false);
    expect(requests.filter(request => request.route === '/api/sessions/session-end')).toHaveLength(3);
  });

  it('skips windows instead of piling them up while the worker is behind', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = async (route: string, body: unknown) => { await gate; return post(route, body); };
    const run = new GroupChatObserver({ source: ReplaySource.fromFile(FEED), post: slow, log: silent, statePath: join(dir, 'chats.json'), clock: 'event', maxQueued: 1 });
    setTimeout(release, 50);
    await run.run();
    expect(run.skippedWindows).toBeGreaterThan(0);
    expect(run.deliveredWindows.length).toBeLessThan(3);
  });
});

describe('Photon source reconnects', () => {
  it.each(['rejected token', 'clean EOF'])('reconnects after %s, closing the quiet sibling first', async reason => {
    const dir = mkdtempSync(join(tmpdir(), 'photon-fake-'));
    const sdkDir = join(dir, 'node_modules', '@photon-ai', 'advanced-imessage', 'dist');
    mkdirSync(sdkDir, { recursive: true });
    // A stand-in SDK: the message stream fails at once, the group stream stays quiet until closed.
    writeFileSync(join(sdkDir, 'grpc.js'), `
      const fake = globalThis.__photonFake;
      function quiet() {
        let wake;
        const stream = {
          [Symbol.asyncIterator]() { return stream; },
          next() { return new Promise(resolve => { wake = resolve; }); },
          async return() { wake?.({ done: true, value: undefined }); return { done: true, value: undefined }; },
          async close() { fake.closed += 1; wake?.({ done: true, value: undefined }); },
        };
        return stream;
      }
      export function createGrpcClient() {
        fake.connects += 1;
        return {
          messages: { subscribeEvents() { return { async *[Symbol.asyncIterator]() { if (fake.reason === 'rejected token') throw new Error('16 UNAUTHENTICATED: invalid token'); }, async close() {} }; } },
          groups: { subscribeEvents() { return quiet(); } },
          chats: { async get() { throw new Error('unused'); } },
          async close() {},
        };
      }
    `);
    const fake = { connects: 0, closed: 0, rejections: 0, reason };
    (globalThis as any).__photonFake = fake;
    const source = new PhotonSource({ lines: async () => [{ address: 'line.test:443', token: async () => 't' }], installDir: dir, log: silent, onAuthRejected: () => { fake.rejections++; } });
    const iterator = source.events()[Symbol.asyncIterator]();
    const reading = iterator.next();
    const started = Date.now();
    while (fake.connects < 2 && Date.now() - started < 5_000) await new Promise(resolve => setTimeout(resolve, 50));
    await source.stop();
    await reading;
    rmSync(dir, { recursive: true, force: true });
    expect(fake.connects).toBeGreaterThanOrEqual(2);
    expect(fake.closed).toBeGreaterThanOrEqual(1);
    if (reason === 'rejected token') expect(fake.rejections).toBeGreaterThanOrEqual(1);
    else expect(fake.rejections).toBe(0);
  });
});

describe('Photon cloud lines', () => {
  function cloud(answers: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; auth: string }> = [];
    let clock = 0;
    const lines = new PhotonCloudLines({ projectId: 'proj_1', projectSecret: 's3cret' }, {
      baseUrl: 'https://photon.test',
      now: () => clock,
      fetch: async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization! });
        const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body, text: async () => '' };
      },
    });
    return { lines, calls, advance: (ms: number) => { clock += ms; } };
  }

  const dedicated = (token: string) => ({
    status: 200,
    body: { succeed: true, data: { type: 'dedicated', expiresIn: 600, auth: { 'line-a': token }, numbers: { 'line-a': '+15550001111' } } },
  });

  it('gives up, instead of retrying forever, on an answer it cannot read', async () => {
    const { lines } = cloud([{ status: 200, body: { succeed: false } }]);
    const error = await lines.lines().catch(e => e);
    expect(error).toBeInstanceOf(PhotonCloudError);
    expect((error as PhotonCloudError).fatal).toBe(true);
  });

  it('turns a dedicated line into an address and a renewed token', async () => {
    const { lines, calls, advance } = cloud([dedicated('t1'), dedicated('t2')]);
    const [line] = await lines.lines();
    expect(line).toMatchObject({ id: 'line-a', phone: '+15550001111', address: 'line-a.imsg.photon.codes:443' });
    expect(calls[0]).toEqual({ url: 'https://photon.test/projects/proj_1/imessage/tokens', auth: `Basic ${Buffer.from('proj_1:s3cret').toString('base64')}` });
    expect(await line!.token()).toBe('t1');
    advance(7 * MIN);
    expect(await line!.token()).toBe('t1');
    advance(2 * MIN); // past 80% of the 10 minute lifetime
    expect(await line!.token()).toBe('t2');
    expect(calls).toHaveLength(2);
  });

  it('renews a revoked stream token before its expiry, sharing a single exchange', async () => {
    const { lines, calls } = cloud([dedicated('old'), dedicated('fresh')]);
    const [line] = await lines.lines();
    expect(await line!.token()).toBe('old');
    lines.invalidateTokens();
    expect(await Promise.all([line!.token(), line!.token()])).toEqual(['fresh', 'fresh']);
    expect(calls).toHaveLength(2);
  });

  it('refuses a shared line, which cannot join group chats', async () => {
    const { lines } = cloud([{ status: 200, body: { succeed: true, data: { type: 'shared', token: 't', expiresIn: 600 } } }]);
    await expect(lines.lines()).rejects.toThrow(SHARED_LINE_MESSAGE);
  });

  it('says plainly when Photon rejects the project secret', async () => {
    const { lines } = cloud([{ status: 401, body: {} }]);
    const error = await lines.lines().catch(caught => caught);
    expect(error).toBeInstanceOf(PhotonCloudError);
    expect(error.message).toContain('did not accept');
    expect(error.message).not.toContain('s3cret');
  });
});

describe('Photon sign-in', () => {
  function io(answers: Record<string, CliResult>, picks: string[] = []) {
    const ran: string[][] = [];
    const logged: string[] = [];
    return {
      ran,
      logged,
      io: {
        run: (args: string[]) => {
          ran.push(args);
          return answers[args.join(' ')] ?? { status: 1, stdout: '' };
        },
        ask: async () => picks.shift() ?? '',
        log: (line: string) => logged.push(line),
      },
    };
  }
  const ok = (value: unknown, chatter = ''): CliResult => ({ status: 0, stdout: chatter + JSON.stringify(value) });

  it('signs in, picks the only project and reads its secret without rotating it', async () => {
    const { io: signup, ran } = io({
      login: { status: 0, stdout: '' },
      'projects ls --json': ok([{ id: 'proj_1', name: 'Group chats', platforms: ['imessage'] }], 'Authenticating...\n'),
      'projects secret proj_1 --json': ok({ id: 'proj_1', projectSecret: 'sec_1' }),
    });
    expect(await signInWithPhoton(signup)).toEqual({ projectId: 'proj_1', projectSecret: 'sec_1', projectName: 'Group chats' });
    expect(ran).toEqual([['login'], ['projects', 'ls', '--json'], ['projects', 'secret', 'proj_1', '--json']]);
    expect(ran.flat()).not.toContain('regenerate-secret');
  });

  it('asks which project when there are several', async () => {
    const { io: signup } = io({
      login: { status: 0, stdout: '' },
      'projects ls --json': ok([{ id: 'a', name: 'Work' }, { id: 'b', name: 'Friends' }]),
      'projects secret b --json': ok({ projectSecret: 'sec_b' }),
    }, ['9', '2']);
    expect((await signInWithPhoton(signup)).projectId).toBe('b');
  });

  it('points to the dashboard when the account has no project', async () => {
    const { io: signup } = io({ login: { status: 0, stdout: '' }, 'projects ls --json': ok([]) });
    await expect(signInWithPhoton(signup)).rejects.toThrow(/app\.photon\.codes/);
  });

  it('stops when the browser sign-in was not approved', async () => {
    const { io: signup, ran } = io({ login: { status: 1, stdout: '' } });
    await expect(signInWithPhoton(signup)).rejects.toBeInstanceOf(PhotonSignupError);
    expect(ran).toEqual([['login']]);
  });
});

describe('imessage setup', () => {
  const none = { projectFlags: false, lineFlags: false, envProject: false, envLine: false };

  it('lets flags on the command line beat variables left in the environment', () => {
    expect(pickSetupMode({ ...none, lineFlags: true, envProject: true })).toBe('line');
    expect(pickSetupMode({ ...none, projectFlags: true, envLine: true })).toBe('project');
    expect(pickSetupMode({ ...none, login: true, envProject: true })).toBe('login');
  });

  it('takes credentials from the environment only as a whole pair', () => {
    expect(envCredentials({ PHOTON_PROJECT_ID: 'proj_1' })).toEqual({ project: undefined, line: undefined });
    expect(envCredentials({ PHOTON_PROJECT_ID: 'proj_1', PHOTON_PROJECT_SECRET: 's' }).project).toEqual({ projectId: 'proj_1', projectSecret: 's' });
    expect(envCredentials({ PHOTON_IMESSAGE_TOKEN: 't' }).line).toBeUndefined();
    expect(envCredentials({ PHOTON_IMESSAGE_ADDRESS: 'h:443', PHOTON_IMESSAGE_TOKEN: 't' }).line).toEqual({ address: 'h:443', token: 't' });
  });

  it('falls back to the environment, then asks', () => {
    expect(pickSetupMode({ ...none, envProject: true })).toBe('project');
    expect(pickSetupMode({ ...none, envLine: true })).toBe('line');
    expect(pickSetupMode(none)).toBeNull();
  });
});
