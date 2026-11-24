/**
 * Live iMessage events from a Photon line, over the Photon SDK's gRPC
 * transport (the one with live event streams).
 *
 * Add the Photon line to any group chat and its messages arrive here. The
 * observer only reads: it never sends, reacts or changes a group.
 *
 * The SDK is not a claude-mem dependency. `claude-mem imessage setup` installs
 * it into <data dir>/imessage-observer, and this file loads it from there.
 *
 * After a dropped stream the observer reopens the live stream and does not
 * call `events.catchUp`: messages sent while it was disconnected are a gap,
 * not a backlog to spend on later (docs/architecture/observer-lifecycle.md).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatInfo, MessageSource, ObserverEvent } from './types.js';

/** The parts of @photon-ai/advanced-imessage/grpc this file uses. */
interface PhotonAddress { address: string }
interface PhotonAttachment { fileName?: string; mimeType?: string; isSticker?: boolean; isHidden?: boolean }
interface PhotonMessage {
  guid: string;
  content: { text?: string; attachments?: readonly PhotonAttachment[] };
  isSystemMessage?: boolean;
  isServiceMessage?: boolean;
  reaction?: unknown;
}
interface PhotonEventBase { type: string; chatGuid: string; isFromMe: boolean; occurredAt: Date; actor?: PhotonAddress }
type PhotonMessageEvent = PhotonEventBase & {
  message?: PhotonMessage;
  messageGuid?: string;
  content?: { text?: string };
  reaction?: { kind: string; emoji?: string };
};
type PhotonGroupEvent = PhotonEventBase & {
  change: { type: string; displayName?: string; participant?: PhotonAddress };
};
interface PhotonStream<T> extends AsyncIterable<T> { close?(): Promise<void> }
interface PhotonClient {
  messages: { subscribeEvents(filter?: { chat?: string }): PhotonStream<PhotonMessageEvent> };
  groups: { subscribeEvents(filter?: { chat?: string }): PhotonStream<PhotonGroupEvent> };
  chats: { get(guid: string): Promise<{ guid: string; displayName: string; isGroup: boolean; participants: readonly PhotonAddress[] }> };
  close(): Promise<void>;
}
interface PhotonModule {
  createGrpcClient?(options: { address: string; token: string; tls?: boolean }): PhotonClient;
  createClient?(options: { address: string; token: string; tls?: boolean }): PhotonClient;
}

export const PHOTON_PACKAGES = [
  '@photon-ai/advanced-imessage@^2.5.0',
  'nice-grpc@^2.1.11',
  'nice-grpc-common@^2.0.2',
  '@grpc/grpc-js@^1.12.6',
];

export interface PhotonOptions {
  address: string;
  token: string;
  tls?: boolean;
  /** Where `claude-mem imessage setup` installed the SDK. */
  installDir: string;
  log: { info(message: string): void; warn(message: string): void };
}

export async function loadPhoton(installDir: string): Promise<PhotonModule> {
  const local = join(installDir, 'node_modules', '@photon-ai', 'advanced-imessage', 'dist', 'grpc.js');
  if (existsSync(local)) return await import(pathToFileURL(local).href) as PhotonModule;
  try {
    // A global or workspace install also works.
    const bare = '@photon-ai/advanced-imessage/grpc';
    return await import(bare) as PhotonModule;
  } catch {
    throw new Error('The Photon iMessage SDK is not installed. Run: npx claude-mem imessage setup');
  }
}

export function attachmentLabel(attachment: PhotonAttachment): string | null {
  if (attachment.isHidden) return null;
  const mime = attachment.mimeType ?? '';
  if (attachment.isSticker) return 'sticker';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice note';
  return attachment.fileName ? `file: ${attachment.fileName}` : 'file';
}

/** Photon message event → observer event, or null for events the observer ignores. */
export function fromPhotonMessageEvent(event: PhotonMessageEvent): ObserverEvent | null {
  const sender = event.actor?.address;
  const base = { chatGuid: event.chatGuid, occurredAt: new Date(event.occurredAt) };
  switch (event.type) {
    case 'message.received': {
      const message = event.message;
      // Tapbacks arrive as their own reaction events; system rows carry no speech.
      if (!message || message.reaction || message.isSystemMessage || message.isServiceMessage) return null;
      return {
        ...base, type: 'message', messageGuid: message.guid, sender, isFromMe: event.isFromMe,
        text: message.content.text ?? '',
        attachments: (message.content.attachments ?? [])
          .map(attachmentLabel).filter((label): label is string => label !== null),
      };
    }
    case 'message.edited':
      return event.messageGuid ? { ...base, type: 'edited', messageGuid: event.messageGuid, text: event.content?.text ?? '' } : null;
    case 'message.unsent':
      return event.messageGuid ? { ...base, type: 'unsent', messageGuid: event.messageGuid } : null;
    case 'message.reactionAdded':
      if (!event.messageGuid || !event.reaction) return null;
      return {
        ...base, type: 'reaction', messageGuid: event.messageGuid, sender, isFromMe: event.isFromMe,
        reaction: event.reaction.kind === 'emoji' ? event.reaction.emoji ?? 'emoji' : event.reaction.kind,
      };
    default:
      return null;
  }
}

export function fromPhotonGroupEvent(event: PhotonGroupEvent): ObserverEvent | null {
  const base = { chatGuid: event.chatGuid, occurredAt: new Date(event.occurredAt), sender: event.actor?.address, isFromMe: event.isFromMe };
  const change = event.change;
  if (change.type === 'displayNameChanged') return { ...base, type: 'renamed', displayName: change.displayName ?? '' };
  const person = change.participant?.address;
  if (!person) return null;
  if (change.type === 'participantAdded') return { ...base, type: 'membership', change: 'added', person };
  if (change.type === 'participantRemoved') return { ...base, type: 'membership', change: 'removed', person };
  if (change.type === 'participantLeft') return { ...base, type: 'membership', change: 'left', person };
  return null;
}

/** Merge async iterables into one, in arrival order. */
async function* merge<T>(sources: AsyncIterable<T>[]): AsyncIterable<T> {
  const iterators = sources.map(source => source[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>();
  const pull = (index: number) => pending.set(index, iterators[index]!.next().then(result => ({ index, result })));
  iterators.forEach((_, index) => pull(index));
  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(index);
      continue;
    }
    pull(index);
    yield result.value;
  }
}

export class PhotonSource implements MessageSource {
  readonly name = 'photon';
  private client: PhotonClient | null = null;
  private streams: PhotonStream<unknown>[] = [];
  private stopped = false;

  constructor(private readonly options: PhotonOptions) {}

  private async connect(): Promise<PhotonClient> {
    if (this.client) return this.client;
    const sdk = await loadPhoton(this.options.installDir);
    const create = sdk.createGrpcClient ?? sdk.createClient;
    if (!create) throw new Error('This Photon SDK version has no gRPC client. Run: npx claude-mem imessage setup');
    this.client = create({ address: this.options.address, token: this.options.token, tls: this.options.tls ?? true });
    return this.client;
  }

  async *events(): AsyncIterable<ObserverEvent> {
    let delayMs = 1_000;
    while (!this.stopped) {
      try {
        const client = await this.connect();
        const messages = client.messages.subscribeEvents();
        const groups = client.groups.subscribeEvents();
        this.streams = [messages, groups];
        this.options.log.info('Listening for iMessage group chat messages.');
        const merged = merge<{ kind: 'message'; event: PhotonMessageEvent } | { kind: 'group'; event: PhotonGroupEvent }>([
          mapIterable(messages, event => ({ kind: 'message' as const, event })),
          mapIterable(groups, event => ({ kind: 'group' as const, event })),
        ]);
        for await (const item of merged) {
          delayMs = 1_000;
          const event = item.kind === 'message' ? fromPhotonMessageEvent(item.event) : fromPhotonGroupEvent(item.event);
          if (event) yield event;
        }
      } catch (error) {
        if (this.stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        if (/unauthenticated|token|permission/i.test(message)) throw error;
        this.options.log.warn(`Photon stream dropped (${message}). Reconnecting in ${Math.round(delayMs / 1000)}s; messages sent meanwhile are not recorded.`);
      }
      if (this.stopped) return;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }

  async chat(guid: string): Promise<ChatInfo | null> {
    try {
      const client = await this.connect();
      const chat = await client.chats.get(guid);
      return {
        guid: chat.guid,
        displayName: chat.displayName || 'Group chat',
        isGroup: chat.isGroup,
        participants: chat.participants.map(person => ({ address: person.address })),
      };
    } catch (error) {
      this.options.log.warn(`Could not read chat details: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.streams.map(stream => stream.close?.()));
    await this.client?.close().catch(() => undefined);
  }
}

async function* mapIterable<T, U>(source: AsyncIterable<T>, map: (value: T) => U): AsyncIterable<U> {
  for await (const value of source) yield map(value);
}
