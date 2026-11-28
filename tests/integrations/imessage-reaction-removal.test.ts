import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatWindowBatcher } from '../../src/integrations/imessage-observer/batcher';
import { ChatDbSource } from '../../src/integrations/imessage-observer/chatdb-source';
import { GroupChatObserver } from '../../src/integrations/imessage-observer/observer';
import { fromPhotonMessageEvent } from '../../src/integrations/imessage-observer/photon-source';
import { parseReplay } from '../../src/integrations/imessage-observer/replay-source';
import type { ObserverEvent } from '../../src/integrations/imessage-observer/types';
import { FakeChatDb } from '../fixtures/imessage/fake-chat-db';

const CHAT = 'iMessage;+;reaction-removal';
const ANA = 'ana@example.com';
const BEN = 'ben@example.com';
const AT = Date.parse('2026-11-28T10:00:00Z');
const reaction = (sender: string | undefined, extra = {}): ObserverEvent => ({
  type: 'reaction', chatGuid: CHAT, messageGuid: 'message', sender, isFromMe: false,
  reaction: 'like', occurredAt: new Date(AT + 1), ...extra,
});
const message: ObserverEvent = {
  type: 'message', chatGuid: CHAT, messageGuid: 'message', sender: ANA, isFromMe: false,
  occurredAt: new Date(AT), text: 'Meet at seven?', attachments: [],
};

describe('pending iMessage reaction removal', () => {
  it('normalizes Photon removals with the same part as additions', () => {
    for (const type of ['message.reactionAdded', 'message.reactionRemoved']) {
      expect(fromPhotonMessageEvent({
        type, chatGuid: CHAT, messageGuid: 'message', actor: { address: BEN },
        isFromMe: false, occurredAt: new Date(AT), reaction: { kind: 'emoji', emoji: '🔥' },
        targetPartIndex: 2,
      })).toMatchObject({
        type: 'reaction', reaction: '🔥', sender: BEN, targetPartIndex: 2,
        ...(type.endsWith('Removed') ? { removed: true } : {}),
      });
    }
  });

  it('removes only the matching person, reaction and message part from an open window', () => {
    const batcher = new ChatWindowBatcher();
    batcher.add(message);
    batcher.add(reaction(ANA));
    batcher.add(reaction(BEN));
    batcher.add(reaction(BEN, { targetPartIndex: 1 }));
    batcher.add(reaction(BEN, { reaction: 'love' }));
    batcher.add(reaction(undefined));
    batcher.add(reaction(undefined, { removed: true }));
    batcher.add(reaction(BEN, { removed: true }));
    const window = batcher.drain().find(action => action.kind === 'window');
    expect(window?.kind).toBe('window');
    if (window?.kind !== 'window') throw new Error('Expected pending window');
    expect(window.entries.filter(entry => entry.kind === 'reaction').map(entry => [
      entry.speaker, entry.verb, entry.targetPartIndex ?? 0,
    ])).toEqual([
      [ANA, 'liked', 0], [BEN, 'liked', 1], [BEN, 'loved', 0], [undefined, 'liked', 0],
    ]);
  });

  it('handles the owner and never reopens an already delivered window', () => {
    const batcher = new ChatWindowBatcher();
    batcher.add(message);
    batcher.add(reaction(undefined, { isFromMe: true }));
    batcher.add(reaction(undefined, { isFromMe: true, removed: true }));
    const window = batcher.drain().find(action => action.kind === 'window');
    expect(window?.kind === 'window' && window.entries.map(entry => entry.kind)).toEqual(['message']);
    expect(batcher.add(reaction(BEN, { removed: true }))).toEqual([]);
    expect(batcher.pendingEntries()).toBe(0);
    expect(batcher.drain()).toEqual([]);
  });

  it('carries explicit removals through replay fixtures', () => {
    const parsed = parseReplay(JSON.stringify({
      type: 'reaction', chat: CHAT, id: 'message', from: BEN, at: new Date(AT).toISOString(),
      reaction: 'like', removed: true, targetPartIndex: 1,
    }));
    expect(parsed.events[0]).toMatchObject({ removed: true, targetPartIndex: 1 });
  });

  it('reads the target part and emoji for added and removed chat.db tapbacks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-reaction-part-'));
    const db = new FakeChatDb(join(dir, 'chat.db'));
    db.chat(CHAT, { group: true, members: [ANA, BEN] });
    const source = new ChatDbSource({ dbPath: db.path, label: value => value, isObserved: () => true, watch: false });
    try {
      source.start();
      for (const type of [2006, 3006]) {
        db.message({ chat: CHAT, guid: `emoji-${type}`, at: AT + type, from: BEN,
          tapback: { on: 'message', type, emoji: '🔥' } });
      }
      db.db.query('UPDATE message SET associated_message_guid = ?').run('p:2/message');
      expect(source.poll()).toMatchObject([
        { type: 'reaction', messageGuid: 'message', sender: BEN, reaction: '🔥', targetPartIndex: 2 },
        { type: 'reaction', messageGuid: 'message', sender: BEN, reaction: '🔥', targetPartIndex: 2, removed: true },
      ]);
    } finally {
      await source.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps withdrawn chat.db tapbacks out of the worker transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-reaction-removal-'));
    const db = new FakeChatDb(join(dir, 'chat.db'));
    db.chat(CHAT, { name: 'Dinner', group: true, members: [ANA, BEN] });
    const source = new ChatDbSource({ dbPath: db.path, label: value => value, isObserved: () => true, watch: false });
    const delivered: string[] = [];
    try {
      source.start();
      db.message({ chat: CHAT, guid: 'message', at: AT, text: message.text, from: ANA });
      db.message({ chat: CHAT, guid: 'ana-like', at: AT + 1, from: ANA, tapback: { on: 'message', type: 2001 } });
      db.message({ chat: CHAT, guid: 'ben-like', at: AT + 2, from: BEN, tapback: { on: 'message', type: 2001 } });
      db.message({ chat: CHAT, guid: 'ben-remove', at: AT + 3, from: BEN, tapback: { on: 'message', type: 3001 } });
      const events = source.poll();
      await new GroupChatObserver({
        source: {
          name: 'chatdb-fixture',
          async *events() { yield* events; },
          chat: guid => source.chat(guid),
          stop: () => source.stop(),
        },
        statePath: join(dir, 'state.json'), clock: 'event',
        contacts: { [ANA]: 'Ana', [BEN]: 'Ben' },
        log: { info() {}, warn() {} },
        post: async (endpoint, body) => {
          if (endpoint.endsWith('/observations')) delivered.push(String(body.tool_response));
          return {};
        },
      }).run();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain('(Ana liked "Meet at seven?")');
      expect(delivered[0]).not.toContain('Ben liked');
      expect(events.at(-1)).toMatchObject({ type: 'reaction', sender: BEN, reaction: 'like', removed: true });
    } finally {
      await source.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
