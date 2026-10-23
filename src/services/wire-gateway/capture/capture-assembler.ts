// SPDX-License-Identifier: Apache-2.0
//
// The assembler (plan Phase 5 task 4, design Part 7): turns relayed
// exchanges into claude-mem's neutral events — `session_init`, `observation`,
// `summarize`, `session_end` — with no duplicates and no blocking. It is fed
// live by the capture observer; Phase 13 feeds it from other sources.
//
// An agent resends its whole history on every request, so what is new is
// found by prefix: magpie's reader dedupe (internal/sessions/gateway.go:
// 429-443, MIT, Copyright (c) 2026 yetone) — when this request's items start
// with the previous request's items, only the rest is new. When they do not
// (compaction, an edit), only items with ids not emitted yet go out, and the
// worker's own uniqueness (tool_uses, native prompt ids, spool keys) is the
// backstop. A session first seen mid-conversation is not replayed: everything
// before its latest user turn counts as already seen (magpie's "no replay
// before start", internal/sessions/traces.go:56-58).
//
// Tool calls are paired with their results from the request history (every
// protocol resends the call beside its result), else from calls the previous
// reply made. Gemini calls without an id get positional ids on both sides
// (`gemini:<content>:<part>` in requests, `gemini:reply:<n>` in replies) that
// never match and repeat across turns, so neither is ever a tool_use_id:
// such a call's id is derived from its name, arguments and result.

import { createHash } from 'crypto';
import type { WireMessage, WirePart, WireReply, WireRequest } from '../ir/types.js';
import type { WireIdentity } from '../identity/resolve-identity.js';
import { userWordsInMessage } from '../identity/user-words.js';
import { startsUserTurn } from '../identity/turn-start.js';
import type { WireSessionStale, WireTurnEnd } from '../identity/turn-tracker.js';
import { logger } from '../../../utils/logger.js';
import { MEDIA_PROMPT_PLACEHOLDER } from '../../sqlite/prompt-storage.js';
import type { WireCaptureEventSink } from './capture-event-sink.js';

/** Conversations kept in memory; the least recently used is forgotten first. */
export const MAX_TRACKED_CONVERSATIONS = 2_000;
/** Tool use ids remembered per conversation for dedupe. */
const MAX_EMITTED_TOOL_USE_IDS_PER_CONVERSATION = 20_000;
/** Calls a reply made that wait for their result. */
const MAX_PENDING_CALLS_PER_CONVERSATION = 512;

/** The observation a compaction's summary becomes (design Part 5: these summaries are worth keeping). */
export const CONTEXT_COMPACTION_TOOL_NAME = 'context_compaction';

/** How the session_init native prompt id is checked (SessionRoutes sessionInitByClaudeIdSchema). */
const NATIVE_PROMPT_ID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,256}$/;
const GEMINI_REQUEST_POSITIONAL_CALL_ID_PATTERN = /^gemini:\d+:\d+$/;
const GEMINI_REPLY_POSITIONAL_CALL_ID_PREFIX = 'gemini:reply:';

/** One exchange as the assembler needs it, from any source. */
export interface WireAssemblerExchange {
  identity: WireIdentity;
  request: WireRequest;
  /** The reply as collected; null when none came back. */
  reply: WireReply | null;
  /** The reply went whole to the agent and carried no error. */
  replyIsWhole: boolean;
}

interface PendingCall {
  name: string;
  argsText: string;
  at: number;
}

interface ConversationState {
  /** One key per item of the previous request, in order; null before the first. */
  previousItemKeys: string[] | null;
  emittedToolUseIds: Set<string>;
  pendingCalls: Map<string, PendingCall>;
  lastAssistantText: string;
  /** The user turn the latest session_init was for (or adopted after a compaction). */
  lastInitializedUserTurnOrdinal: number;
  lastInitializedUserWords: string;
  /** The agent's own id for that turn's prompt, when it sent one. */
  lastInitializedNativePromptId?: string;
}

interface SessionWithEvents {
  agentId: string;
  sessionId: string;
  workDir?: string;
}

interface RequestItem {
  messageIndex: number;
  message: WireMessage;
  part: WirePart;
  key: string;
}

function sha256Hex(...fields: string[]): string {
  const hash = createHash('sha256');
  fields.forEach((field, index) => {
    if (index > 0) hash.update('\u0000');
    hash.update(field);
  });
  return hash.digest('hex');
}

/**
 * The tool_use_id a tool result is observed under: its call id, or, for a
 * Gemini call with only a positional id (or none), one derived from its
 * name, arguments and result, counted by `derivedIdOccurrences` (shared
 * across one request's results, in order) so the same call made twice keeps
 * two ids. `resultText` is the result's text with "\n[image]" when it
 * carried images. Endless Mode looks observations up by the same id.
 */
export function toolUseIdOfResult(
  result: { callId: string | undefined; toolName: string; argsText: string; resultText: string },
  derivedIdOccurrences: Map<string, number>,
): string {
  if (result.callId && !GEMINI_REQUEST_POSITIONAL_CALL_ID_PATTERN.test(result.callId)) return result.callId;
  const derived = sha256Hex(result.toolName, result.argsText, result.resultText);
  const occurrence = derivedIdOccurrences.get(derived) ?? 0;
  derivedIdOccurrences.set(derived, occurrence + 1);
  return `gemini-${sha256Hex(derived, String(occurrence)).slice(0, 32)}`;
}

/** The session the events of `identity` are captured under: a Codex subagent's are filed under the thread it was made from. */
export function contentSessionIdOf(identity: Pick<WireIdentity, 'kind' | 'sessionId' | 'parentSessionId'>): string {
  return identity.kind === 'subagent' && identity.parentSessionId ? identity.parentSessionId : identity.sessionId;
}

function itemKeyOf(message: WireMessage, part: WirePart): string {
  return createHash('sha1')
    .update(message.role).update('\u0000')
    .update(part.kind).update('\u0000')
    .update(part.callId ?? '').update('\u0000')
    .update(part.name ?? '').update('\u0000')
    .update(part.text ?? '').update('\u0000')
    .update(part.argsJson ?? '')
    .digest('base64');
}

function requestItemsOf(request: WireRequest): RequestItem[] {
  const items: RequestItem[] = [];
  request.messages.forEach((message, messageIndex) => {
    for (const part of message.parts) items.push({ messageIndex, message, part, key: itemKeyOf(message, part) });
  });
  return items;
}

/** Where the latest user turn starts (the turn-start rule of identity/turn-start.ts); -1 when none does. */
function latestUserTurnMessageIndex(request: WireRequest): number {
  let latest = -1;
  request.messages.forEach((message, messageIndex) => {
    if (startsUserTurn(message)) latest = messageIndex;
  });
  return latest;
}

/**
 * The prompt of the latest user turn: its own words, or the worker's media
 * placeholder when it carries only images or files. Never an older turn's
 * words. Null when the request holds no user turn.
 */
function latestUserTurnPrompt(request: WireRequest): string | null {
  const messageIndex = latestUserTurnMessageIndex(request);
  if (messageIndex < 0) return null;
  return userWordsInMessage(request.messages[messageIndex]) || MEDIA_PROMPT_PLACEHOLDER;
}

function commonPrefixLength(previous: string[], current: string[]): number {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length] === current[length]) length++;
  return length;
}

/** Tool arguments as an object when they are JSON (the hooks send objects), else the text as it came. */
function toolInputOf(argsText: string): unknown {
  try {
    return JSON.parse(argsText);
  } catch {
    return argsText;
  }
}

function rememberBounded<T>(set: Set<T>, value: T, cap: number): void {
  set.add(value);
  if (set.size > cap) set.delete(set.values().next().value as T);
}

export interface WireCaptureAssemblerOptions {
  eventSink: WireCaptureEventSink;
  now?: () => number;
}

export class WireCaptureAssembler {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly sessionsWithEvents = new Map<string, SessionWithEvents>();
  private readonly eventSink: WireCaptureEventSink;
  private readonly now: () => number;
  private unattributedEvents = 0;

  constructor(options: WireCaptureAssemblerOptions) {
    this.eventSink = options.eventSink;
    this.now = options.now ?? Date.now;
  }

  /** Events emitted with no known folder (filed under `<agentId>-unattributed`), for `wire status`. */
  get unattributedEventCount(): number {
    return this.unattributedEvents;
  }

  get trackedConversationCount(): number {
    return this.conversations.size;
  }

  observeExchange(exchange: WireAssemblerExchange): void {
    const { identity } = exchange;
    if (identity.kind === 'compaction') {
      this.emitCompactionSummary(exchange);
      return;
    }
    // Helper requests (titles, classifiers, token counts) never become events.
    if (identity.kind !== 'turn' && identity.kind !== 'subagent') return;

    const conversationKey = this.conversationKeyOf(identity);
    const isFirstSight = !this.conversations.has(conversationKey);
    const conversation = this.touchConversation(conversationKey);
    const items = requestItemsOf(exchange.request);
    const itemKeys = items.map(item => item.key);

    let firstNewItemIndex: number;
    let historyMatched: boolean;
    if (isFirstSight || conversation.previousItemKeys === null) {
      // Not born here (or unknown): everything before the latest user turn was seen.
      const latestTurnMessageIndex = latestUserTurnMessageIndex(exchange.request);
      firstNewItemIndex = latestTurnMessageIndex < 0 ? items.length : items.findIndex(item => item.messageIndex >= latestTurnMessageIndex);
      if (firstNewItemIndex < 0) firstNewItemIndex = items.length;
      historyMatched = false;
    } else {
      const prefixLength = commonPrefixLength(conversation.previousItemKeys, itemKeys);
      historyMatched = prefixLength === conversation.previousItemKeys.length;
      // On a mismatch every item is looked at again; ids already emitted are skipped.
      firstNewItemIndex = historyMatched ? prefixLength : 0;
    }

    if (identity.kind === 'turn') this.maybeEmitSessionInit(identity, exchange.request, conversation, isFirstSight, historyMatched);
    this.emitObservationsForNewResults(exchange, conversation, items, firstNewItemIndex);

    conversation.previousItemKeys = itemKeys;
    if (exchange.reply && exchange.replyIsWhole) {
      if (exchange.reply.text !== '') conversation.lastAssistantText = exchange.reply.text;
      for (const call of exchange.reply.toolCalls) {
        // A Gemini reply's positional id never matches the request's: such calls pair from the request history.
        if (call.id === '' || call.id.startsWith(GEMINI_REPLY_POSITIONAL_CALL_ID_PREFIX)) continue;
        conversation.pendingCalls.set(call.id, { name: call.name, argsText: call.argsJson, at: this.now() });
        if (conversation.pendingCalls.size > MAX_PENDING_CALLS_PER_CONVERSATION) {
          conversation.pendingCalls.delete(conversation.pendingCalls.keys().next().value as string);
        }
      }
    }
  }

  /** A turn of the session ended (TurnTracker): ask the worker to summarize it. */
  handleTurnEnd(turnEnd: WireTurnEnd): void {
    const session = this.sessionsWithEvents.get(this.sessionKeyOf(turnEnd.agentId, turnEnd.sessionId));
    // A session that never produced an event is unknown to the worker; its summary could never land.
    if (!session) return;
    const mainConversation = this.conversations.get(this.conversationKeyOf({ agentId: turnEnd.agentId, sessionId: turnEnd.sessionId }));
    const cwd = turnEnd.workDir ?? session.workDir;
    this.eventSink.emit('summarize', {
      contentSessionId: turnEnd.sessionId,
      platformSource: turnEnd.agentId,
      lastAssistantMessage: mainConversation?.lastAssistantText ?? '',
      ...(cwd !== undefined ? { cwd } : {}),
    });
  }

  /** The session went quiet for good (TurnTracker): end it and forget it. */
  handleSessionStale(stale: WireSessionStale): void {
    const sessionKey = this.sessionKeyOf(stale.agentId, stale.sessionId);
    if (this.sessionsWithEvents.has(sessionKey)) {
      this.eventSink.emit('session_end', { contentSessionId: stale.sessionId, platformSource: stale.agentId });
      this.sessionsWithEvents.delete(sessionKey);
    }
    const conversationPrefix = `${sessionKey}\u0000`;
    for (const conversationKey of [...this.conversations.keys()]) {
      if (conversationKey.startsWith(conversationPrefix)) this.conversations.delete(conversationKey);
    }
  }

  // -------------------------------------------------------------------------

  private sessionKeyOf(agentId: string, sessionId: string): string {
    return `${agentId}\u0000${sessionId}`;
  }

  private conversationKeyOf(identity: Pick<WireIdentity, 'agentId' | 'sessionId' | 'subagent'>): string {
    return `${this.sessionKeyOf(identity.agentId, identity.sessionId)}\u0000${identity.subagent ?? ''}`;
  }

  private touchConversation(conversationKey: string): ConversationState {
    let conversation = this.conversations.get(conversationKey);
    if (conversation) {
      this.conversations.delete(conversationKey);
    } else {
      conversation = {
        previousItemKeys: null,
        emittedToolUseIds: new Set(),
        pendingCalls: new Map(),
        lastAssistantText: '',
        lastInitializedUserTurnOrdinal: 0,
        lastInitializedUserWords: '',
      };
    }
    this.conversations.set(conversationKey, conversation);
    if (this.conversations.size > MAX_TRACKED_CONVERSATIONS) {
      this.conversations.delete(this.conversations.keys().next().value as string);
    }
    return conversation;
  }

  /** `cwd` when the folder is known; otherwise the `<agentId>-unattributed` project, counted. */
  private placeOf(identity: WireIdentity): { cwd: string } | { project: string } {
    if (identity.workDir !== undefined) return { cwd: identity.workDir };
    this.unattributedEvents++;
    return { project: `${identity.agentId}-unattributed` };
  }

  private noteSessionEvent(identity: WireIdentity, contentSessionId: string): void {
    const sessionKey = this.sessionKeyOf(identity.agentId, contentSessionId);
    const existing = this.sessionsWithEvents.get(sessionKey);
    const workDir = identity.workDir ?? existing?.workDir;
    this.sessionsWithEvents.set(sessionKey, { agentId: identity.agentId, sessionId: contentSessionId, ...(workDir !== undefined ? { workDir } : {}) });
  }

  /**
   * One session_init per user turn: its words, or the media placeholder for
   * a turn of only images or files (never an older turn's words). The
   * agent's own prompt id (Claude Code's prompt id, Codex's turn id) decides
   * first when this
   * request and the last initialized turn both have one: a new id is a new
   * turn even when the words repeat and the history does not (a Responses
   * `previous_response_id` request sends only its new input). Otherwise, with
   * the history matching, a higher ordinal is a new turn; on first sight or a
   * mismatch (a compaction rewrites the history and its ordinals), the same
   * words as the last turn initialized are that turn, not a new one.
   */
  private maybeEmitSessionInit(identity: WireIdentity, request: WireRequest, conversation: ConversationState, isFirstSight: boolean, historyMatched: boolean): void {
    const prompt = latestUserTurnPrompt(request);
    if (prompt === null) return;
    const agentPromptId = identity.nativePromptId && NATIVE_PROMPT_ID_PATTERN.test(identity.nativePromptId) ? identity.nativePromptId : undefined;
    const isNewTurn = isFirstSight
      ? true
      : agentPromptId !== undefined && conversation.lastInitializedNativePromptId !== undefined
        ? agentPromptId !== conversation.lastInitializedNativePromptId
        : historyMatched
          ? identity.userTurnOrdinal > conversation.lastInitializedUserTurnOrdinal
          : prompt !== conversation.lastInitializedUserWords;
    if (isNewTurn) {
      const nativePromptId = agentPromptId
        ?? `wire:${sha256Hex(identity.sessionId, String(identity.userTurnOrdinal), prompt).slice(0, 32)}`;
      this.eventSink.emit('session_init', {
        contentSessionId: identity.sessionId,
        platformSource: identity.agentId,
        prompt,
        nativePromptId,
        ...this.placeOf(identity),
      });
      this.noteSessionEvent(identity, identity.sessionId);
    }
    conversation.lastInitializedUserTurnOrdinal = identity.userTurnOrdinal;
    conversation.lastInitializedUserWords = prompt;
    conversation.lastInitializedNativePromptId = agentPromptId;
  }

  private emitObservationsForNewResults(exchange: WireAssemblerExchange, conversation: ConversationState, items: RequestItem[], firstNewItemIndex: number): void {
    const { identity } = exchange;
    const callsById = new Map<string, WirePart>();
    for (const item of items) {
      if (item.part.kind === 'tool_call' && item.part.callId) callsById.set(item.part.callId, item.part);
    }
    // How often each derived Gemini id was seen, so the same call made twice keeps two ids.
    const derivedIdOccurrences = new Map<string, number>();
    const contentSessionId = contentSessionIdOf(identity);

    items.forEach((item, itemIndex) => {
      const { part } = item;
      if (part.kind !== 'tool_result') return;
      const callId = part.callId;
      const call = callId ? callsById.get(callId) : undefined;
      const pendingCall = callId ? conversation.pendingCalls.get(callId) : undefined;
      const toolName = call?.name || pendingCall?.name || part.name || '';
      const argsText = call?.argsJson ?? pendingCall?.argsText ?? '{}';
      const resultText = (part.text ?? '') + (part.hasImages ? '\n[image]' : '');

      const toolUseId = toolUseIdOfResult({ callId, toolName, argsText, resultText }, derivedIdOccurrences);
      if (itemIndex < firstNewItemIndex || conversation.emittedToolUseIds.has(toolUseId)) return;
      if (!toolName) {
        logger.debug('WIRE', 'Tool result with no call to pair it with; not observed', { agentId: identity.agentId, callId });
        return;
      }
      if (callId) conversation.pendingCalls.delete(callId);
      rememberBounded(conversation.emittedToolUseIds, toolUseId, MAX_EMITTED_TOOL_USE_IDS_PER_CONVERSATION);
      this.eventSink.emit('observation', {
        contentSessionId,
        platformSource: identity.agentId,
        toolName,
        toolInput: toolInputOf(argsText),
        toolResponse: resultText,
        toolUseId,
        ...(identity.kind === 'subagent' && identity.subagent ? { agentId: identity.subagent, agentType: 'subagent' } : {}),
        ...this.placeOf(identity),
      });
      this.noteSessionEvent(identity, contentSessionId);
    });
  }

  private emitCompactionSummary(exchange: WireAssemblerExchange): void {
    const { identity, reply } = exchange;
    if (!reply || !exchange.replyIsWhole || reply.text.trim() === '') return;
    const contentSessionId = identity.parentSessionId ?? identity.sessionId;
    this.eventSink.emit('observation', {
      contentSessionId,
      platformSource: identity.agentId,
      toolName: CONTEXT_COMPACTION_TOOL_NAME,
      toolInput: {},
      toolResponse: reply.text,
      // The same summary replayed keeps its id, so the worker keeps one.
      toolUseId: `compaction-${sha256Hex(contentSessionId, reply.text).slice(0, 32)}`,
      ...this.placeOf(identity),
    });
    this.noteSessionEvent(identity, contentSessionId);
  }
}
