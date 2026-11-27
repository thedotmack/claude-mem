import { describe, expect, it } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import { PhotonSource, fromPhotonMessageEvent, fromPhotonGroupEvent, type PhotonModule } from '../../src/integrations/imessage-observer/photon-source';

type MessageEvent = Parameters<typeof fromPhotonMessageEvent>[0];
type GroupEvent = Parameters<typeof fromPhotonGroupEvent>[0];

function liveStream<T>() {
  let receive: ((result: IteratorResult<T>) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  let closed = false;
  return {
    [Symbol.asyncIterator]() { return this; },
    next(): Promise<IteratorResult<T>> {
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve, reject) => { receive = resolve; fail = reject; });
    },
    push(value: T) { receive?.({ done: false, value }); receive = undefined; },
    reject(error: unknown) { fail?.(error); fail = undefined; },
    async close() { closed = true; receive?.({ done: true, value: undefined }); },
    async return(): Promise<IteratorResult<T>> {
      await this.close();
      return { done: true, value: undefined };
    },
  };
}

function source() {
  const messages = liveStream<MessageEvent>();
  const groups = liveStream<GroupEvent>();
  const sdk = { createGrpcClient: () => ({
    messages: { subscribeEvents: () => messages },
    groups: { subscribeEvents: () => groups },
    chats: { get: async () => ({ guid: 'chat', displayName: 'Group', isGroup: true, participants: [] }) },
    close: async () => {},
  }) } satisfies PhotonModule;
  const photon = new PhotonSource({
    sdk, lines: [{ address: 'fixture.invalid', token: 'fixture-token' }], installDir: '',
    log: { info: () => {}, warn: () => {} },
  });
  return { photon, messages, groups, iterator: photon.events()[Symbol.asyncIterator]() };
}

const base = { chatGuid: 'chat', isFromMe: false, occurredAt: new Date('2026-11-27T10:00:00Z') };
const message = (guid: string): MessageEvent => ({ ...base, type: 'message.received', message: { guid, content: { text: guid } } });
const rename: GroupEvent = { ...base, type: 'group.updated', change: { type: 'displayNameChanged', displayName: 'New group' } };

describe('Photon subscription arrival order', () => {
  it('delivers an already-arrived group change before a later message after a slow consumer resumes', async () => {
    const { photon, messages, groups, iterator } = source();
    try {
      const first = iterator.next();
      await setImmediate();
      messages.push(message('first'));
      expect((await first).value?.type).toBe('message');

      // Both reads finish while the caller processes the first message.
      groups.push(rename);
      await setImmediate();
      messages.push(message('second'));
      await setImmediate();

      expect((await iterator.next()).value?.type).toBe('renamed');
      const next = (await iterator.next()).value;
      expect(next?.type).toBe('message');
      expect(next && 'messageGuid' in next ? next.messageGuid : undefined).toBe('second');
    } finally {
      await photon.stop();
      await iterator.return?.();
    }
  });

  it('preserves the opposite order when the next message arrives first', async () => {
    const { photon, messages, groups, iterator } = source();
    try {
      const first = iterator.next();
      await setImmediate();
      messages.push(message('first'));
      await first;

      messages.push(message('second'));
      await setImmediate();
      groups.push(rename);
      await setImmediate();

      expect((await iterator.next()).value?.type).toBe('message');
      expect((await iterator.next()).value?.type).toBe('renamed');
    } finally {
      await photon.stop();
      await iterator.return?.();
    }
  });

  it('handles a queued subscription failure before messages that arrived after it', async () => {
    const { photon, messages, groups, iterator } = source();
    const error = Object.assign(new Error('permission denied'), { grpcCode: 7 });
    try {
      const first = iterator.next();
      await setImmediate();
      messages.push(message('first'));
      await first;

      groups.reject(error);
      await setImmediate();
      messages.push(message('second'));
      await setImmediate();

      const failure = await iterator.next().then(() => undefined, cause => cause);
      expect(failure).toBe(error);
    } finally {
      await photon.stop();
      await iterator.return?.();
    }
  });
});
