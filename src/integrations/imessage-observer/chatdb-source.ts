/**
 * Reads iMessage straight from the Messages database on this Mac.
 *
 * - Read-only: the source never writes to chat.db, and nothing it reads is
 *   sent to any chat. It only turns new rows into observer events.
 * - Live only: it starts at the newest message present when it starts and
 *   reads only what arrives after. Nothing is backfilled and no read position
 *   is saved, so a restart starts from "now" again
 *   (docs/architecture/observer-lifecycle.md).
 * - Listener: Messages writes new rows to chat.db-wal first, so the source
 *   watches the Messages folder for changes to chat.db and its -wal file and
 *   reads as soon as one lands, with a slow timer as a backstop for missed
 *   file events.
 * - Only chats the person picked are read (`isObserved`); other chats' rows
 *   are skipped before their text is decoded.
 */
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { textFromAttributedBody } from './attributed-body.js';
import { appleDateMs, defaultChatDbPath, openChatDb, type ReadOnlyDb } from './chatdb.js';
import type { ChatInfo, MessageSource, ObserverEvent } from './types.js';

/** The iMessage/SMS chat style Messages uses for group chats. */
const GROUP_STYLE = 43;
/** Rows read per query; a burst larger than this is read over several queries. */
const PAGE = 500;
/**
 * Edits and unsends are looked for among this many newest messages only. The
 * observer can only change a window that is still open (50 messages at most),
 * so an edit further back would be dropped anyway, and the key range keeps
 * the check off a full table scan.
 */
const EDIT_LOOKBACK_ROWS = 2_000;
/** Messages puts this character where an attachment sits in the text. */
const OBJECT_REPLACEMENT = /\uFFFC/g;

/** Tapback codes in message.associated_message_type. 3000+ removes one. */
const TAPBACKS: Record<number, string> = {
  2000: 'love',
  2001: 'like',
  2002: 'dislike',
  2003: 'laugh',
  2004: 'emphasize',
  2005: 'question',
  2006: 'emoji',
};

export interface ChatSummary {
  guid: string;
  /** The chat's own name, or one built from its members. */
  name: string;
  /** True when the chat has its own name in Messages. */
  named: boolean;
  isGroup: boolean;
  service: string;
  /** Member labels, from the contacts book (phone numbers shortened). */
  members: string[];
  messageCount: number;
  lastMessageAt: string | null;
}

export interface ChatDbSourceOptions {
  dbPath?: string;
  /** Turns an address into the label people see (see transcript.ts personLabel). */
  label: (address: string) => string;
  /** Chats to read. Asked per row, so a change in the Mac app applies at once. */
  isObserved: (chatGuid: string) => boolean;
  /** The pick active for this message's time, or undefined when the row must be skipped. */
  selectionId?: (chatGuid: string, eventTime: number) => string | undefined;
  /** Backstop timer for missed file events. */
  pollMs?: number;
  /** Wait after a file event, so one write burst is read once. */
  settleMs?: number;
  /** Turns the folder watch off (tests drive `poll()` by hand). */
  watch?: boolean;
  log?: { warn(message: string): void };
}

interface MessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  body: Uint8Array | null;
  from_me: number;
  at_ms: number;
  sender: string | null;
  assoc_guid: string | null;
  assoc_type: number | null;
  assoc_emoji: string | null;
  item_type: number | null;
  action_type: number | null;
  group_title: string | null;
  other: string | null;
  has_attachments: number | null;
  chat_guid: string;
}

interface ChangeRow extends MessageRow {
  changed_ms: number;
  retracted_ms: number;
}

export class ChatDbSource implements MessageSource {
  readonly name = 'Messages on this Mac';
  private db: ReadOnlyDb | null = null;
  private columns = new Set<string>();
  private lastRowId = 0;
  private lastChangeMs = 0;
  /** The last read filled a page, so more rows may be waiting. */
  private morePending = false;
  /** Edits already passed on at `lastChangeMs`, so equal stamps are not repeated. Bounded. */
  private seenChanges = new Set<string>();
  private stopped = false;
  private wake: (() => void) | null = null;
  private watcher: FSWatcher | null = null;
  private readonly dbPath: string;

  constructor(private readonly options: ChatDbSourceOptions) {
    this.dbPath = options.dbPath ?? defaultChatDbPath();
  }

  /** Opens the database and marks "now" as the start. Called by `events()`; tests call it directly. */
  start(): void {
    if (this.db) return;
    this.db = openChatDb(this.dbPath);
    this.columns = new Set(this.db.all<{ name: string }>('PRAGMA table_info(message)').map(row => row.name));
    this.lastRowId = this.db.get<{ id: number | null }>('SELECT MAX(ROWID) AS id FROM message')?.id ?? 0;
    if (this.has('date_edited') || this.has('date_retracted')) {
      this.lastChangeMs = this.db.get<{ ms: number | null }>(`SELECT MAX(${this.changedMsSql()}) AS ms FROM message m`)?.ms ?? 0;
    }
  }

  async *events(): AsyncIterable<ObserverEvent> {
    this.start();
    if (this.options.watch !== false) this.startWatching();
    try {
      while (!this.stopped) {
        let batch: ObserverEvent[] = [];
        try {
          batch = this.poll();
        } catch (error) {
          // Busy or mid-checkpoint: read again on the next change or tick,
          // never straight away, so a lasting error can't spin.
          this.morePending = false;
          this.options.log?.warn(`Could not read the Messages database: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const event of batch) yield event;
        if (this.stopped) break;
        // A full page of rows (counted before unpicked chats are skipped) means
        // more are waiting: read on straight away.
        if (!this.morePending) await this.nextChange();
      }
    } finally {
      this.closeWatcher();
    }
  }

  /**
   * Reads everything new since the last call. The read position moves only
   * once the whole read has worked, so a read error loses nothing: the next
   * read starts from the same place.
   */
  poll(): ObserverEvent[] {
    const db = this.db;
    if (!db) throw new Error('ChatDbSource.start() was not called');
    const events: ObserverEvent[] = [];
    const rows = db.all<MessageRow>(`${this.selectSql()} WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ${PAGE}`, this.lastRowId);
    let lastRowId = this.lastRowId;
    for (const row of rows) {
      lastRowId = Math.max(lastRowId, row.rowid);
      const selectionId = this.pickFor(row.chat_guid, row.at_ms);
      if (selectionId === undefined) continue;
      const event = this.toEvent(row);
      if (event) events.push(this.options.selectionId ? { ...event, selectionId } : event);
    }
    let commitChanges = () => {};
    if (this.has('date_edited') || this.has('date_retracted')) {
      const changes = this.changes(db, lastRowId);
      events.push(...changes.events);
      commitChanges = changes.commit;
    }
    this.lastRowId = lastRowId;
    commitChanges();
    this.morePending = rows.length === PAGE;
    return events;
  }

  /**
   * Edits and unsends of earlier messages, since the last call. Returns the
   * events and a commit that records them as seen, for poll() to run once
   * the whole read has worked.
   */
  private changes(db: ReadOnlyDb, upToRowId: number): { events: ObserverEvent[]; commit: () => void } {
    const changed = this.changedMsSql();
    const rows = db.all<ChangeRow>(
      `SELECT * FROM (${this.selectSql(`, ${changed} AS changed_ms, ${this.col('date_retracted', appleDateMs('m.date_retracted'), '0')} AS retracted_ms`)}`
      + ` WHERE m.ROWID > ? AND m.ROWID <= ?) WHERE changed_ms > 0 AND changed_ms >= ? ORDER BY changed_ms LIMIT ${PAGE}`,
      Math.max(0, upToRowId - EDIT_LOOKBACK_ROWS), upToRowId, this.lastChangeMs,
    );
    let lastChangeMs = this.lastChangeMs;
    const seen = new Set(this.seenChanges);
    const events: ObserverEvent[] = [];
    for (const row of rows) {
      const key = `${row.rowid}:${row.changed_ms}`;
      if (row.changed_ms <= 0 || seen.has(key)) continue;
      if (row.changed_ms > lastChangeMs) {
        lastChangeMs = row.changed_ms;
        seen.clear();
      }
      seen.add(key);
      if (seen.size > 1000) seen.clear();
      const selectionId = this.pickFor(row.chat_guid, row.changed_ms);
      if (selectionId === undefined) continue;
      const pick = this.options.selectionId ? { selectionId } : {};
      const occurredAt = new Date(row.changed_ms);
      if (row.retracted_ms > 0) {
        events.push({ type: 'unsent', chatGuid: row.chat_guid, messageGuid: row.guid, occurredAt, ...pick });
      } else {
        const text = this.textOf(row);
        if (text) events.push({ type: 'edited', chatGuid: row.chat_guid, messageGuid: row.guid, text, occurredAt, ...pick });
      }
    }
    return {
      events,
      commit: () => {
        this.lastChangeMs = lastChangeMs;
        this.seenChanges = seen;
      },
    };
  }

  private pickFor(guid: string, at: number): string | undefined {
    if (this.options.selectionId) return this.options.selectionId(guid, at);
    return this.options.isObserved(guid) ? '' : undefined;
  }

  async chat(guid: string): Promise<ChatInfo | null> {
    const db = this.db ?? openChatDb(this.dbPath);
    try {
      const row = db.get<{ rowid: number; guid: string; display_name: string | null; style: number | null; identifier: string | null }>(
        'SELECT ROWID AS rowid, guid, display_name, style, chat_identifier AS identifier FROM chat WHERE guid = ?', guid,
      );
      if (!row) return null;
      const participants = this.members(db, row.rowid);
      const isGroup = row.style === GROUP_STYLE || guid.includes(';+;');
      return {
        guid,
        displayName: this.nameFor(row.display_name, participants.map(p => p.address), row.identifier, isGroup),
        isGroup,
        participants,
      };
    } finally {
      if (db !== this.db) db.close();
    }
  }

  /** Every chat on this Mac, newest first, for the app's chat list. */
  listChats(): ChatSummary[] {
    const db = this.db ?? openChatDb(this.dbPath);
    try {
      const rows = db.all<{ rowid: number; guid: string; display_name: string | null; style: number | null; service: string | null; identifier: string | null; count: number; last_ms: number | null }>(
        `SELECT c.ROWID AS rowid, c.guid, c.display_name, c.style, c.service_name AS service, c.chat_identifier AS identifier,
          COUNT(cmj.message_id) AS count, MAX(${appleDateMs('m.date')}) AS last_ms
         FROM chat c
         LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         LEFT JOIN message m ON m.ROWID = cmj.message_id
         GROUP BY c.ROWID
         ORDER BY last_ms DESC`,
      );
      return rows.map(row => {
        const addresses = this.members(db, row.rowid).map(p => p.address);
        const isGroup = row.style === GROUP_STYLE || row.guid.includes(';+;');
        return {
          guid: row.guid,
          name: this.nameFor(row.display_name, addresses, row.identifier, isGroup),
          named: Boolean(row.display_name?.trim()),
          isGroup,
          service: row.service ?? 'iMessage',
          members: addresses.map(address => this.options.label(address)),
          messageCount: row.count,
          lastMessageAt: row.last_ms ? new Date(row.last_ms).toISOString() : null,
        };
      });
    } finally {
      if (db !== this.db) db.close();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    this.closeWatcher();
    this.db?.close();
    this.db = null;
  }

  private members(db: ReadOnlyDb, chatRowId: number): Array<{ address: string }> {
    return db.all<{ address: string }>(
      'SELECT h.id AS address FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ? ORDER BY h.ROWID',
      chatRowId,
    ).filter(row => row.address);
  }

  /**
   * A chat with no name of its own is named from its members, as Messages
   * shows it. A phone number is never used whole: the label shortens it.
   */
  private nameFor(displayName: string | null, addresses: string[], identifier: string | null, isGroup: boolean): string {
    const own = displayName?.trim();
    if (own) return own;
    const people = (addresses.length > 0 ? addresses : identifier ? [identifier] : []).map(address => this.options.label(address));
    if (people.length === 0) return isGroup ? 'Group chat' : 'Chat';
    if (people.length <= 3) return people.join(', ');
    return `${people.slice(0, 3).join(', ')} and ${people.length - 3} more`;
  }

  private has(column: string): boolean {
    return this.columns.has(column);
  }

  private col(column: string, sql: string, fallback = 'NULL'): string {
    return this.has(column) ? sql : fallback;
  }

  private changedMsSql(): string {
    const edited = this.col('date_edited', appleDateMs('m.date_edited'), '0');
    const retracted = this.col('date_retracted', appleDateMs('m.date_retracted'), '0');
    return `max(${edited}, ${retracted})`;
  }

  private selectSql(extra = ''): string {
    return `SELECT m.ROWID AS rowid, m.guid, m.text,
        ${this.col('attributedBody', 'm.attributedBody')} AS body,
        m.is_from_me AS from_me,
        ${appleDateMs('m.date')} AS at_ms,
        h.id AS sender,
        m.associated_message_guid AS assoc_guid,
        m.associated_message_type AS assoc_type,
        ${this.col('associated_message_emoji', 'm.associated_message_emoji')} AS assoc_emoji,
        ${this.col('item_type', 'm.item_type', '0')} AS item_type,
        ${this.col('group_action_type', 'm.group_action_type')} AS action_type,
        ${this.col('group_title', 'm.group_title')} AS group_title,
        ${this.col('other_handle', 'oh.id')} AS other,
        ${this.col('cache_has_attachments', 'm.cache_has_attachments')} AS has_attachments,
        c.guid AS chat_guid${extra}
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      ${this.has('other_handle') ? 'LEFT JOIN handle oh ON oh.ROWID = m.other_handle' : ''}`;
  }

  private textOf(row: MessageRow): string {
    const text = textFromAttributedBody(row.body) ?? row.text ?? '';
    return text.replace(OBJECT_REPLACEMENT, '').trim();
  }

  private attachmentsOf(row: MessageRow): string[] {
    if (!row.has_attachments || !this.db) return [];
    const files = this.db.all<{ name: string | null; mime: string | null }>(
      `SELECT a.transfer_name AS name, a.mime_type AS mime FROM message_attachment_join maj
       JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ?`,
      row.rowid,
    );
    return files.map(file => {
      const mime = file.mime ?? '';
      if (mime.startsWith('image/')) return 'photo';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio message';
      return file.name ? `file: ${file.name}` : 'file';
    });
  }

  private toEvent(row: MessageRow): ObserverEvent | null {
    const occurredAt = new Date(row.at_ms);
    const isFromMe = row.from_me === 1;
    const sender = isFromMe ? undefined : row.sender ?? undefined;
    const chatGuid = row.chat_guid;

    const itemType = row.item_type ?? 0;
    if (itemType === 1 && row.other) {
      // Someone was added (0) or removed (1).
      const change = row.action_type === 1 ? 'removed' : 'added';
      return { type: 'membership', chatGuid, change, person: row.other, sender, isFromMe, occurredAt };
    }
    if (itemType === 3 && (row.action_type ?? 0) === 0) {
      // The sender left the group (other group actions here are photo and background changes).
      const person = isFromMe ? 'me' : row.sender;
      return person ? { type: 'membership', chatGuid, change: 'left', person, sender, isFromMe, occurredAt } : null;
    }
    if (itemType === 2) {
      const title = row.group_title?.trim();
      return title ? { type: 'renamed', chatGuid, displayName: title, sender, isFromMe, occurredAt } : null;
    }
    if (itemType !== 0) return null;

    const assocType = row.assoc_type ?? 0;
    if (assocType !== 0) {
      const removed = assocType >= 3000 && assocType <= 3006;
      const reaction = TAPBACKS[removed ? assocType - 1000 : assocType];
      if (!reaction || !row.assoc_guid) return null;
      // "p:0/GUID" (part 0 of a message) or "bp:GUID".
      const target = row.assoc_guid.replace(/^(?:p:\d+\/|bp:)/, '');
      const part = /^p:(\d+)\//.exec(row.assoc_guid)?.[1];
      const word = reaction === 'emoji' ? (row.assoc_emoji?.trim() || 'an emoji') : reaction;
      return {
        type: 'reaction', chatGuid, messageGuid: target, sender, isFromMe, reaction: word, occurredAt,
        ...(removed ? { removed: true } : {}),
        ...(part !== undefined ? { targetPartIndex: Number(part) } : {}),
      };
    }

    const text = this.textOf(row);
    const attachments = this.attachmentsOf(row);
    if (!text && attachments.length === 0) return null;
    return { type: 'message', chatGuid, messageGuid: row.guid, sender, isFromMe, occurredAt, text, attachments };
  }

  private startWatching(): void {
    const folder = dirname(this.dbPath);
    const name = basename(this.dbPath);
    try {
      this.watcher = watch(folder, { persistent: false }, (_event, file) => {
        const changed = typeof file === 'string' ? file : String(file ?? '');
        if (!changed || changed === name || changed === `${name}-wal`) this.wake?.();
      });
      this.watcher.on('error', () => this.closeWatcher());
    } catch (error) {
      this.options.log?.warn(`Watching the Messages folder failed (${error instanceof Error ? error.message : String(error)}); checking every ${Math.round((this.options.pollMs ?? 5_000) / 1000)}s instead.`);
    }
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Resolves on the next file event (after a short settle) or the backstop tick. */
  private nextChange(): Promise<void> {
    return new Promise(resolve => {
      let settle: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        clearTimeout(tick);
        if (settle) clearTimeout(settle);
        this.wake = null;
        resolve();
      };
      const tick = setTimeout(done, this.options.pollMs ?? 5_000);
      this.wake = () => {
        if (this.stopped) return done();
        if (!settle) settle = setTimeout(done, this.options.settleMs ?? 250);
      };
    });
  }
}
