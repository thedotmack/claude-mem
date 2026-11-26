/**
 * A recorded or made-up group chat, one JSON object per line. Used by tests
 * and by `claude-mem imessage observe --replay <file>` to try the observer
 * without a Photon line. Times come from the file, so a day of chat replays
 * in a second.
 *
 *   {"type":"chat","guid":"any;+;crew","displayName":"Weekend Crew","participants":["+15551230001"]}
 *   {"type":"message","chat":"any;+;crew","id":"m1","from":"+15551230001","at":"2026-11-21T18:02:00-08:00","text":"Dinner Sat?"}
 *   {"type":"reaction","chat":"any;+;crew","id":"m1","from":"+15551230002","at":"...","reaction":"like"}
 *   {"type":"edited"|"unsent","chat":"...","id":"m1","at":"...","text":"..."}
 *   {"type":"renamed","chat":"...","at":"...","from":"...","name":"New name"}
 *   {"type":"membership","chat":"...","at":"...","from":"...","change":"added","person":"+1555..."}
 *
 * `"from":"me"` marks a message sent from the observer's own line (a read-only line never sends one).
 */
import { readFileSync } from 'node:fs';
import type { ChatInfo, MessageSource, ObserverEvent } from './types.js';

interface Line {
  type?: string;
  [key: string]: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function when(value: unknown, lineNumber: number): Date {
  const at = new Date(text(value));
  if (Number.isNaN(at.getTime())) throw new Error(`Line ${lineNumber}: "at" must be an ISO date.`);
  return at;
}

export function parseReplay(contents: string): { chats: Map<string, ChatInfo>; events: ObserverEvent[] } {
  const chats = new Map<string, ChatInfo>();
  const events: ObserverEvent[] = [];
  contents.split('\n').forEach((raw, index) => {
    const lineNumber = index + 1;
    if (!raw.trim() || raw.trim().startsWith('//')) return;
    const line = JSON.parse(raw) as Line;
    const chatGuid = text(line.chat);
    const from = text(line.from);
    const sender = from && from !== 'me' ? from : undefined;
    const isFromMe = from === 'me';
    switch (line.type) {
      case 'chat': {
        const guid = text(line.guid);
        chats.set(guid, {
          guid,
          displayName: text(line.displayName) || 'Group chat',
          isGroup: line.isGroup !== false,
          participants: (Array.isArray(line.participants) ? line.participants : [])
            .filter((address): address is string => typeof address === 'string')
            .map(address => ({ address })),
        });
        return;
      }
      case 'message':
        events.push({
          type: 'message', chatGuid, messageGuid: text(line.id), sender, isFromMe,
          occurredAt: when(line.at, lineNumber), text: text(line.text),
          attachments: (Array.isArray(line.attachments) ? line.attachments : [])
            .filter((label): label is string => typeof label === 'string'),
        });
        return;
      case 'edited':
        events.push({ type: 'edited', chatGuid, messageGuid: text(line.id), text: text(line.text), occurredAt: when(line.at, lineNumber) });
        return;
      case 'unsent':
        events.push({ type: 'unsent', chatGuid, messageGuid: text(line.id), occurredAt: when(line.at, lineNumber) });
        return;
      case 'reaction':
        events.push({
          type: 'reaction', chatGuid, messageGuid: text(line.id), sender, isFromMe,
          reaction: text(line.reaction) || 'like', occurredAt: when(line.at, lineNumber),
        });
        return;
      case 'renamed':
        events.push({ type: 'renamed', chatGuid, displayName: text(line.name), sender, isFromMe, occurredAt: when(line.at, lineNumber) });
        return;
      case 'membership': {
        const change = line.change === 'removed' || line.change === 'left' ? line.change : 'added';
        events.push({
          type: 'membership', chatGuid, change, person: text(line.person), sender, isFromMe,
          occurredAt: when(line.at, lineNumber),
        });
        return;
      }
      default:
        throw new Error(`Line ${lineNumber}: unknown type ${JSON.stringify(line.type)}.`);
    }
  });
  events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return { chats, events };
}

export class ReplaySource implements MessageSource {
  readonly name = 'replay';
  private stopped = false;
  private readonly chats: Map<string, ChatInfo>;
  private readonly list: ObserverEvent[];

  constructor(contents: string) {
    const parsed = parseReplay(contents);
    this.chats = parsed.chats;
    this.list = parsed.events;
  }

  static fromFile(path: string): ReplaySource {
    return new ReplaySource(readFileSync(path, 'utf8'));
  }

  async *events(): AsyncIterable<ObserverEvent> {
    for (const event of this.list) {
      if (this.stopped) return;
      yield event;
    }
  }

  async chat(guid: string): Promise<ChatInfo | null> {
    return this.chats.get(guid) ?? null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
