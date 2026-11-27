import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDbSource } from '../../src/integrations/imessage-observer/chatdb-source';
import type { ReadOnlyDb } from '../../src/integrations/imessage-observer/chatdb';
import { FakeChatDb } from '../fixtures/imessage/fake-chat-db';

let dir: string;
let fake: FakeChatDb;
const at = Date.parse('2026-11-25T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmem-chat-list-'));
  fake = new FakeChatDb(join(dir, 'chat.db'));
});

afterEach(() => {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function source() {
  return new ChatDbSource({ dbPath: fake.path, label: address => address, isObserved: () => false, watch: false });
}

describe('Messages chat list', () => {
  it('keeps the number of database reads bounded as the chat list grows', async () => {
    for (let index = 0; index < 64; index++) {
      fake.chat(`iMessage;+;group-${index}`, { group: true, members: ['a@example.com', 'b@example.com'] });
    }
    const src = source();
    src.start();
    const db = (src as unknown as { db: ReadOnlyDb }).db;
    const original = db.all;
    let reads = 0;
    db.all = function<T>(sql: string, ...params: Array<string | number | null>): T[] {
      reads++;
      return original.call(this, sql, ...params) as T[];
    };
    try {
      const chats = src.listChats();
      expect(chats).toHaveLength(64);
      expect(chats.every(chat => chat.members.length === 2)).toBe(true);
      expect(reads).toBeLessThan(4);
    } finally {
      db.all = original;
      await src.stop();
    }
  });

  it('keeps handle order and message counts independent of the number of members', () => {
    const members = ['z@example.com', 'a@example.com', 'm@example.com', 'c@example.com'];
    for (const member of members) fake.handle(member);
    const group = 'iMessage;+;ordered';
    fake.chat(group, { group: true, members: [...members].reverse() });
    fake.message({ chat: group, guid: 'one', at, text: 'one' });
    fake.message({ chat: group, guid: 'two', at: at + 1000, text: 'two' });
    expect(source().listChats()[0]).toMatchObject({
      guid: group, members, name: 'z@example.com, a@example.com, m@example.com and 1 more',
      named: false, isGroup: true, messageCount: 2, lastMessageAt: new Date(at + 1000).toISOString(),
    });
  });

  it('keeps chats without members or messages and their identifier fallback', () => {
    const group = 'iMessage;+;empty';
    fake.chat(group, { group: true, members: [] });
    const direct = 'iMessage;-;direct';
    const id = fake.chat(direct, { group: false, members: ['fallback@example.com'] });
    fake.db.query('DELETE FROM chat_handle_join WHERE chat_id = ?').run(id);
    fake.db.query('UPDATE chat SET chat_identifier = NULL WHERE guid = ?').run(group);
    const chats = source().listChats();
    expect(chats.find(chat => chat.guid === group)).toMatchObject({ name: 'Group chat', members: [], messageCount: 0, lastMessageAt: null });
    expect(chats.find(chat => chat.guid === direct)).toMatchObject({ name: 'fallback@example.com', members: [], messageCount: 0, lastMessageAt: null });
  });

  it('keeps shared contacts in each chat without multiplying counts or sorting by name', () => {
    const older = 'iMessage;+;older';
    const newer = 'iMessage;+;newer';
    fake.chat(older, { group: true, name: 'Original name', members: ['shared@example.com', 'only-old@example.com'] });
    fake.chat(newer, { group: true, members: ['only-new@example.com', 'shared@example.com', ''] });
    fake.message({ chat: older, guid: 'older-message', at, text: 'old' });
    fake.message({ chat: newer, guid: 'newer-message', at: at + 1000, text: 'new' });
    const chats = source().listChats();
    expect(chats.map(chat => chat.guid)).toEqual([newer, older]);
    expect(chats[0]).toMatchObject({ name: 'shared@example.com, only-new@example.com', members: ['shared@example.com', 'only-new@example.com'], messageCount: 1 });
    expect(chats[1]).toMatchObject({ name: 'Original name', named: true, members: ['shared@example.com', 'only-old@example.com'], messageCount: 1 });
  });
});
