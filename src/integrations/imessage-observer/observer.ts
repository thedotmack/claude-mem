/**
 * The iMessage group chat observer: source → conversation windows → worker.
 *
 * - Each group chat gets its own Claude-Mem project, named once from the
 *   group's name plus a short id (imessage-weekend-crew-3fa94c1d), so a
 *   rename keeps the same project.
 * - Direct (one-to-one) chats are ignored unless asked for.
 * - The chat-to-project map is the only thing written to disk. It holds
 *   names, not messages.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ChatWindowBatcher, DEFAULT_BATCHER_OPTIONS, type BatcherAction, type BatcherOptions } from './batcher.js';
import { normalizeNames, type PeopleBook } from './transcript.js';
import type { ChatInfo, MessageSource, ObserverEvent } from './types.js';
import { shortHash, WorkerSink, type SinkLog, type WorkerPost } from './worker-sink.js';

export interface ObserverOptions {
  source: MessageSource;
  post: WorkerPost;
  log: SinkLog;
  /** File holding the chat → project map. */
  statePath: string;
  /** Address → name, for who said what. */
  contacts?: Record<string, string>;
  meLabel?: string;
  /** Observe only these chat GUIDs (all group chats when empty). */
  onlyChats?: string[];
  /** Also observe one-to-one chats. */
  includeDirect?: boolean;
  batcher?: Partial<BatcherOptions>;
  /**
   * "wall" ticks on a timer (live use). "event" moves the clock with event
   * times (replays and tests), so a recorded day runs in a moment.
   */
  clock?: 'wall' | 'event';
  tickMs?: number;
}

interface ChatEntry { project: string; name: string }
interface StateFile { chats: Record<string, ChatEntry> }

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function projectNameFor(chat: ChatInfo): string {
  const slug = slugify(chat.displayName) || (chat.isGroup ? 'group' : 'direct');
  return `imessage-${slug}-${shortHash(chat.guid)}`;
}

function readState(path: string): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StateFile;
    return parsed && typeof parsed.chats === 'object' && parsed.chats ? parsed : { chats: {} };
  } catch {
    return { chats: {} };
  }
}

function writeState(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

function looksLikeGroup(guid: string): boolean {
  return guid.includes(';+;');
}

export class GroupChatObserver {
  private readonly batcher: ChatWindowBatcher;
  private readonly sink: WorkerSink;
  private readonly chats = new Map<string, Promise<ChatInfo | null>>();
  /** Chats already looked up, so a hand-over can copy the chat as it is right now. */
  private readonly known = new Map<string, ChatInfo>();
  private readonly state: StateFile;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  ignoredEvents = 0;

  constructor(private readonly options: ObserverOptions) {
    this.batcher = new ChatWindowBatcher({ ...DEFAULT_BATCHER_OPTIONS, ...options.batcher });
    const book: PeopleBook = {
      names: normalizeNames(options.contacts ?? {}),
      meLabel: options.meLabel ?? 'Me',
    };
    this.sink = new WorkerSink(options.post, book, options.log);
    this.state = existsSync(options.statePath) ? readState(options.statePath) : { chats: {} };
  }

  get deliveredWindows() { return this.sink.delivered; }
  get skippedWindows() { return this.sink.skippedWindows; }

  /** Run until the source ends or `stop()` is called. */
  async run(): Promise<void> {
    const eventClock = this.options.clock === 'event';
    if (!eventClock) {
      this.timer = setInterval(() => this.enqueue(this.batcher.tick(Date.now())), this.options.tickMs ?? 15_000);
    }
    try {
      for await (const event of this.options.source.events()) {
        if (this.stopped) break;
        const chat = await this.chatFor(event);
        if (!chat) {
          this.ignoredEvents += 1;
          continue;
        }
        this.known.set(chat.guid, chat);
        const now = eventClock ? event.occurredAt.getTime() : Date.now();
        if (eventClock) this.enqueue(this.batcher.tick(now));
        this.enqueue(this.batcher.add(event, now));
        // Windows handed over above keep the chat as it was; later ones see the change.
        this.applyChange(chat, event);
      }
    } finally {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      // Hand over what is open now. This is live content, not a replay.
      this.enqueue(this.batcher.drain());
      await this.queue;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.options.source.stop();
  }

  private applyChange(chat: ChatInfo, event: ObserverEvent): void {
    if (event.type === 'renamed' && event.displayName.trim()) chat.displayName = event.displayName.trim();
    if (event.type !== 'membership') return;
    const others = chat.participants.filter(person => person.address !== event.person);
    chat.participants = event.change === 'added' ? [...others, { address: event.person }] : others;
  }

  private async chatFor(event: ObserverEvent): Promise<ChatInfo | null> {
    const only = this.options.onlyChats ?? [];
    if (only.length > 0 && !only.includes(event.chatGuid)) return null;
    let pending = this.chats.get(event.chatGuid);
    if (!pending) {
      pending = this.options.source.chat(event.chatGuid).then(found => found ?? {
        guid: event.chatGuid,
        displayName: this.state.chats[event.chatGuid]?.name ?? 'Group chat',
        isGroup: looksLikeGroup(event.chatGuid),
        participants: [],
      });
      this.chats.set(event.chatGuid, pending);
    }
    const chat = await pending;
    if (!chat) return null;
    if (!chat.isGroup && !this.options.includeDirect) return null;
    return chat;
  }

  private projectFor(chat: ChatInfo): string {
    const known = this.state.chats[chat.guid];
    if (known) return known.project;
    const project = projectNameFor(chat);
    this.state.chats[chat.guid] = { project, name: chat.displayName };
    try {
      writeState(this.options.statePath, this.state);
    } catch (error) {
      this.options.log.warn(`Could not save the chat list: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.options.log.info(`Observing "${chat.displayName}" as Claude-Mem project ${project}.`);
    return project;
  }

  /** Hand-overs run one at a time, in order. */
  private enqueue(actions: BatcherAction[]): void {
    for (const action of actions) {
      const current = this.known.get(action.chatGuid);
      if (!current) continue;
      const chat: ChatInfo = { ...current, participants: [...current.participants] };
      this.queue = this.queue.then(async () => {
        await this.sink.handle(action, chat, this.projectFor(chat));
      }).catch(error => {
        this.options.log.warn(`Hand-over failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
