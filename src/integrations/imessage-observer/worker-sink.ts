/**
 * Hands conversation windows to the Claude-Mem worker through the same
 * endpoints every other host uses:
 *
 *   conversation starts → POST /api/sessions/init       (the request the observer reads)
 *   each window         → POST /api/sessions/observations (one "tool" event: the transcript)
 *   conversation ends   → POST /api/sessions/summarize, then /api/sessions/session-end
 *
 * One bounded attempt per call and no retry, outbox or replay. If the worker
 * is down, that window is skipped and logged: a gap in memory, never a
 * backlog that spends later (docs/architecture/observer-lifecycle.md).
 */
import { createHash } from 'node:crypto';
import type { ChatInfo } from './types.js';
import type { BatcherAction, Conversation, WindowEntry } from './batcher.js';
import { conversationPrompt, formatStamp, formatTranscript, participantLabels, type PeopleBook } from './transcript.js';

export const PLATFORM_SOURCE = 'imessage';
export const TOOL_NAME = 'iMessageGroupChat';

/** POST a JSON body; resolves with the parsed reply or throws. */
export type WorkerPost = (route: string, body: unknown) => Promise<unknown>;

export interface SinkLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface DeliveredWindow {
  chatGuid: string;
  project: string;
  contentSessionId: string;
  entries: number;
}

export function shortHash(value: string, length = 8): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function contentSessionIdFor(chatGuid: string, conversation: Conversation): string {
  return `imessage-${shortHash(chatGuid, 12)}-${conversation.id}`;
}

interface SessionState { started: boolean; excluded: boolean }

export class WorkerSink {
  private readonly sessions = new Map<string, SessionState>();
  readonly delivered: DeliveredWindow[] = [];
  skippedWindows = 0;

  constructor(
    private readonly post: WorkerPost,
    private readonly book: PeopleBook,
    private readonly log: SinkLog,
  ) {}

  async handle(action: BatcherAction, chat: ChatInfo, project: string): Promise<void> {
    const contentSessionId = contentSessionIdFor(action.chatGuid, action.conversation);
    if (action.kind === 'window') {
      await this.sendWindow(contentSessionId, action.entries, chat, project);
    } else {
      await this.endConversation(contentSessionId);
    }
  }

  private async start(contentSessionId: string, chat: ChatInfo, project: string, at: Date): Promise<SessionState> {
    const known = this.sessions.get(contentSessionId);
    if (known?.started || known?.excluded) return known;
    const reply = await this.post('/api/sessions/init', {
      contentSessionId,
      project,
      prompt: conversationPrompt(chat, this.book),
      platformSource: PLATFORM_SOURCE,
      customTitle: `iMessage: ${chat.displayName}`,
      eventOccurredAtEpochMs: at.getTime(),
    }) as { skipped?: boolean; reason?: string } | null;
    const state: SessionState = reply?.skipped === true && reply.reason !== 'duplicate'
      ? { started: false, excluded: true }
      : { started: true, excluded: false };
    if (state.excluded) this.log.info(`Chat "${chat.displayName}" is excluded by Claude-Mem (${reply?.reason ?? 'skipped'}).`);
    this.sessions.set(contentSessionId, state);
    return state;
  }

  private async sendWindow(contentSessionId: string, entries: WindowEntry[], chat: ChatInfo, project: string): Promise<void> {
    if (entries.length === 0) return;
    const first = entries[0]!.at;
    const last = entries[entries.length - 1]!.at;
    try {
      const session = await this.start(contentSessionId, chat, project, first);
      if (session.excluded) return;
      await this.post('/api/sessions/observations', {
        contentSessionId,
        platformSource: PLATFORM_SOURCE,
        tool_name: TOOL_NAME,
        tool_input: {
          chat: chat.displayName,
          members: participantLabels(chat, this.book),
          from: formatStamp(first),
          to: formatStamp(last),
          messages: entries.filter(entry => entry.kind === 'message').length,
        },
        tool_response: formatTranscript(entries, this.book),
        tool_use_id: `imsg-${shortHash(chat.guid, 12)}-${shortHash(entries.map(entry => entry.id).join('|'), 16)}`,
        eventOccurredAtEpochMs: last.getTime(),
      });
      this.delivered.push({ chatGuid: chat.guid, project, contentSessionId, entries: entries.length });
      this.log.info(`Sent ${entries.length} messages from "${chat.displayName}" to ${project}.`);
    } catch (error) {
      // No retry: the window is dropped and the gap is logged.
      this.skippedWindows += 1;
      // A failed init is not remembered, so the next window starts the session fresh.
      this.log.warn(`Skipped ${entries.length} messages from "${chat.displayName}": ${describe(error)}`);
    }
  }

  private async endConversation(contentSessionId: string): Promise<void> {
    const session = this.sessions.get(contentSessionId);
    this.sessions.delete(contentSessionId);
    if (!session?.started) return;
    try {
      await this.post('/api/sessions/summarize', {
        contentSessionId,
        platformSource: PLATFORM_SOURCE,
        last_assistant_message: '',
      });
      await this.post('/api/sessions/session-end', {
        contentSessionId,
        platformSource: PLATFORM_SOURCE,
        reason: 'conversation_quiet',
      });
    } catch (error) {
      this.log.warn(`Could not close conversation ${contentSessionId}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
