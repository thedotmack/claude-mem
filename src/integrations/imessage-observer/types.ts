/**
 * Shared shapes for the iMessage group chat observer.
 *
 * A source (Photon, or a replayed JSONL feed) turns its own events into these
 * normalized events. Everything after the source is transport-independent, so
 * the batching, transcript and worker handoff can be tested without a Mac or
 * a Photon line.
 */

/** One person in a chat, as the source reports them. */
export interface ChatPerson {
  /** E.164 phone number or email address. */
  address: string;
}

/** What the observer knows about a chat. */
export interface ChatInfo {
  guid: string;
  displayName: string;
  isGroup: boolean;
  participants: ChatPerson[];
}

export type ObserverEvent = (
  | {
    type: 'message';
    chatGuid: string;
    messageGuid: string;
    /** Sender address; absent when the source does not say. */
    sender?: string;
    isFromMe: boolean;
    occurredAt: Date;
    text: string;
    /** Short labels such as "photo" or "file: menu.pdf". */
    attachments: string[];
  }
  | { type: 'edited'; chatGuid: string; messageGuid: string; text: string; occurredAt: Date }
  | { type: 'unsent'; chatGuid: string; messageGuid: string; occurredAt: Date }
  | {
    type: 'reaction';
    chatGuid: string;
    messageGuid: string;
    sender?: string;
    isFromMe: boolean;
    reaction: string;
    /** Removes this person's matching tapback from the open window only. */
    removed?: boolean;
    /** A reaction on one part must not remove the same reaction on another. */
    targetPartIndex?: number;
    occurredAt: Date;
  }
  | { type: 'renamed'; chatGuid: string; displayName: string; sender?: string; isFromMe: boolean; occurredAt: Date }
  | {
    type: 'membership';
    chatGuid: string;
    change: 'added' | 'removed' | 'left';
    person: string;
    sender?: string;
    isFromMe: boolean;
    occurredAt: Date;
  }
) & {
  /** The Mac selection under which this row was read. */
  selectionId?: string;
};

/** Where events come from. `chat()` fills in names and members on first sight. */
export interface MessageSource {
  readonly name: string;
  /** Yields events until the source ends or `stop()` is called. */
  events(): AsyncIterable<ObserverEvent>;
  chat(guid: string): Promise<ChatInfo | null>;
  stop(): Promise<void>;
}
