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
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { PhotonCloudError } from './photon-cloud.js';
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
  messages: { subscribeEvents(filter?: { chat?: string; onHeartbeat?: () => void }): PhotonStream<PhotonMessageEvent> };
  groups: { subscribeEvents(filter?: { chat?: string; onHeartbeat?: () => void }): PhotonStream<PhotonGroupEvent> };
  chats: { get(guid: string): Promise<{ guid: string; displayName: string; isGroup: boolean; participants: readonly PhotonAddress[] }> };
  close(): Promise<void>;
}
type PhotonToken = string | (() => Promise<string>);
export interface PhotonModule {
  createGrpcClient?(options: { address: string; token: PhotonToken; tls?: boolean }): PhotonClient;
  createClient?(options: { address: string; token: PhotonToken; tls?: boolean }): PhotonClient;
}

/** A line to listen on: a server address and its token (a string, or a function for renewed tokens). */
export interface PhotonLineConfig {
  address: string;
  token: PhotonToken;
  /** How to name the line in logs, e.g. its phone number. */
  label?: string;
}

export const PHOTON_PACKAGES = [
  '@photon-ai/advanced-imessage@^2.5.0',
  'nice-grpc@^2.1.11',
  'nice-grpc-common@^2.0.2',
  '@grpc/grpc-js@^1.12.6',
];

export interface PhotonOptions {
  /** The lines to listen on, or a function that finds them (re-run after a dropped stream). */
  lines: PhotonLineConfig[] | (() => Promise<PhotonLineConfig[]>);
  tls?: boolean;
  /** Where `claude-mem imessage setup` installed the SDK. */
  installDir: string;
  /** A signed app supplies its bundled SDK instead of loading user-installed code. */
  sdk?: PhotonModule;
  onListening?(): void;
  onReconnecting?(): void;
  onAuthRejected?(): void;
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

/**
 * Merge the paired live subscriptions in arrival order. When one ends, fails or
 * the reader stops, every other source is closed too, so a reconnect never
 * leaves old streams open.
 */
async function* merge<T>(sources: AsyncIterable<T>[]): AsyncIterable<T> {
  const iterators = sources.map(source => source[Symbol.asyncIterator]());
  type Delivery = { index: number; result: IteratorResult<T> } | { index: number; error: unknown };
  const pending = new Map<number, Promise<void>>();
  // One outstanding read per source bounds this queue. Record settlement
  // order while the consumer is paused: racing already-settled promises
  // again would favor the first subscription, even when another arrived first.
  const ready: Delivery[] = [];
  const pull = (index: number) => {
    const next = iterators[index]!.next().then(
      result => { ready.push({ index, result }); },
      error => { ready.push({ index, error }); },
    );
    pending.set(index, next);
  };
  iterators.forEach((_, index) => pull(index));
  try {
    while (pending.size > 0) {
      if (ready.length === 0) await Promise.race(pending.values());
      const delivery = ready.shift()!;
      if ('error' in delivery) throw delivery.error;
      const { index, result } = delivery;
      // Each subscription is long lived. A clean EOF on either side makes
      // the pair incomplete even when its sibling has nothing new to emit.
      if (result.done) return;
      pull(index);
      yield result.value;
    }
  } finally {
    // Not awaited: a source with a read in flight finishes its return() only
    // when that read ends, which for a quiet stream is when the caller closes
    // the stream underneath (PhotonSource.closeLines). Waiting here would block that.
    for (const index of pending.keys()) {
      Promise.resolve(iterators[index]!.return?.()).catch(() => {});
    }
  }
}

/**
 * Errors that reconnecting cannot fix: Photon refused the project, or the
 * project has no line that can see group chats. A rejected token is fatal
 * only for a fixed token; a renewed one gets a fresh token on reconnect.
 */
function authRejected(error: unknown): boolean {
  // The SDK wraps nice-grpc's numeric code as grpcCode and uses the
  // provider's free-form details as its message. Older transports expose code.
  if (error && typeof error === 'object') {
    const { grpcCode, code } = error as { grpcCode?: unknown; code?: unknown };
    if (grpcCode === 7 || grpcCode === 16 || code === 7 || code === 16) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /unauthenticated|permission[ _]denied|invalid token/i.test(message);
}

function isFatal(error: unknown, renewableTokens: boolean): boolean {
  if (error instanceof PhotonCloudError) return error.fatal;
  return !renewableTokens && authRejected(error);
}

interface OpenLine { label: string; client: PhotonClient }

export class PhotonSource implements MessageSource {
  readonly name = 'photon';
  private lines: OpenLine[] = [];
  /** Which line each chat was heard on, so its details are read from that line. */
  private readonly chatLine = new Map<string, PhotonClient>();
  private streams: PhotonStream<unknown>[] = [];
  private stopped = false;
  private readonly stopping = new AbortController();

  constructor(private readonly options: PhotonOptions) {}

  private renewableTokens(): boolean {
    const lines = this.options.lines;
    return typeof lines === 'function' || lines.some(line => typeof line.token === 'function');
  }

  private async connect(): Promise<OpenLine[]> {
    if (this.lines.length > 0) return this.lines;
    const sdk = this.options.sdk ?? await loadPhoton(this.options.installDir);
    const create = sdk.createGrpcClient ?? sdk.createClient;
    if (!create) throw new Error('This Photon SDK version has no gRPC client. Run: npx claude-mem imessage setup');
    const configs = typeof this.options.lines === 'function' ? await this.options.lines() : this.options.lines;
    if (this.stopped) return [];
    if (configs.length === 0) throw new PhotonCloudError('No Photon iMessage line is set up. Run: npx claude-mem imessage setup', undefined, true);
    this.lines = configs.map(line => ({
      label: line.label ?? line.address,
      client: create({ address: line.address, token: line.token, tls: this.options.tls ?? true }),
    }));
    return this.lines;
  }

  private async closeLines(): Promise<void> {
    const streams = this.streams.splice(0);
    const lines = this.lines.splice(0);
    this.chatLine.clear();
    await Promise.allSettled(streams.map(stream => stream.close?.()));
    await Promise.allSettled(lines.map(line => line.client.close()));
  }

  async *events(): AsyncIterable<ObserverEvent> {
    let delayMs = 1_000;
    while (!this.stopped) {
      try {
        const lines = await this.connect();
        if (this.stopped) return;
        const feeds: AsyncIterable<{ client: PhotonClient; event: ObserverEvent | null }>[] = [];
        const expected = 2 * lines.length;
        let connected = 0;
        const confirmation = () => {
          let first = true;
          return () => {
            if (!first || this.stopped) return;
            first = false;
            if (++connected === expected) {
              this.options.onListening?.();
              this.options.log.info(`Listening for iMessage group chat messages on ${lines.map(line => line.label).join(', ')}.`);
            }
          };
        };
        for (const line of lines) {
          const messageConnected = confirmation();
          const groupConnected = confirmation();
          const messages = line.client.messages.subscribeEvents({ onHeartbeat: messageConnected });
          const groups = line.client.groups.subscribeEvents({ onHeartbeat: groupConnected });
          this.streams.push(messages, groups);
          feeds.push(mapIterable(messages, event => {
            messageConnected();
            return { client: line.client, event: fromPhotonMessageEvent(event) };
          }));
          feeds.push(mapIterable(groups, event => {
            groupConnected();
            return { client: line.client, event: fromPhotonGroupEvent(event) };
          }));
        }
        for await (const item of merge(feeds)) {
          delayMs = 1_000;
          if (!item.event) continue;
          this.chatLine.set(item.event.chatGuid, item.client);
          yield item.event;
        }
        if (!this.stopped) this.options.log.warn('A Photon group or message subscription ended. Reconnecting to both live streams.');
      } catch (error) {
        if (this.stopped) return;
        if (isFatal(error, this.renewableTokens())) throw error;
        if (authRejected(error)) this.options.onAuthRejected?.();
        const message = error instanceof Error ? error.message : String(error);
        this.options.log.warn(`Photon stream dropped (${message}). Reconnecting in ${Math.round(delayMs / 1000)}s; messages sent meanwhile are not recorded.`);
      } finally {
        // This also releases the quiet sibling after a fatal credential error.
        await this.closeLines();
      }
      if (this.stopped) return;
      this.options.onReconnecting?.();
      try {
        await delay(delayMs, undefined, { signal: this.stopping.signal });
      } catch (error) {
        if (this.stopped) return;
        throw error;
      }
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }

  async chat(guid: string): Promise<ChatInfo | null> {
    try {
      const client = this.chatLine.get(guid) ?? (await this.connect())[0]!.client;
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
    this.stopping.abort();
    await this.closeLines();
  }
}

async function* mapIterable<T, U>(source: AsyncIterable<T>, map: (value: T) => U): AsyncIterable<U> {
  for await (const value of source) yield map(value);
}

