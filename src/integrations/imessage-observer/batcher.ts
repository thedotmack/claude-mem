/**
 * Turns a live stream of chat events into conversation windows.
 *
 * A group chat is not a tool call: one message alone rarely carries a
 * decision. The batcher collects a chat's messages while people are talking
 * and hands over one window when the chat goes quiet, gets long, or gets old.
 * Windows that belong together share a conversation; a long silence starts a
 * new one.
 *
 * Everything here is in memory and bounded. Nothing is written to disk and
 * nothing is replayed: a window that cannot be delivered is gone (see
 * docs/architecture/observer-lifecycle.md). The batcher is pure and takes the
 * clock as an argument, so tests drive it without timers.
 */
import { cleanMessageText } from './transcript.js';
import type { ObserverEvent } from './types.js';

export interface BatcherOptions {
  /** Hand over a window after the chat is quiet this long. */
  quietMs: number;
  /** Hand over a window once it holds this many entries. */
  maxEntries: number;
  /** Hand over a window once its first entry is this old. */
  maxWindowMs: number;
  /** A silence this long ends the conversation; the next message starts a new one. */
  conversationGapMs: number;
}

export const DEFAULT_BATCHER_OPTIONS: BatcherOptions = {
  quietMs: 10 * 60_000,
  maxEntries: 50,
  maxWindowMs: 60 * 60_000,
  conversationGapMs: 4 * 60 * 60_000,
};

/** One line of a window. `speaker` is an address, `me`, or absent for system lines. */
export interface WindowEntry {
  id: string;
  at: Date;
  kind: 'message' | 'reaction' | 'system';
  speaker?: string;
  text: string;
  /** A person a system line is about (added or removed), named when written out. */
  target?: string;
  /** For a tapback: the message it is on, so an edit or unsend of that message reaches it. */
  reactsTo?: string;
  /** For a tapback: "loved", "liked" and so on. */
  verb?: string;
  attachments: string[];
}

export interface Conversation {
  id: string;
  startedAt: Date;
  /** Windows handed over so far in this conversation. */
  windowCount: number;
}

export type BatcherAction =
  | { kind: 'window'; chatGuid: string; conversation: Conversation; first: boolean; entries: WindowEntry[] }
  | { kind: 'end'; chatGuid: string; conversation: Conversation };

interface ChatState {
  conversation: Conversation | null;
  entries: WindowEntry[];
  windowStartedAt: number | null;
  lastActivityAt: number;
}

const REACTION_WORDS: Record<string, string> = {
  love: 'loved',
  like: 'liked',
  dislike: 'disliked',
  laugh: 'laughed at',
  emphasize: 'emphasized',
  question: 'questioned',
};

/**
 * A short quote of the message a tapback is on. Private sections are taken out
 * before shortening, so cutting the text can never leave a <private> block
 * open with its contents showing.
 */
function quote(text: string): string {
  const flat = cleanMessageText(text).replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 77) + '...' : flat;
}

function reactionText(verb: string, target: WindowEntry): string {
  return `${verb} "${quote(target.text || target.attachments.join(', '))}"`;
}

function speakerOf(event: { sender?: string; isFromMe: boolean }): string | undefined {
  return event.isFromMe ? 'me' : event.sender;
}

export class ChatWindowBatcher {
  private readonly chats = new Map<string, ChatState>();
  private conversationSeq = 0;

  constructor(private readonly options: BatcherOptions = DEFAULT_BATCHER_OPTIONS) {}

  /** Add one event. Returns what must be handed over now, in order. */
  add(event: ObserverEvent, now: number = event.occurredAt.getTime()): BatcherAction[] {
    const actions: BatcherAction[] = [];
    let state = this.chats.get(event.chatGuid);

    // A long silence closes the old conversation before this event joins a new one.
    if (state?.conversation && now - state.lastActivityAt >= this.options.conversationGapMs) {
      actions.push(...this.closeConversation(event.chatGuid, state));
    }

    const entry = this.apply(state, event);
    if (!entry) return actions;

    if (!state) {
      state = { conversation: null, entries: [], windowStartedAt: null, lastActivityAt: now };
      this.chats.set(event.chatGuid, state);
    }
    if (!state.conversation) {
      this.conversationSeq += 1;
      state.conversation = {
        id: `${event.occurredAt.getTime().toString(36)}-${this.conversationSeq.toString(36)}`,
        startedAt: event.occurredAt,
        windowCount: 0,
      };
    }
    if (state.windowStartedAt === null) state.windowStartedAt = now;
    state.entries.push(entry);
    state.lastActivityAt = now;

    if (state.entries.length >= this.options.maxEntries) {
      actions.push(this.handOver(event.chatGuid, state));
    }
    return actions;
  }

  /** Check every chat against the clock. Call this every few seconds. */
  tick(now: number): BatcherAction[] {
    const actions: BatcherAction[] = [];
    for (const [chatGuid, state] of this.chats) {
      if (state.entries.length > 0 && state.windowStartedAt !== null
        && (now - state.lastActivityAt >= this.options.quietMs
          || now - state.windowStartedAt >= this.options.maxWindowMs)) {
        actions.push(this.handOver(chatGuid, state));
      }
      if (state.conversation && state.entries.length === 0
        && now - state.lastActivityAt >= this.options.conversationGapMs) {
        actions.push(...this.closeConversation(chatGuid, state));
      }
    }
    return actions;
  }

  /** Hand over everything still open, for a clean shutdown. */
  drain(): BatcherAction[] {
    const actions: BatcherAction[] = [];
    for (const [chatGuid, state] of this.chats) actions.push(...this.closeConversation(chatGuid, state));
    return actions;
  }

  /** Entries waiting across all chats (for status output). */
  pendingEntries(): number {
    let total = 0;
    for (const state of this.chats.values()) total += state.entries.length;
    return total;
  }

  /**
   * Edits, unsends and tapbacks change the open window only. A change to a
   * message that was already handed over is dropped, never re-sent.
   */
  private apply(state: ChatState | undefined, event: ObserverEvent): WindowEntry | null {
    const open = state?.entries ?? [];
    switch (event.type) {
      case 'message':
        if (!event.text.trim() && event.attachments.length === 0) return null;
        return {
          id: event.messageGuid,
          at: event.occurredAt,
          kind: 'message',
          speaker: speakerOf(event),
          text: event.text,
          attachments: event.attachments,
        };
      case 'edited': {
        const target = open.find(entry => entry.id === event.messageGuid && entry.kind === 'message');
        if (!target) return null;
        target.text = event.text;
        // Tapbacks on the message quote it as it reads now.
        for (const entry of open) {
          if (entry.reactsTo === target.id) entry.text = reactionText(entry.verb ?? 'reacted to', target);
        }
        return null;
      }
      case 'unsent': {
        if (!state || !open.some(entry => entry.id === event.messageGuid && entry.kind === 'message')) return null;
        // The message goes, and so do the tapbacks quoting it.
        state.entries = open.filter(entry => entry.id !== event.messageGuid && entry.reactsTo !== event.messageGuid);
        if (state.entries.length === 0) state.windowStartedAt = null;
        return null;
      }
      case 'reaction': {
        const target = open.find(entry => entry.id === event.messageGuid && entry.kind === 'message');
        if (!target) return null;
        const verb = REACTION_WORDS[event.reaction] ?? `reacted ${event.reaction} to`;
        return {
          id: `${event.messageGuid}:reaction:${event.occurredAt.getTime()}`,
          at: event.occurredAt,
          kind: 'reaction',
          speaker: speakerOf(event),
          text: reactionText(verb, target),
          reactsTo: target.id,
          verb,
          attachments: [],
        };
      }
      case 'renamed':
        return {
          id: `rename:${event.occurredAt.getTime()}`,
          at: event.occurredAt,
          kind: 'system',
          speaker: speakerOf(event),
          text: `renamed the group to "${event.displayName}"`,
          attachments: [],
        };
      case 'membership':
        return {
          id: `member:${event.person}:${event.occurredAt.getTime()}`,
          at: event.occurredAt,
          kind: 'system',
          speaker: event.change === 'left' ? event.person : speakerOf(event),
          text: event.change === 'left' ? 'left the group' : event.change,
          target: event.change === 'left' ? undefined : event.person,
          attachments: [],
        };
    }
  }

  private handOver(chatGuid: string, state: ChatState): BatcherAction {
    const conversation = state.conversation!;
    const first = conversation.windowCount === 0;
    conversation.windowCount += 1;
    const entries = state.entries;
    state.entries = [];
    state.windowStartedAt = null;
    return { kind: 'window', chatGuid, conversation, first, entries };
  }

  private closeConversation(chatGuid: string, state: ChatState): BatcherAction[] {
    const actions: BatcherAction[] = [];
    if (!state.conversation) return actions;
    if (state.entries.length > 0) actions.push(this.handOver(chatGuid, state));
    // A conversation that never handed over a window has nothing to summarize.
    if (state.conversation.windowCount > 0) actions.push({ kind: 'end', chatGuid, conversation: state.conversation });
    state.conversation = null;
    return actions;
  }
}
