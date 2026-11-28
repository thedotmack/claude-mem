import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupChatObserver, projectNameFor } from '../../src/integrations/imessage-observer/observer';
import type { ChatInfo, MessageSource, ObserverEvent } from '../../src/integrations/imessage-observer/types';
import type { WorkerPost } from '../../src/integrations/imessage-observer/worker-sink';

const guid = 'iMessage;+;project-persistence';
const start = Date.parse('2026-11-28T10:00:00Z');
const chat: ChatInfo = { guid, displayName: 'Dinner crew', isGroup: true, participants: [] };
const message = (index: number): ObserverEvent => ({
  type: 'message', chatGuid: guid, messageGuid: `m${index}`, isFromMe: true,
  text: `Plan ${index}`, attachments: [], occurredAt: new Date(start + index * 1000),
});

it('retries a failed project-map save without changing the project after rename and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-project-state-'));
  const statePath = join(directory, 'state.json');
  mkdirSync(statePath); // A real rename failure, repaired while the observer remains running.
  const firstDelivered = Promise.withResolvers<void>();
  const projects: string[] = [];
  const warnings: string[] = [];
  const post: WorkerPost = async (route, body) => {
    if (route.endsWith('/init')) projects.push((body as { project: string }).project);
    if (route.endsWith('/observations')) firstDelivered.resolve();
    return {};
  };
  const log = { info() {}, warn: (message: string) => warnings.push(message) };
  const renamed = { ...chat, displayName: 'Weekend plans' };
  try {
    const source: MessageSource = {
      name: 'project-state-fixture',
      chat: async () => ({ ...chat }), stop() {},
      async *events() {
        yield message(1);
        await firstDelivered.promise;
        rmSync(statePath, { recursive: true });
        yield { type: 'renamed', chatGuid: guid, displayName: renamed.displayName,
          isFromMe: true, occurredAt: new Date(start + 2000) };
        yield message(3);
      },
    };
    await new GroupChatObserver({ source, post, statePath, log, clock: 'event', batcher: { maxEntries: 1 } }).run();
    expect(warnings.filter(warning => warning.startsWith('Could not save the chat list:'))).toHaveLength(1);
    await new GroupChatObserver({
      source: { name: 'restarted-fixture', chat: async () => renamed, stop() {}, async *events() { yield message(4); } },
      post, statePath, log, clock: 'event',
    }).run();
    expect(projects).toEqual([projectNameFor(chat), projectNameFor(chat)]);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).chats[guid].project).toBe(projectNameFor(chat));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
