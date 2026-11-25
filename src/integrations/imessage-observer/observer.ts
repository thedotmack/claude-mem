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
import { isProjectExcluded } from '../../utils/project-filter.js';
import { ChatWindowBatcher, DEFAULT_BATCHER_OPTIONS, type BatcherAction, type BatcherOptions } from './batcher.js';
import { conversationPrompt, normalizeNames, type ChatVia, type PeopleBook } from './transcript.js';
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
  /**
   * Asked per event and again at hand-over, so a chat switched off in the
   * Mac app sends nothing more, even from a window that was already open.
   * When set, it decides on its own: `onlyChats` and `includeDirect` are not used.
   */
  isObserved?: (chatGuid: string) => boolean;
  /** What the owner asked to watch for in a chat; read when a conversation starts. */
  focusFor?: (chatGuid: string) => string | undefined;
  /** How chats reach Claude-Mem; changes what the note-taker is told (default 'line'). */
  via?: ChatVia;
  /** Also observe one-to-one chats. */
  includeDirect?: boolean;
  batcher?: Partial<BatcherOptions>;
  /**
   * Claude-Mem's CLAUDE_MEM_EXCLUDED_PROJECTS (comma-separated globs). The
   * worker only checks it against a folder, so the observer checks each
   * chat's project name itself and sends nothing for a match.
   */
  excludedProjects?: string;
  /** Hand-overs allowed to wait for the worker at once; more are skipped. */
  maxQueued?: number;
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

/** A chat whose details could not be read is looked up again after this long. */
const LOOKUP_RETRY_MS = 5 * 60_000;
/** A window that waited this long for the worker is skipped, not sent late. */
const STALE_QUEUE_MS = 10 * 60_000;

function looksLikeGroup(guid: string): boolean {
  return guid.includes(';+;');
}

export class GroupChatObserver {
  private readonly batcher: ChatWindowBatcher;
  private readonly sink: WorkerSink;
  private readonly chats = new Map<string, Promise<ChatInfo | null>>();
  /** Chats whose details could not be read, and when to try again. Their name is a stand-in. */
  private readonly lookupFailedUntil = new Map<string, number>();
  private readonly excludedLogged = new Set<string>();
  private queued = 0;
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
      meLabel: options.meLabel ?? 'This line',
    };
    this.sink = new WorkerSink(options.post, book, options.log, chat => conversationPrompt(chat, book, {
      via: options.via,
      focus: options.focusFor?.(chat.guid),
    }));
    this.state = existsSync(options.statePath) ? readState(options.statePath) : { chats: {} };
  }

  get deliveredWindows() { return this.sink.delivered; }
  get skippedWindows() { return this.sink.skippedWindows + this.droppedWindows; }
  /** Windows skipped before reaching the worker: queue full, or waited too long. */
  droppedWindows = 0;

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
    const picked = this.options.isObserved;
    const only = this.options.onlyChats ?? [];
    if (picked ? !picked(event.chatGuid) : only.length > 0 && !only.includes(event.chatGuid)) return null;
    const retryAt = this.lookupFailedUntil.get(event.chatGuid);
    if (retryAt !== undefined && Date.now() >= retryAt) this.chats.delete(event.chatGuid);
    let pending = this.chats.get(event.chatGuid);
    if (!pending) {
      pending = this.options.source.chat(event.chatGuid).catch(() => null).then(found => {
        if (found) {
          this.lookupFailedUntil.delete(event.chatGuid);
          return found;
        }
        // Not cached for good: the lookup is tried again later. Until it works,
        // a chat with no saved project sends nothing (see enqueue).
        this.lookupFailedUntil.set(event.chatGuid, Date.now() + LOOKUP_RETRY_MS);
        return {
          guid: event.chatGuid,
          displayName: this.state.chats[event.chatGuid]?.name ?? 'Group chat',
          isGroup: looksLikeGroup(event.chatGuid),
          participants: [],
        };
      });
      this.chats.set(event.chatGuid, pending);
    }
    const chat = await pending;
    if (!chat) return null;
    // A chat picked by hand is observed whether it is a group or not.
    if (!chat.isGroup && !this.options.includeDirect && !picked) return null;
    return chat;
  }

  /**
   * The chat's project, named once from its real name. Null when the chat has
   * no saved project and its details could not be read: a stand-in name would
   * split the chat across two projects and slip past name-based exclusions.
   */
  private projectFor(chat: ChatInfo, nameKnown: boolean): string | null {
    const known = this.state.chats[chat.guid];
    if (known) return known.project;
    if (!nameKnown) return null;
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

  private excluded(project: string, chat: ChatInfo): boolean {
    const patterns = this.options.excludedProjects;
    if (!patterns || !isProjectExcluded(project, patterns)) return false;
    if (!this.excludedLogged.has(project)) {
      this.excludedLogged.add(project);
      this.options.log.info(`Chat "${chat.displayName}" is excluded by Claude-Mem (project ${project}); nothing from it is sent.`);
    }
    return true;
  }

  /**
   * Hand-overs run one at a time, in order. The wait is bounded: past
   * `maxQueued` waiting windows, or after a window has waited too long, the
   * window is skipped and logged, the same as a worker that cannot take it.
   */
  private enqueue(actions: BatcherAction[]): void {
    const limit = this.options.maxQueued ?? 20;
    for (const action of actions) {
      const current = this.known.get(action.chatGuid);
      if (!current) continue;
      const chat: ChatInfo = { ...current, participants: [...current.participants] };
      if (action.kind === 'window' && this.options.isObserved && !this.options.isObserved(action.chatGuid)) {
        this.droppedWindows += 1;
        this.options.log.info(`Dropped ${action.entries.length} messages from "${chat.displayName}": it is no longer observed.`);
        continue;
      }
      if (action.kind === 'window' && this.queued >= limit) {
        this.droppedWindows += 1;
        this.options.log.warn(`Skipped ${action.entries.length} messages from "${chat.displayName}": the worker is behind.`);
        continue;
      }
      const enqueuedAt = Date.now();
      // Decided now, so a lookup that succeeds while this waits cannot change it.
      const nameKnown = !this.lookupFailedUntil.has(action.chatGuid);
      this.queued += 1;
      this.queue = this.queue.then(async () => {
        const project = this.projectFor(chat, nameKnown);
        if (!project) {
          if (action.kind === 'window') {
            this.droppedWindows += 1;
            this.options.log.warn(`Skipped ${action.entries.length} messages: the chat's details could not be read yet, so its project is not known.`);
          }
          return;
        }
        if (this.excluded(project, chat)) return;
        if (action.kind === 'window' && !this.eventClock && Date.now() - enqueuedAt > STALE_QUEUE_MS) {
          this.droppedWindows += 1;
          this.options.log.warn(`Skipped ${action.entries.length} messages from "${chat.displayName}": they waited too long for the worker.`);
          return;
        }
        await this.sink.handle(action, chat, project, enqueuedAt);
      }).catch(error => {
        this.options.log.warn(`Hand-over failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { this.queued -= 1; });
    }
  }

  private get eventClock(): boolean {
    return this.options.clock === 'event';
  }
}
