// SPDX-License-Identifier: Apache-2.0
//
// The conversation ledger (plan Phase 10 task 5, D7.1–D7.2): one append-only
// file per conversation, `ledger/<sha256(agent‖session‖subagent)>.jsonl`,
// holding every rewrite the gateway made to it, first write wins per entry
// id. A later request reads the ledger and re-applies the same rewrites
// byte for byte, so the vendor's cache prefix stays stable across requests
// and across gateway restarts.
//
// A conversation may be rewritten only when it was born under the gateway:
// the first request the gateway saw of it held exactly one user turn and no
// assistant turn. Anything else is history the gateway never saw, and
// unknown ≠ empty (magpie LESSONS.md), so it is never rewritten. A ledger
// that cannot be read, or holds a line that does not parse, makes its
// conversation `unknown`: no rewrites, and nothing more is written to it.

import { createHash } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, wireGatewaySubdirPath } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import type { WireIdentity } from '../identity/resolve-identity.js';
import type { WireRequest } from '../ir/types.js';

export const CONVERSATION_LEDGER_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEDGER_FILE_SUFFIX = '.jsonl';
/** Conversations whose ledger is held in memory; the oldest-opened is let go past this (it is read again when next seen). */
const CACHED_CONVERSATIONS_MAX = 4096;
/** A ledger in use has its file's time touched at most this often, so retention never takes a live conversation. */
const LEDGER_TOUCH_INTERVAL_MS = DAY_MS;

export type WireLedgerEntry =
  /** The conversation was born under the gateway. Always the first line. */
  | { type: 'born'; at: string }
  /** The memory injected on the first request, or null when the fetch failed (never injected later). */
  | { type: 'injection'; text: string | null }
  /** The hidden tool's definition as appended to `tools`, or null when it was not added. */
  | { type: 'tool'; name: string; definitionJson: string | null }
  /** A tool result replaced by an observation's text (Endless Mode). */
  | { type: 'swap'; callId: string; replacementText: string; firstRequestAt: string }
  /** Thinking blocks are dropped after this message index (Endless Mode, Anthropic). */
  | { type: 'thinkingDrop'; boundaryMessageIndex: number };

export type WireLedgerEntryType = WireLedgerEntry['type'];

/** What an entry is first-write-wins by: one of each kind per conversation, a swap per call, a thinking drop per boundary. */
export function ledgerEntryIdOf(entry: WireLedgerEntry): string {
  switch (entry.type) {
    case 'born':
    case 'injection':
    case 'tool':
      return entry.type;
    case 'swap':
      return `swap:${entry.callId}`;
    case 'thinkingDrop':
      return `thinkingDrop:${entry.boundaryMessageIndex}`;
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** The entry a ledger line holds, or null when the line is not one (a corrupt ledger). */
function ledgerEntryFromLine(line: string): WireLedgerEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  switch (record.type) {
    case 'born':
      return isString(record.at) ? { type: 'born', at: record.at } : null;
    case 'injection':
      return isString(record.text) || record.text === null ? { type: 'injection', text: record.text as string | null } : null;
    case 'tool':
      return isString(record.name) && (isString(record.definitionJson) || record.definitionJson === null)
        ? { type: 'tool', name: record.name, definitionJson: record.definitionJson as string | null }
        : null;
    case 'swap':
      return isString(record.callId) && isString(record.replacementText) && isString(record.firstRequestAt)
        ? { type: 'swap', callId: record.callId, replacementText: record.replacementText, firstRequestAt: record.firstRequestAt }
        : null;
    case 'thinkingDrop':
      return Number.isInteger(record.boundaryMessageIndex) && (record.boundaryMessageIndex as number) >= 0
        ? { type: 'thinkingDrop', boundaryMessageIndex: record.boundaryMessageIndex as number }
        : null;
    default:
      return null;
  }
}

/**
 * born: rewrites allowed. not_born: the gateway first saw it mid-way, so
 * never. unknown: its ledger could not be read, so never.
 */
export type WireConversationStatus = 'born' | 'not_born' | 'unknown';

/** What a rewrite stage sees of its conversation's ledger. */
export interface WireConversationLedgerView {
  readonly conversationKey: string;
  readonly status: WireConversationStatus;
  /** The entry with this id (ledgerEntryIdOf), when there is one. */
  get(entryId: string): WireLedgerEntry | undefined;
  /** Every entry, in the order written. */
  entries(): WireLedgerEntry[];
  /**
   * Record `entry` unless its id is already there; returns the entry that
   * wins (the earlier one when there was one). Written to disk before it is
   * returned. Throws on a conversation that is not born, and when the
   * write fails (the stage then fails open).
   */
  record(entry: WireLedgerEntry): WireLedgerEntry;
}

/** A request is born-shaped when it holds exactly one user turn and no assistant turn. */
export function requestStartsConversation(request: WireRequest, userTurnOrdinal: number): boolean {
  return userTurnOrdinal === 1 && request.messages.every(message => message.role !== 'assistant');
}

/** Only the conversation's own requests have a ledger: a helper's or a compaction's body is another conversation. */
export function identityHasConversationLedger(identity: Pick<WireIdentity, 'kind'>): boolean {
  return identity.kind === 'turn' || identity.kind === 'subagent';
}

export function conversationKeyOf(identity: Pick<WireIdentity, 'agentId' | 'sessionId' | 'subagent'>): string {
  return createHash('sha256')
    .update(`${identity.agentId}\u0000${identity.sessionId}\u0000${identity.subagent ?? ''}`)
    .digest('hex');
}

interface CachedConversation {
  status: WireConversationStatus;
  entriesById: Map<string, WireLedgerEntry>;
  entriesInOrder: WireLedgerEntry[];
  /** Whether a file exists for it (a not_born conversation has none). */
  hasFile: boolean;
  lastTouchedAt: number;
}

export interface WireConversationLedgerOptions {
  /** Defaults to <DATA_DIR>/wire-gateway/ledger. */
  directory?: string;
  retentionDays?: number;
  now?: () => number;
}

export class WireConversationLedger {
  private readonly directory: string;
  private readonly retentionDays: number;
  private readonly now: () => number;
  private readonly cachedConversations = new Map<string, CachedConversation>();

  constructor(options: WireConversationLedgerOptions = {}) {
    this.directory = options.directory ?? wireGatewaySubdirPath('ledger');
    this.retentionDays = options.retentionDays ?? CONVERSATION_LEDGER_RETENTION_DAYS;
    this.now = options.now ?? Date.now;
  }

  private filePathOf(conversationKey: string): string {
    return join(this.directory, `${conversationKey}${LEDGER_FILE_SUFFIX}`);
  }

  /**
   * The ledger of the conversation `identity` names, as `request` finds it:
   * a conversation seen for the first time is born when `request` starts it
   * (and its born line is written now). Null for requests that have no
   * conversation ledger (helpers, compaction).
   */
  open(identity: Pick<WireIdentity, 'agentId' | 'sessionId' | 'subagent' | 'kind' | 'userTurnOrdinal'>, request: WireRequest): WireConversationLedgerView | null {
    if (!identityHasConversationLedger(identity)) return null;
    const conversationKey = conversationKeyOf(identity);
    let conversation = this.cachedConversations.get(conversationKey);
    if (!conversation) {
      conversation = this.readConversation(conversationKey) ?? this.firstSight(conversationKey, request, identity.userTurnOrdinal);
      this.remember(conversationKey, conversation);
    } else {
      this.touchIfDue(conversationKey, conversation);
    }
    return this.viewOf(conversationKey, conversation);
  }

  /** Delete ledgers untouched for longer than the retention. Returns how many went. */
  pruneExpired(): number {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const oldestKeptMs = this.now() - this.retentionDays * DAY_MS;
    let deleted = 0;
    for (const name of names) {
      if (!name.endsWith(LEDGER_FILE_SUFFIX)) continue;
      const filePath = join(this.directory, name);
      try {
        if (statSync(filePath).mtimeMs >= oldestKeptMs) continue;
        unlinkSync(filePath);
        this.cachedConversations.delete(name.slice(0, -LEDGER_FILE_SUFFIX.length));
        deleted++;
      } catch (error) {
        logger.warn('WIRE', 'Could not prune a conversation ledger', { name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return deleted;
  }

  /** The conversation from its file; null when it has none. A file that cannot be read or parsed is `unknown`. */
  private readConversation(conversationKey: string): CachedConversation | null {
    let text: string;
    try {
      text = readFileSync(this.filePathOf(conversationKey), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.warn('WIRE', 'A conversation ledger could not be read; the conversation is never rewritten', {
        conversationKey, error: error instanceof Error ? error.message : String(error),
      });
      return this.unknownConversation();
    }
    const conversation: CachedConversation = { status: 'born', entriesById: new Map(), entriesInOrder: [], hasFile: true, lastTouchedAt: 0 };
    const lines = text.split('\n');
    // A file always ends in a line feed; the empty string after it is not a line.
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      const entry = ledgerEntryFromLine(line);
      if (!entry) {
        logger.warn('WIRE', 'A conversation ledger has a line that does not parse; the conversation is never rewritten', { conversationKey });
        return this.unknownConversation();
      }
      const entryId = ledgerEntryIdOf(entry);
      if (conversation.entriesById.has(entryId)) continue; // first write wins
      conversation.entriesById.set(entryId, entry);
      conversation.entriesInOrder.push(entry);
    }
    if (conversation.entriesInOrder[0]?.type !== 'born') {
      logger.warn('WIRE', 'A conversation ledger does not begin with its birth; the conversation is never rewritten', { conversationKey });
      return this.unknownConversation();
    }
    this.touchIfDue(conversationKey, conversation);
    return conversation;
  }

  private unknownConversation(): CachedConversation {
    return { status: 'unknown', entriesById: new Map(), entriesInOrder: [], hasFile: true, lastTouchedAt: this.now() };
  }

  /** The first request the gateway sees of a conversation decides whether it was born here. */
  private firstSight(conversationKey: string, request: WireRequest, userTurnOrdinal: number): CachedConversation {
    if (!requestStartsConversation(request, userTurnOrdinal)) {
      return { status: 'not_born', entriesById: new Map(), entriesInOrder: [], hasFile: false, lastTouchedAt: this.now() };
    }
    const conversation: CachedConversation = { status: 'born', entriesById: new Map(), entriesInOrder: [], hasFile: false, lastTouchedAt: this.now() };
    try {
      this.append(conversationKey, conversation, { type: 'born', at: new Date(this.now()).toISOString() });
    } catch (error) {
      logger.warn('WIRE', 'Could not write a conversation ledger; the conversation is never rewritten', {
        conversationKey, error: error instanceof Error ? error.message : String(error),
      });
      return this.unknownConversation();
    }
    return conversation;
  }

  private append(conversationKey: string, conversation: CachedConversation, entry: WireLedgerEntry): void {
    mkdirSync(this.directory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    appendFileSync(this.filePathOf(conversationKey), `${JSON.stringify(entry)}\n`, { mode: WIRE_GATEWAY_FILE_MODE });
    conversation.hasFile = true;
    conversation.lastTouchedAt = this.now();
    conversation.entriesById.set(ledgerEntryIdOf(entry), entry);
    conversation.entriesInOrder.push(entry);
  }

  private touchIfDue(conversationKey: string, conversation: CachedConversation): void {
    if (!conversation.hasFile || conversation.status !== 'born' || this.now() - conversation.lastTouchedAt < LEDGER_TOUCH_INTERVAL_MS) return;
    conversation.lastTouchedAt = this.now();
    try {
      const nowDate = new Date(this.now());
      utimesSync(this.filePathOf(conversationKey), nowDate, nowDate);
    } catch (error) {
      logger.debug('WIRE', 'Could not touch a conversation ledger', { conversationKey, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private remember(conversationKey: string, conversation: CachedConversation): void {
    if (this.cachedConversations.size >= CACHED_CONVERSATIONS_MAX) {
      const oldestKey = this.cachedConversations.keys().next().value;
      if (oldestKey !== undefined) this.cachedConversations.delete(oldestKey);
    }
    this.cachedConversations.set(conversationKey, conversation);
  }

  private viewOf(conversationKey: string, conversation: CachedConversation): WireConversationLedgerView {
    return {
      conversationKey,
      status: conversation.status,
      get: entryId => conversation.entriesById.get(entryId),
      entries: () => [...conversation.entriesInOrder],
      record: entry => {
        if (conversation.status !== 'born') {
          throw new Error(`conversation ${conversationKey} is ${conversation.status}; only a conversation born under the gateway is rewritten`);
        }
        const existing = conversation.entriesById.get(ledgerEntryIdOf(entry));
        if (existing) return existing;
        this.append(conversationKey, conversation, entry);
        return entry;
      },
    };
  }
}
