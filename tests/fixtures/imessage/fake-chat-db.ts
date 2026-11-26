/**
 * A fake Messages database with the tables and columns the Mac source reads,
 * laid out as macOS 14/15 writes them (dates in nanoseconds since 2001,
 * text often only in attributedBody). Used by the Mac source tests; no real
 * messages are involved.
 */
import { Database } from 'bun:sqlite';
import { attributedBodyFor } from '../../../src/integrations/imessage-observer/attributed-body';

const APPLE_EPOCH_MS = 978_307_200_000;

/** Unix ms → Messages' nanoseconds since 2001-01-01. BigInt keeps every digit. */
export function appleNs(ms: number): bigint {
  return BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;
}

const SCHEMA = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT NOT NULL DEFAULT 'iMessage');
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER,
  chat_identifier TEXT, service_name TEXT, display_name TEXT
);
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0,
  service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
  item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0,
  associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, associated_message_emoji TEXT,
  attributedBody BLOB, date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0
);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, filename TEXT, mime_type TEXT, transfer_name TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
`;

export interface FakeMessage {
  chat: string;
  guid: string;
  at: number;
  text?: string;
  /** Put the text only in attributedBody, as newer macOS does. */
  bodyOnly?: boolean;
  from?: string;
  fromMe?: boolean;
  attachment?: { name: string; mime: string };
  tapback?: { on: string; type: number; emoji?: string };
  rename?: string;
  member?: { person: string; removed?: boolean };
  /** The sender left the group. */
  left?: boolean;
  /** Store the date in seconds, as macOS before 10.13 did. */
  seconds?: boolean;
}

export class FakeChatDb {
  readonly db: Database;
  private seq = 0;

  constructor(readonly path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  handle(address: string): number {
    const found = this.db.query('SELECT ROWID AS id FROM handle WHERE id = ?').get(address) as { id: number } | null;
    if (found) return found.id;
    return Number(this.db.query('INSERT INTO handle (id) VALUES (?)').run(address).lastInsertRowid);
  }

  chat(guid: string, options: { name?: string; group: boolean; members: string[] }): number {
    const identifier = options.group ? guid.split(';').pop()! : options.members[0]!;
    const id = Number(this.db.query('INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)')
      .run(guid, options.group ? 43 : 45, identifier, 'iMessage', options.name ?? '').lastInsertRowid);
    for (const member of options.members) {
      this.db.query('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(id, this.handle(member));
    }
    return id;
  }

  message(input: FakeMessage): number {
    const chatId = (this.db.query('SELECT ROWID AS id FROM chat WHERE guid = ?').get(input.chat) as { id: number }).id;
    const date = input.seconds ? BigInt(Math.floor((input.at - APPLE_EPOCH_MS) / 1000)) : appleNs(input.at);
    const text = input.text ?? null;
    const body = text !== null ? attributedBodyFor(text) : null;
    const itemType = input.rename !== undefined ? 2 : input.member ? 1 : input.left ? 3 : 0;
    const id = Number(this.db.query(
      `INSERT INTO message (guid, text, handle_id, service, date, is_from_me, cache_has_attachments, item_type, other_handle,
        group_title, group_action_type, associated_message_guid, associated_message_type, associated_message_emoji, attributedBody)
       VALUES (?, ?, ?, 'iMessage', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.guid,
      input.bodyOnly ? null : text !== null && input.attachment ? `￼${text}` : text,
      input.from ? this.handle(input.from) : 0,
      date,
      input.fromMe ? 1 : 0,
      input.attachment ? 1 : 0,
      itemType,
      input.member ? this.handle(input.member.person) : 0,
      input.rename ?? null,
      input.member?.removed ? 1 : 0,
      input.tapback ? `p:0/${input.tapback.on}` : null,
      input.tapback?.type ?? 0,
      input.tapback?.emoji ?? null,
      body,
    ).lastInsertRowid);
    this.db.query('INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)').run(chatId, id, date);
    if (input.attachment) {
      this.seq += 1;
      const attachment = Number(this.db.query('INSERT INTO attachment (guid, filename, mime_type, transfer_name) VALUES (?, ?, ?, ?)')
        .run(`att-${this.seq}`, `~/Library/Messages/Attachments/${input.attachment.name}`, input.attachment.mime, input.attachment.name).lastInsertRowid);
      this.db.query('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(id, attachment);
    }
    return id;
  }

  edit(guid: string, text: string, at: number): void {
    this.db.query('UPDATE message SET text = NULL, attributedBody = ?, date_edited = ? WHERE guid = ?').run(attributedBodyFor(text), appleNs(at), guid);
  }

  unsend(guid: string, at: number): void {
    this.db.query('UPDATE message SET text = NULL, attributedBody = NULL, date_edited = ?, date_retracted = ? WHERE guid = ?').run(appleNs(at), appleNs(at), guid);
  }

  close(): void {
    this.db.close();
  }
}
