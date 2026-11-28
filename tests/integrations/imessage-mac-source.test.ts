import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attributedBodyFor, textFromAttributedBody } from '../../src/integrations/imessage-observer/attributed-body';
import { checkChatDbAccess } from '../../src/integrations/imessage-observer/chatdb';
import { ChatDbSource } from '../../src/integrations/imessage-observer/chatdb-source';
import { MacSelection, parseSelection, updateChatChoice, withSelectionLock, writeSelection } from '../../src/integrations/imessage-observer/mac-selection';
import { GroupChatObserver } from '../../src/integrations/imessage-observer/observer';
import { conversationPrompt, personLabel } from '../../src/integrations/imessage-observer/transcript';
import type { ObserverEvent } from '../../src/integrations/imessage-observer/types';
import { FakeChatDb } from '../fixtures/imessage/fake-chat-db';

const GROUP = 'iMessage;+;chat123456789';
const OTHER_GROUP = 'iMessage;+;chat999';
const DIRECT = 'iMessage;-;+15551230003';
const ANA = '+15551230001';
const BEN = 'ben@example.com';
const CAL = '+15551230003';
const T0 = Date.parse('2026-11-25T18:00:00-08:00');
const MIN = 60_000;
const silent = { info: () => {}, warn: () => {} };
const book = { names: { '5551230001': 'Ana' }, meLabel: 'Me' };
const label = (address: string) => personLabel(address, book);

let dir: string;
let fake: FakeChatDb;

function seedChats(db: FakeChatDb): void {
  db.chat(GROUP, { name: 'Tahoe trip', group: true, members: [ANA, BEN] });
  db.chat(OTHER_GROUP, { group: true, members: [ANA, BEN, CAL, '+15551230004', '+15551230005'] });
  db.chat(DIRECT, { group: false, members: [CAL] });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmem-imsg-mac-'));
  fake = new FakeChatDb(join(dir, 'chat.db'));
  seedChats(fake);
});

afterEach(() => {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function source(observed: string[] = [GROUP, DIRECT]) {
  return new ChatDbSource({ dbPath: fake.path, label, isObserved: guid => observed.includes(guid), watch: false });
}

describe('attributedBody', () => {
  it('reads short, long and non-ASCII text back out of the blob Messages writes', () => {
    for (const text of ['Hi', 'x'.repeat(127), 'y'.repeat(128), 'z'.repeat(300), 'Cabin booked 🎉 café ☕', 'a'.repeat(70_000)]) {
      expect(textFromAttributedBody(attributedBodyFor(text))).toBe(text);
    }
  });

  it('returns null for blobs it cannot read, so the text column is used', () => {
    expect(textFromAttributedBody(null)).toBeNull();
    expect(textFromAttributedBody(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(textFromAttributedBody(new TextEncoder().encode('not a typedstream at all, just bytes'))).toBeNull();
    const cut = attributedBodyFor('a message that gets cut short');
    expect(textFromAttributedBody(cut.subarray(0, 90))).toBeNull();
  });
});

describe('ChatDbSource', () => {
  it('starts at "now": messages already in the database are never read', () => {
    fake.message({ chat: GROUP, guid: 'old-1', at: T0 - 60 * MIN, text: 'old news', from: ANA });
    const src = source();
    src.start();
    expect(src.poll()).toEqual([]);
    fake.message({ chat: GROUP, guid: 'new-1', at: T0, text: 'new', from: ANA });
    expect(src.poll().map(event => (event as { messageGuid: string }).messageGuid)).toEqual(['new-1']);
    expect(src.poll()).toEqual([]);
  });

  it('turns rows into observer events: text from attributedBody, attachments, tapbacks, renames, members joining and leaving', () => {
    const src = source();
    src.start();
    fake.message({ chat: GROUP, guid: 'm1', at: T0, text: 'Cabin is $1,200 for the weekend', bodyOnly: true, from: ANA });
    fake.message({ chat: GROUP, guid: 'm2', at: T0 + MIN, text: 'I can cover half', fromMe: true });
    fake.message({ chat: GROUP, guid: 'm3', at: T0 + 2 * MIN, text: 'menu', from: BEN, attachment: { name: 'menu.pdf', mime: 'application/pdf' } });
    fake.message({ chat: GROUP, guid: 'm4', at: T0 + 3 * MIN, from: BEN, attachment: { name: 'IMG_1.HEIC', mime: 'image/heic' } });
    fake.message({ chat: GROUP, guid: 't1', at: T0 + 4 * MIN, text: 'Loved “Cabin…”', from: BEN, tapback: { on: 'm1', type: 2000 } });
    fake.message({ chat: GROUP, guid: 't2', at: T0 + 5 * MIN, from: ANA, tapback: { on: 'm2', type: 2006, emoji: '🔥' } });
    fake.message({ chat: GROUP, guid: 't3', at: T0 + 6 * MIN, from: ANA, tapback: { on: 'm2', type: 3000 } });
    fake.message({ chat: GROUP, guid: 'r1', at: T0 + 7 * MIN, from: ANA, rename: 'Tahoe 2027' });
    fake.message({ chat: GROUP, guid: 'j1', at: T0 + 8 * MIN, fromMe: true, member: { person: CAL } });
    fake.message({ chat: GROUP, guid: 'j2', at: T0 + 9 * MIN, from: ANA, member: { person: BEN, removed: true } });
    fake.message({ chat: GROUP, guid: 'l1', at: T0 + 10 * MIN, from: BEN, left: true });

    const events = src.poll();
    expect(events.map(event => event.type)).toEqual(['message', 'message', 'message', 'message', 'reaction', 'reaction', 'reaction', 'renamed', 'membership', 'membership', 'membership']);
    const [m1, m2, m3, m4, t1, t2, t3, r1, j1, j2, l1] = events as Array<ObserverEvent & Record<string, unknown>>;
    expect(m1).toMatchObject({ chatGuid: GROUP, messageGuid: 'm1', sender: ANA, isFromMe: false, text: 'Cabin is $1,200 for the weekend' });
    expect(m1!.occurredAt).toEqual(new Date(T0));
    expect(m2).toMatchObject({ isFromMe: true, sender: undefined, text: 'I can cover half' });
    expect(m3).toMatchObject({ text: 'menu', attachments: ['file: menu.pdf'] });
    expect(m4).toMatchObject({ text: '', attachments: ['photo'] });
    expect(t1).toMatchObject({ messageGuid: 'm1', reaction: 'love', sender: BEN });
    expect(t2).toMatchObject({ messageGuid: 'm2', reaction: '🔥' });
    expect(t3).toMatchObject({ messageGuid: 'm2', reaction: 'love', removed: true, targetPartIndex: 0 });
    expect(r1).toMatchObject({ displayName: 'Tahoe 2027' });
    expect(j1).toMatchObject({ change: 'added', person: CAL, isFromMe: true });
    expect(j2).toMatchObject({ change: 'removed', person: BEN, sender: ANA });
    expect(l1).toMatchObject({ change: 'left', person: BEN, sender: BEN });
  });

  it('reads old seconds-based dates as well as nanoseconds', () => {
    const src = source();
    src.start();
    fake.message({ chat: GROUP, guid: 's1', at: T0, text: 'old mac', from: ANA, seconds: true });
    expect(src.poll()[0]!.occurredAt).toEqual(new Date(T0));
  });

  it('skips chats that are not picked, without decoding them', () => {
    const picked = new Set([GROUP]);
    const src = new ChatDbSource({ dbPath: fake.path, label, isObserved: guid => picked.has(guid), watch: false });
    src.start();
    fake.message({ chat: OTHER_GROUP, guid: 'o1', at: T0, text: 'not yours to read', from: CAL });
    fake.message({ chat: GROUP, guid: 'g1', at: T0, text: 'picked', from: ANA });
    expect(src.poll().map(event => event.chatGuid)).toEqual([GROUP]);
    picked.add(OTHER_GROUP);
    fake.message({ chat: OTHER_GROUP, guid: 'o2', at: T0 + MIN, text: 'now picked', from: CAL });
    expect(src.poll().map(event => (event as { messageGuid: string }).messageGuid)).toEqual(['o2']);
  });

  it('passes on edits and unsends of recent messages once each', () => {
    const src = source();
    src.start();
    fake.message({ chat: GROUP, guid: 'e1', at: T0, text: 'Dinner at 7', from: ANA });
    fake.message({ chat: GROUP, guid: 'e2', at: T0 + MIN, text: 'oops wrong chat', from: BEN });
    expect(src.poll()).toHaveLength(2);
    fake.edit('e1', 'Dinner at 8', T0 + 2 * MIN);
    fake.unsend('e2', T0 + 3 * MIN);
    const changes = src.poll();
    expect(changes).toEqual([
      { type: 'edited', chatGuid: GROUP, messageGuid: 'e1', text: 'Dinner at 8', occurredAt: new Date(T0 + 2 * MIN) },
      { type: 'unsent', chatGuid: GROUP, messageGuid: 'e2', occurredAt: new Date(T0 + 3 * MIN) },
    ]);
    expect(src.poll()).toEqual([]);
  });

  it('still finds a new edit when hundreds of recent messages were never edited', () => {
    const src = source();
    src.start();
    for (let i = 0; i < 600; i += 1) fake.message({ chat: GROUP, guid: `u${i}`, at: T0 + i, text: `message ${i}`, from: ANA });
    let read = 0;
    for (let batch = src.poll(); batch.length > 0; batch = src.poll()) read += batch.length;
    expect(read).toBe(600);
    fake.edit('u10', 'message 10, edited', T0 + 10 * MIN);
    expect(src.poll()).toEqual([
      { type: 'edited', chatGuid: GROUP, messageGuid: 'u10', text: 'message 10, edited', occurredAt: new Date(T0 + 10 * MIN) },
    ]);
  });

  it('reads on at once after a full page of unpicked messages, without waiting for the timer', async () => {
    const src = new ChatDbSource({ dbPath: fake.path, label, isObserved: guid => guid === GROUP, watch: false, pollMs: 60_000 });
    src.start();
    for (let i = 0; i < 500; i += 1) fake.message({ chat: OTHER_GROUP, guid: `o${i}`, at: T0 + i, text: 'not picked', from: CAL });
    fake.message({ chat: GROUP, guid: 'g-after', at: T0 + MIN, text: 'picked', from: ANA });
    const started = Date.now();
    for await (const event of src.events()) {
      expect((event as { messageGuid: string }).messageGuid).toBe('g-after');
      break;
    }
    await src.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps its place when a read fails partway, so no message is lost', () => {
    let failOnce = true;
    const src = new ChatDbSource({
      dbPath: fake.path, label, watch: false,
      isObserved: guid => {
        if (guid === DIRECT && failOnce) { failOnce = false; throw new Error('database is locked'); }
        return guid === GROUP || guid === DIRECT;
      },
    });
    src.start();
    fake.message({ chat: GROUP, guid: 'p1', at: T0, text: 'first', from: ANA });
    fake.message({ chat: DIRECT, guid: 'p2', at: T0 + MIN, text: 'second', from: CAL });
    expect(() => src.poll()).toThrow('database is locked');
    expect(src.poll().map(event => (event as { messageGuid: string }).messageGuid)).toEqual(['p1', 'p2']);
    expect(src.poll()).toEqual([]);
  });

  it('waits before reading again after a read error, even right after a full page', async () => {
    const warnings: string[] = [];
    const src = new ChatDbSource({ dbPath: fake.path, label, isObserved: guid => guid === GROUP, watch: false, pollMs: 100, log: { info: () => {}, warn: message => warnings.push(message) } });
    src.start();
    for (let i = 0; i < 500; i += 1) fake.message({ chat: OTHER_GROUP, guid: `o${i}`, at: T0 + i, text: 'not picked', from: CAL });
    const realPoll = src.poll.bind(src);
    let calls = 0;
    src.poll = () => {
      calls += 1;
      if (calls === 1) return realPoll();
      throw new Error('database is locked');
    };
    const reading = (async () => { for await (const _ of src.events()) { /* nothing is picked */ } })();
    await new Promise(resolve => setTimeout(resolve, 350));
    await src.stop();
    await reading;
    expect(calls).toBeLessThan(10);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('lists chats newest first, names unnamed chats from members, never shows a whole phone number', () => {
    fake.message({ chat: DIRECT, guid: 'd1', at: T0 + 5 * MIN, text: 'hey', from: CAL });
    fake.message({ chat: GROUP, guid: 'g1', at: T0, text: 'hi', from: ANA });
    const chats = source().listChats();
    expect(chats.map(chat => chat.guid)).toEqual([DIRECT, GROUP, OTHER_GROUP]);
    const [direct, group, unnamed] = chats;
    expect(direct).toMatchObject({ name: 'Phone ending 0003', isGroup: false, named: false, messageCount: 1 });
    expect(group).toMatchObject({ name: 'Tahoe trip', isGroup: true, named: true, members: ['Ana', BEN] });
    expect(unnamed!.name).toBe(`Ana, ${BEN}, Phone ending 0003 and 2 more`);
    expect(unnamed!.lastMessageAt).toBeNull();
    // The chat id is Apple's own and stays on this Mac; the names people see never hold the number.
    expect(JSON.stringify(chats.map(({ guid: _guid, ...rest }) => rest))).not.toContain('5551230003');
  });

  it('looks up a chat for the observer', async () => {
    const src = source();
    src.start();
    expect(await src.chat(GROUP)).toEqual({ guid: GROUP, displayName: 'Tahoe trip', isGroup: true, participants: [{ address: ANA }, { address: BEN }] });
    expect(await src.chat(DIRECT)).toMatchObject({ displayName: 'Phone ending 0003', isGroup: false });
    expect(await src.chat('iMessage;+;nope')).toBeNull();
  });

  it('listens: a new row wakes the reader without waiting for the backstop timer', async () => {
    const src = new ChatDbSource({ dbPath: fake.path, label, isObserved: () => true, pollMs: 30_000, settleMs: 20 });
    const iterator = src.events()[Symbol.asyncIterator]();
    const next = iterator.next();
    await Bun.sleep(100);
    const started = Date.now();
    fake.message({ chat: GROUP, guid: 'live-1', at: Date.now(), text: 'are we still on for tonight?', from: ANA });
    const result = await Promise.race([next, Bun.sleep(5_000).then(() => null)]);
    expect(result).not.toBeNull();
    expect((result!.value as { text: string }).text).toBe('are we still on for tonight?');
    expect(Date.now() - started).toBeLessThan(5_000);
    await src.stop();
  });
});

describe('MacSelection', () => {
  it('reads the app\'s choices and picks up changes to the file', async () => {
    const path = join(dir, 'mac.json');
    const selection = new MacSelection(path);
    expect(selection.isObserved(GROUP)).toBe(false);
    writeSelection(path, { version: 1, defaultFocus: 'plans', chats: { [GROUP]: { observe: true, focus: 'who pays for what' }, [DIRECT]: { observe: true } } });
    expect(selection.isObserved(GROUP)).toBe(true);
    expect(selection.selectionId(GROUP, T0)).toBe('');
    expect(selection.focusFor(GROUP)).toBe('who pays for what');
    expect(selection.focusFor(DIRECT)).toBe('plans');
    expect(selection.observedChats().sort()).toEqual([DIRECT, GROUP].sort());
    await Bun.sleep(5);
    writeSelection(path, { version: 1, chats: { [GROUP]: { observe: false } } });
    expect(selection.isObserved(GROUP)).toBe(false);
    writeFileSync(path, '{ broken');
    expect(selection.isObserved(GROUP)).toBe(false);
  });

  it('saves one at a time under a lock, and clears a lock left by a crash', async () => {
    const path = join(dir, 'mac.json');
    writeFileSync(`${path}.lock`, '');
    let saved = false;
    const waiting = withSelectionLock(path, () => { saved = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(saved).toBe(false);
    rmSync(`${path}.lock`);
    await waiting;
    expect(saved).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);

    writeFileSync(`${path}.lock`, '');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${path}.lock`, old, old);
    expect(await withSelectionLock(path, () => 'done')).toBe('done');
  });

  it('cleans what it is given', () => {
    expect(parseSelection({ chats: { a: { observe: 'yes' }, b: { observe: true, focus: 'x'.repeat(900) }, '': { observe: true } } })).toEqual({
      version: 1,
      chats: { a: { observe: false }, b: { observe: true, focus: 'x'.repeat(500) } },
    });
    expect(parseSelection(null)).toEqual({ version: 1, chats: {} });
  });
});

describe('Mac observer end to end', () => {
  function selectedChat() {
    const path = join(dir, 'mac.json');
    const selection = new MacSelection(path);
    function pick(guid: string, observe: boolean, now = T0) {
      const file = new MacSelection(path).file;
      const previous = file.chats[guid] ?? { observe: false };
      file.chats[guid] = updateChatChoice(previous, observe, previous.focus, now);
      writeSelection(path, file);
    }
    pick(GROUP, true);
    const isObserved = (guid: string) => selection.isObserved(guid);
    const selectionId = (guid: string, at?: number) => selection.selectionId(guid, at);
    const src = new ChatDbSource({ dbPath: fake.path, label, isObserved, selectionId, watch: false });
    src.start();
    return { src, pick, selectionId, isObserved };
  }

  it('forgets the prior quiet window, its unsends, edits and already-read rows after reselect', async () => {
    const { src, pick, selectionId, isObserved } = selectedChat();
    const oldId = selectionId(GROUP);
    fake.message({ chat: GROUP, guid: 'old', at: T0 + 1, text: 'old private text', from: ANA });
    fake.message({ chat: GROUP, guid: 'old-edit', at: T0 + 2, text: 'old draft', from: ANA });
    fake.message({ chat: GROUP, guid: 'prefetched', at: T0 + 3, text: 'old prefetched body', from: ANA });
    const [old, oldEdit, prefetched] = src.poll();
    const feed = async function* () {
      yield old!;
      yield oldEdit!;
      pick(GROUP, false, T0 + 4);
      fake.unsend('old', T0 + 5);
      fake.edit('old-edit', 'edited outside consent', T0 + 6);
      fake.message({ chat: GROUP, guid: 'while-off', at: T0 + 7, text: 'message outside consent', from: ANA });
      // Neither the source nor the observer sees the intermediate off state.
      pick(GROUP, true, T0 + 8);
      expect(selectionId(GROUP)).not.toBe(oldId);
      yield prefetched!;
      fake.message({ chat: GROUP, guid: 'fresh', at: T0 + 9, text: 'newly selected text', from: ANA });
      yield* src.poll();
    };
    const posts: string[] = [];
    const observer = new GroupChatObserver({
      source: { name: 'mac', events: feed, chat: guid => src.chat(guid), stop: () => src.stop() },
      post: async (route, body) => { posts.push(JSON.stringify([route, body])); return {}; },
      statePath: join(dir, 'chats.json'), log: silent, clock: 'event', isObserved, selectionId,
    });
    await observer.run();
    const sent = posts.join('\n');
    expect(sent).toContain('newly selected text');
    expect(sent).not.toMatch(/old private|old draft|old prefetched|outside consent/);
  });

  it.each(['/api/sessions/init', '/api/sessions/observations'])('keeps the old pick revoked when reselected during %s with a frozen clock', async routeToPause => {
    const { src, pick, isObserved, selectionId } = selectedChat();
    const oldId = selectionId(GROUP);
    fake.message({ chat: GROUP, guid: 'old', at: T0 + 1, text: 'revoked window', from: ANA });
    const events = src.poll();
    const routes: string[] = [];
    const observer = new GroupChatObserver({
      source: { name: 'mac', async *events() { yield* events; }, chat: guid => src.chat(guid), stop: () => src.stop() },
      post: async route => {
        routes.push(route);
        if (route === routeToPause) {
          pick(GROUP, false);
          pick(GROUP, true);
          expect(selectionId(GROUP)).not.toBe(oldId);
        }
        return {};
      },
      statePath: join(dir, 'chats.json'), log: silent, clock: 'event', isObserved, selectionId,
    });
    await observer.run();
    const expected = ['/api/sessions/init'];
    if (routeToPause.endsWith('observations')) expected.push(routeToPause);
    expected.push('/api/sessions/session-end');
    expect(routes).toEqual(expected);
  });

  it('discards queued windows across a same-millisecond off/on while a different worker session is waiting', async () => {
    const { src, pick, isObserved, selectionId } = selectedChat();
    pick(DIRECT, true);
    fake.message({ chat: DIRECT, guid: 'blocking', at: T0 + 1, text: 'other chat', from: CAL });
    fake.message({ chat: GROUP, guid: 'waiting', at: T0 + 2, text: 'old queued content', from: ANA });
    const rows = src.poll();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const workerStarted = new Promise<void>(resolve => { started = resolve; });
    const feed = async function* () {
      yield* rows;
      await workerStarted;
      pick(GROUP, false);
      pick(GROUP, true);
      fake.message({ chat: GROUP, guid: 'fresh', at: T0 + 3, text: 'new queued content', from: ANA });
      yield* src.poll();
      release();
    };
    const posts: string[] = [];
    const observer = new GroupChatObserver({
      source: { name: 'mac', events: feed, chat: guid => src.chat(guid), stop: () => src.stop() },
      post: async (route, body) => {
        if (posts.length === 0) { started(); await pending; }
        posts.push(JSON.stringify([route, body]));
        return {};
      },
      statePath: join(dir, 'chats.json'), log: silent, clock: 'event', isObserved, selectionId, batcher: { maxEntries: 1 },
    });
    await observer.run();
    expect(posts.join('\n')).toContain('other chat');
    expect(posts.join('\n')).toContain('new queued content');
    expect(posts.join('\n')).not.toContain('old queued content');
  });

  it('sends picked chats to Claude-Mem with the owner\'s focus, and stops sending a chat once it is unpicked', async () => {
    const picked = new Map<string, string | undefined>([[GROUP, 'the cabin and who pays'], [DIRECT, undefined]]);
    const src = new ChatDbSource({ dbPath: fake.path, label, isObserved: guid => picked.has(guid), watch: false });
    src.start();
    fake.message({ chat: GROUP, guid: 'g1', at: T0, text: 'Cabin is $1,200', from: ANA });
    fake.message({ chat: GROUP, guid: 'g2', at: T0 + MIN, text: 'I will pay the deposit Friday', fromMe: true });
    fake.message({ chat: DIRECT, guid: 'd1', at: T0 + 2 * MIN, text: 'Can you send me the address?', from: CAL });
    fake.message({ chat: OTHER_GROUP, guid: 'o1', at: T0 + 2 * MIN, text: 'never sent', from: CAL });
    const events = src.poll();
    fake.message({ chat: DIRECT, guid: 'd2', at: T0 + 3 * MIN, text: 'after unpick', from: CAL });
    const later = src.poll();

    const posts: Array<{ route: string; body: Record<string, unknown> }> = [];
    let replay: ObserverEvent[] = [...events];
    const feed = {
      name: 'test',
      async *events() {
        for (const event of replay) yield event;
        // The person unpicks the direct chat while its window is still open.
        picked.delete(DIRECT);
        for (const event of later) yield event;
      },
      chat: (guid: string) => src.chat(guid),
      stop: async () => {},
    };
    const observer = new GroupChatObserver({
      source: feed,
      post: async (route, body) => { posts.push({ route, body: body as Record<string, unknown> }); return { status: 'ok' }; },
      log: silent,
      statePath: join(dir, 'chats.json'),
      contacts: { [ANA]: 'Ana' },
      meLabel: 'Me',
      via: 'mac',
      isObserved: guid => picked.has(guid),
      focusFor: guid => picked.get(guid),
      clock: 'event',
    });
    await observer.run();
    replay = [];

    const inits = posts.filter(post => post.route === '/api/sessions/init');
    expect(inits).toHaveLength(1);
    expect(inits[0]!.body.project).toMatch(/^imessage-tahoe-trip-[0-9a-f]{8}$/);
    const prompt = String(inits[0]!.body.prompt);
    expect(prompt).toContain('from the Messages app on their own Mac');
    expect(prompt).toContain('The owner asked to watch this chat for: the cabin and who pays.');
    expect(prompt).not.toContain('note-taking line');
    const windows = posts.filter(post => post.route === '/api/sessions/observations');
    expect(windows).toHaveLength(1);
    expect(String(windows[0]!.body.tool_response)).toContain('Me: I will pay the deposit Friday');
    expect(JSON.stringify(posts)).not.toContain('never sent');
    expect(JSON.stringify(posts)).not.toContain('after unpick');
    expect(JSON.stringify(posts)).not.toContain('send me the address');
    expect(observer.droppedWindows).toBe(1);
    // Nothing sent to Claude-Mem carries a chat id with a phone number in it.
    expect(JSON.stringify(posts)).not.toContain('5551230003');
  });

  it('drops a waiting window when its chat is unticked before the worker takes it', async () => {
    const picked = new Set([GROUP, DIRECT]);
    const src = new ChatDbSource({ dbPath: fake.path, label, isObserved: guid => picked.has(guid), watch: false });
    src.start();
    fake.message({ chat: GROUP, guid: 'g1', at: T0, text: 'Cabin is $1,200', from: ANA });
    fake.message({ chat: DIRECT, guid: 'd1', at: T0 + MIN, text: 'waiting while unticked', from: CAL });
    const events = src.poll();
    const posts: Array<{ route: string; body: Record<string, unknown> }> = [];
    let first = true;
    const observer = new GroupChatObserver({
      source: { name: 'test', async *events() { yield* events; }, chat: (guid: string) => src.chat(guid), stop: async () => {} },
      post: async (route, body) => {
        if (first) {
          // While the first hand-over is with the worker, the person unticks the other chat.
          first = false;
          const sending = JSON.stringify(body).includes('tahoe') ? GROUP : DIRECT;
          picked.delete(sending === GROUP ? DIRECT : GROUP);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        posts.push({ route, body: body as Record<string, unknown> });
        return { status: 'ok' };
      },
      log: silent,
      statePath: join(dir, 'chats.json'),
      contacts: { [ANA]: 'Ana' },
      meLabel: 'Me',
      via: 'mac',
      isObserved: guid => picked.has(guid),
      clock: 'event',
    });
    await observer.run();
    const sent = JSON.stringify(posts);
    expect(sent.includes('Cabin is $1,200') !== sent.includes('waiting while unticked')).toBe(true);
    expect(observer.droppedWindows).toBe(1);
  });

  for (const revokeAt of ['/api/sessions/init', '/api/sessions/observations']) {
    it(`checks the pick again after ${revokeAt}, including before a recap`, async () => {
      let selected = true;
      const src = new ChatDbSource({ dbPath: fake.path, label, isObserved: () => selected, watch: false });
      src.start();
      fake.message({ chat: GROUP, guid: 'picked', at: T0, text: 'Fixture group decision', from: ANA });
      const feed = src.poll();
      const routes: string[] = [];
      const observer = new GroupChatObserver({
        source: { name: 'test', async *events() { yield* feed; }, chat: guid => src.chat(guid), stop: async () => {} },
        post: async route => {
          routes.push(route);
          if (route === revokeAt) selected = false;
          return { status: 'ok' };
        },
        log: silent, statePath: join(dir, 'chats.json'), via: 'mac', clock: 'event',
        isObserved: () => selected,
      });
      await observer.run();
      const expected = ['/api/sessions/init'];
      if (revokeAt === '/api/sessions/observations') expected.push(revokeAt);
      expected.push('/api/sessions/session-end');
      expect(routes).toEqual(expected);
    });
  }

  it('keeps the Photon line prompt unchanged and names a direct chat as a conversation', () => {
    const chat = { guid: GROUP, displayName: 'Tahoe trip', isGroup: true, participants: [{ address: ANA }] };
    const photon = conversationPrompt(chat, { names: { '5551230001': 'Ana' }, meLabel: 'This line' });
    expect(photon).toBe('Observe the iMessage group chat "Tahoe trip". Members: Ana.'
      + ' The account owner added their Claude-Mem note-taking line to this group as a visible member,'
      + ' so the group\'s plans are kept in the owner\'s own memory.'
      + ' This is a group conversation between people, not a coding session.'
      + ' Record what the group decided, planned, asked for, promised, scheduled and shared,'
      + ' saying who said what and when. Skip small talk that changes nothing.');
    const direct = conversationPrompt({ ...chat, isGroup: false, displayName: 'Cal' }, book, { via: 'mac', focus: '<private>x</private> dates' });
    expect(direct).toStartWith('Observe the iMessage conversation "Cal".');
    expect(direct).toContain('Record what they decided');
    expect(direct).toContain('watch this chat for: dates');
  });
});

describe('checkChatDbAccess', () => {
  it('says when the database is missing or not a database', () => {
    expect(checkChatDbAccess(join(dir, 'nope', 'chat.db'))).toMatchObject({ ok: false });
    const bad = join(dir, 'bad.db');
    writeFileSync(bad, 'not sqlite');
    expect(checkChatDbAccess(bad)).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(checkChatDbAccess(fake.path)).toEqual({ ok: true, path: fake.path });
  });
});
