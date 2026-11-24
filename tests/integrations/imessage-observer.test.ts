import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatWindowBatcher, type BatcherAction } from '../../src/integrations/imessage-observer/batcher';
import { GroupChatObserver, projectNameFor, slugify } from '../../src/integrations/imessage-observer/observer';
import { ReplaySource } from '../../src/integrations/imessage-observer/replay-source';
import { formatTranscript, normalizeNames, personLabel } from '../../src/integrations/imessage-observer/transcript';
import { fromPhotonGroupEvent, fromPhotonMessageEvent } from '../../src/integrations/imessage-observer/photon-source';
import type { ObserverEvent } from '../../src/integrations/imessage-observer/types';

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
      contacts: { '+15551230001': 'Jordan', 'sam@example.com': 'Sam', '+15551230003': 'Priya' },
      meLabel: 'Alex',
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
    expect(dinner.tool_input.members).toEqual(['Jordan', 'Phone ending 0002', 'Sam']);
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
});
