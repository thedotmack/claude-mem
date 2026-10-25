// SPDX-License-Identifier: Apache-2.0
//
// Endless Mode at the wire (Endless Mode v2): one growing timeline. In a
// conversation born under the gateway the request's conversation is always
//
//   [the agent's leading context, if any]
//   [the timeline: one user message, append-only]
//   [the live tail: what is not folded yet, the current turn's prompt raw]
//
// The timeline opens with claude-mem's session-start rows (the memory
// injection, which then goes here instead of the system prompt) and grows
// only at its end. A finished turn folds into it as rows, in order: its
// prompt (`U: …`), a row per observation of its tool work, its final reply
// (`A: …`). Inside the current turn, when an observation lands, its rows are
// appended and the tool calls it covers leave the tail. Each growth is one
// more text block before the timeline's closing tag, so every byte before
// it stays and the provider's cache reads the whole conversation up to it
// (Anthropic: the gateway's breakpoint sits on the timeline's last rows
// block, so a growth reads the entry the request before it wrote).
//
//   <claude-mem-timeline>            (first block: intro + session-start rows)
//   U: … / #<id> … / A: …            (one block per growth)
//   </claude-mem-timeline>           (last block, alone)
//
// The rules:
// - Covered calls: the latest tool call with an observation (conversation
//   wide) is the boundary; every call at or before it is covered, the ones
//   the observer skipped included (they fold with no row). The only trigger
//   is "an observation exists", never age or size.
// - Folds are a prefix: a turn folds whole when every call in it is covered,
//   else through its latest covered call whose run may be removed (and the
//   fold stops there). The current turn never folds whole: its prompt stays
//   raw, and only its covered calls leave, through the result of the run's
//   last call, never its latest assistant message or what follows it.
// - When: a fold changes the bytes in front of the current turn's messages,
//   which any thinking, sealed reasoning or signature in that turn is bound
//   to (Anthropic: "within a tool-use turn, pass thinking blocks back", and
//   a block stays valid only while the messages before it are unchanged;
//   Responses: "ensure all items between the last user message and your
//   function call output are passed into the next response untouched";
//   Gemini validates the current turn's thought signatures). So with any of
//   those in the current turn, folds wait for the next turn start; without,
//   they happen on any request.
// - Every fold is frozen in the ledger (`timelineFold`, by sequence) the
//   first time it is made and put back byte for byte on every later request
//   and after a restart. Positions are turn ordinals and call ids, never
//   message indexes.
// - Anthropic: a request that folds, and every turn-start request from turn
//   2 on, records a `thinkingCut` up to the latest turn first (held writes
//   commit in order), and every request applies the cut in force, so the
//   thinking of unfolded earlier messages goes oldest first with no gap.
// - Gemini positional call ids (`gemini:<content>:<part>`) are message
//   indexes, so none is ever recorded as a fold's last call; a turn that has
//   only those folds only whole.
// - The agent never waits on a mid-turn request: observations come from a
//   cache a background lookup fills (observation-lookup.ts). A turn-start
//   request waits up to CONTEXT_TIMEOUT_MS for the observations of earlier
//   turns' work, so the fold lands on it.
// - A context item (Codex's developer note sent again before a prompt, a
//   web search, a compaction) never folds: it stays, in order, in the tail
//   after the timeline, and the fold goes on around it.
// - A conversation the v1 swap stage changed, or one the earlier per-turn
//   cull layout changed, is suspended: never folded, sent as it comes.
// - A recorded fold the history no longer matches (a compaction, a rewind)
//   suspends the conversation: it goes as the agent sends it from then on.
// - Any failure leaves the bytes as they came (the seam fails open, D7.7);
//   the relay's pairing check is the last guard.

import { logger } from '../../../utils/logger.js';
import { renderAgentAssistantMessageRow, renderAgentUserPromptRow } from '../../context/formatters/exchange-rows.js';
import { endlessTimelineRowFormatOf } from '../../../shared/endless-timeline-row-format.js';
import { GEMINI_REQUEST_POSITIONAL_CALL_ID_PATTERN, contentSessionIdOf } from '../capture/capture-assembler.js';
import { startsUserTurn } from '../identity/turn-start.js';
import { TIMELINE_CLOSE_TAG, TIMELINE_OPEN_TAG, userWordsInMessage } from '../identity/user-words.js';
import { ScannedObject } from '../ir/scanned-object.js';
import type { WireRequest } from '../ir/types.js';
import { applyByteSplices } from '../json/byte-splices.js';
import { arrayElements, objectMembers, rawText, scanDocument, type JsonSpan } from '../json/scanner.js';
import { encodeJsonString, replaceSpan } from '../json/splice.js';
import type { WireConversationLedgerView, WireLedgerEntry } from '../ledger/conversation-ledger.js';
import { DEFAULT_CONTEXT_TIMEOUT_MS } from '../memory/memory-injection-stage.js';
import { estimateTextTokens } from '../metrics/context-buckets.js';
import { cacheControlJsonOf, cacheControlTtlsIn, gatewayBreakpointTtl, type CacheTtl } from '../header/head-cache-breakpoint-stage.js';
import { STAGE_BUDGET_MARGIN_MS, type WireRewriteContext, type WireRewriteStage } from '../rewrite/rewrite-stage.js';
import { thinkingCutInForce, thinkingCutSplices } from '../rewrite/thinking-drop.js';
import { ENDLESS_ROW_FORMAT_SETTING, endlessModeEnabledFor } from './endless-mode-setting.js';
import type { WireObservationLookup, WireToolObservation } from './observation-lookup.js';
import { toolUseIdsByCallIdOf } from './tool-use-ids.js';

export { ENDLESS_MODE_SETTING, ENDLESS_ROW_FORMAT_SETTING, endlessModeEnabledFor } from './endless-mode-setting.js';

export const ENDLESS_MODE_STAGE_NAME = 'endless-mode';

const SUSPENDED_ENTRY_ID = `suspended:${ENDLESS_MODE_STAGE_NAME}`;

/** What the timeline's first block says it is, before the session-start rows. */
export const TIMELINE_INTRO = 'claude-mem timeline: what happened before the current turn, oldest first. '
  + 'Each finished turn is its prompt (U:), a row per observation of its tool work, and its final reply (A:); '
  + 'the current turn follows the timeline as it happened, its finished tool work folded into rows here as observations land.';

type FoldEntry = Extract<WireLedgerEntry, { type: 'timelineFold' }>;

/** How far the conversation is folded: through turn `turnOrdinal`, whole when `throughCallId` is null, else through that call's result. Turn 0: nothing. */
interface Frontier {
  turnOrdinal: number;
  throughCallId: string | null;
}

/** The timeline's text blocks before its closing one: the first (intro and session-start rows), then one per fold that added rows. */
export function timelineBlockTextsOf(sessionStartText: string | null, foldRows: ReadonlyArray<readonly string[]>): string[] {
  const head = `${TIMELINE_OPEN_TAG}\n${TIMELINE_INTRO}${sessionStartText ? `\n\n${sessionStartText}` : ''}`;
  return [head, ...foldRows.filter(rows => rows.length > 0).map(timelineRowsBlockText)];
}

/** One fold's rows as a block: one per line, or a blank line apart when a row runs over several lines. */
export function timelineRowsBlockText(rows: readonly string[]): string {
  return rows.join(rows.some(row => row.includes('\n')) ? '\n\n' : '\n');
}

interface UserTurn {
  ordinal: number;
  /** The index of the user message that starts it. */
  startIndex: number;
  /** The index after its last message. */
  endIndex: number;
}

interface TurnCall {
  callId: string;
  messageIndex: number;
}

/** The request's user turns, numbered as userTurnPositionOfRequest numbers them. */
function userTurnsOf(request: WireRequest): UserTurn[] {
  const turns: UserTurn[] = [];
  request.messages.forEach((message, messageIndex) => {
    if (!startsUserTurn(message)) return;
    const previous = turns[turns.length - 1];
    if (previous) previous.endIndex = messageIndex;
    turns.push({ ordinal: turns.length + 1, startIndex: messageIndex, endIndex: request.messages.length });
  });
  return turns;
}

/** The turn's tool calls, in order. */
function callsOf(request: WireRequest, turn: UserTurn): TurnCall[] {
  const calls: TurnCall[] = [];
  for (let messageIndex = turn.startIndex + 1; messageIndex < turn.endIndex; messageIndex++) {
    for (const part of request.messages[messageIndex].parts) {
      if (part.kind === 'tool_call' && part.callId) calls.push({ callId: part.callId, messageIndex });
    }
  }
  return calls;
}

/** The index of the message after `callIndex` (within the turn) that carries `callId`'s result; -1 when none does. */
function resultIndexOf(request: WireRequest, turn: UserTurn, callId: string, callIndex: number): number {
  for (let messageIndex = callIndex + 1; messageIndex < turn.endIndex; messageIndex++) {
    if (request.messages[messageIndex].parts.some(part => part.kind === 'tool_result' && part.callId === callId)) return messageIndex;
  }
  return -1;
}

/** Whether the turn holds reasoning bound to the prefix: thinking, sealed reasoning, or a signed part. */
function turnHoldsReasoning(request: WireRequest, turn: UserTurn): boolean {
  for (let messageIndex = turn.startIndex; messageIndex < turn.endIndex; messageIndex++) {
    if (request.messages[messageIndex].parts.some(part => part.kind === 'thinking' || part.kind === 'sealed' || part.sealedBy !== undefined)) return true;
  }
  return false;
}

function spansOverlap(first: JsonSpan, second: JsonSpan): boolean {
  return first.start < second.end && second.start < first.end;
}

/** The array a conversation's messages are elements of: Anthropic and Chat `messages`, Responses `input`, Gemini `contents`. */
function conversationArraySpanOf(request: WireRequest): JsonSpan | null {
  const root = new ScannedObject(request.body, scanDocument(request.body));
  const key = request.protocol === 'openai-responses' ? 'input' : request.protocol === 'gemini' ? 'contents' : 'messages';
  const span = root.spanOf(key);
  return span?.type === 'array' ? span : null;
}

/**
 * Whether message `messageIndex` is the harness's note about the run's own
 * work: a system-role message (Claude Code 2.1.310 sends
 * `{"role":"system","content":"<total_tokens>… tokens left</total_tokens>"}`
 * after every tool result) strictly inside the run, after a tool result and
 * before the next assistant message that calls a tool, with only other such
 * notes between.
 */
function isHarnessNoteInsideRun(request: WireRequest, messageIndex: number, firstIndex: number, lastIndex: number): boolean {
  if (request.messages[messageIndex].role !== 'system' || messageIndex <= firstIndex || messageIndex >= lastIndex) return false;
  let previousIndex = messageIndex - 1;
  while (previousIndex > firstIndex && request.messages[previousIndex].role === 'system') previousIndex--;
  let nextIndex = messageIndex + 1;
  while (nextIndex < lastIndex && request.messages[nextIndex].role === 'system') nextIndex++;
  const previous = request.messages[previousIndex];
  const next = request.messages[nextIndex];
  return previous.role === 'user' && previous.parts.some(part => part.kind === 'tool_result')
    && next.role === 'assistant' && next.parts.some(part => part.kind === 'tool_call');
}

/** What a request folds away at a frontier: the removed messages and elements, and the elements left, in order. */
interface FoldRegion {
  removedMessageIndexes: Set<number>;
  removedElements: JsonSpan[];
  /** The agent's context before the first turn: it stays in front of the timeline. */
  leadingElements: JsonSpan[];
  /** What follows the timeline. */
  tailElements: JsonSpan[];
}

/**
 * What folding the request at `frontier` removes; a reason string when the
 * history does not allow it. Finished turns fold whole (their prompt and
 * reply become rows; any tool work, reasoning, text, harness note goes);
 * the current turn keeps its prompt and folds only the run from its first
 * call through `throughCallId`'s result, which may hold only tool work,
 * reasoning, the model's text and the harness's notes inside the run. A run
 * keeps every call with its result. Nothing the parser skipped is ever
 * folded; a context item (a Codex developer note, compaction or web search)
 * stays, in order, in the tail.
 */
function foldRegionOf(
  request: WireRequest,
  conversationElements: JsonSpan[],
  turns: UserTurn[],
  frontier: Frontier,
  latestAssistantIndex: number,
): FoldRegion | string {
  const latestTurn = turns[turns.length - 1];
  const removed = new Set<number>();
  // Messages of the current turn's run: removed only under the strict rules.
  let strictRun: { firstIndex: number; lastIndex: number } | null = null;
  if (frontier.turnOrdinal > latestTurn.ordinal) return `turn ${frontier.turnOrdinal} is not in the history`;
  for (const turn of turns) {
    if (turn.ordinal > frontier.turnOrdinal) break;
    const whole = turn.ordinal < frontier.turnOrdinal || frontier.throughCallId === null;
    if (whole) {
      if (turn === latestTurn) return 'the current turn never folds whole';
      for (let messageIndex = turn.startIndex; messageIndex < turn.endIndex; messageIndex++) removed.add(messageIndex);
      continue;
    }
    const calls = callsOf(request, turn);
    const through = calls.find(call => call.callId === frontier.throughCallId);
    if (!through) return `call ${frontier.throughCallId} is not in turn ${turn.ordinal}`;
    const resultIndex = resultIndexOf(request, turn, through.callId, through.messageIndex);
    const endLimit = turn === latestTurn ? latestAssistantIndex : turn.endIndex;
    if (resultIndex < 0 || resultIndex >= endLimit) return `call ${through.callId} has no result before the in-flight loop`;
    if (request.messages[resultIndex].role === 'assistant') return 'a run ends on a message that is not the model\'s';
    const firstIndex = turn === latestTurn ? calls[0].messageIndex : turn.startIndex;
    if (turn === latestTurn) strictRun = { firstIndex, lastIndex: resultIndex };
    for (let messageIndex = firstIndex; messageIndex <= resultIndex; messageIndex++) {
      if (strictRun && request.messages[messageIndex].role === 'system' && !isHarnessNoteInsideRun(request, messageIndex, firstIndex, resultIndex)) {
        return 'a system message inside the current turn\'s run is not a note about the run';
      }
      removed.add(messageIndex);
    }
  }

  // Every call goes with its result, and every result with its call.
  const unpaired = new Map<string, number>();
  for (const messageIndex of removed) {
    for (const part of request.messages[messageIndex].parts) {
      if (part.kind !== 'tool_call' && part.kind !== 'tool_result') continue;
      if (!part.callId) return 'a tool part has no call id';
      unpaired.set(part.callId, (unpaired.get(part.callId) ?? 0) + (part.kind === 'tool_call' ? 1 : -1));
    }
  }
  if ([...unpaired.values()].some(count => count !== 0)) return 'a call would be folded without its result, or a result without its call';

  const firstTurnStart = request.messages[turns[0].startIndex].span.start;
  const removedElements: JsonSpan[] = [];
  const leadingElements: JsonSpan[] = [];
  const tailElements: JsonSpan[] = [];
  const run = strictRun as { firstIndex: number; lastIndex: number } | null;
  for (const element of conversationElements) {
    const overlapping = request.messages.map((message, messageIndex) => ({ message, messageIndex }))
      .filter(({ message }) => spansOverlap(message.span, element));
    const removedOverlaps = overlapping.filter(({ messageIndex }) => removed.has(messageIndex));
    if (removedOverlaps.length === 0) {
      if (overlapping.length === 0 && removed.size > 0 && element.start > firstTurnStart && element.start < Math.max(...[...removed].map(index => request.messages[index].span.end))) {
        return 'an element the parser skipped sits inside the folded history';
      }
      (element.end <= firstTurnStart ? leadingElements : tailElements).push(element);
      continue;
    }
    if (removedOverlaps.length !== overlapping.length) return 'an element holds both folded and kept messages';
    const parts = removedOverlaps.flatMap(({ message, messageIndex }) => message.parts
      .filter(part => spansOverlap(part.span, element)).map(part => ({ part, message, messageIndex })));
    // A context item (a developer note Codex sends again before a prompt, a web search, a compaction) is the
    // agent's, not tool work: it stays, in order, after the timeline, and the fold goes on around it.
    if (parts.length > 0 && parts.every(({ part }) => part.kind === 'context')) {
      tailElements.push(element);
      continue;
    }
    for (const { part, message, messageIndex } of parts) {
      const inRun = run !== null && messageIndex >= run.firstIndex && messageIndex <= run.lastIndex;
      if (part.kind === 'context') return `an element holds a ${part.name ?? 'context'} item beside other parts`;
      if (inRun && part.kind === 'text' && message.role === 'user') return 'the current turn\'s run holds a user text part';
    }
    removedElements.push(element);
  }
  return { removedMessageIndexes: removed, removedElements, leadingElements, tailElements };
}

/** The text of the turn's final reply: its last message when that is the model's words with no tool call; null when the turn has none. */
function finalReplyTextOf(request: WireRequest, turn: UserTurn): string | null {
  const last = request.messages[turn.endIndex - 1];
  if (turn.endIndex - 1 <= turn.startIndex || last.role !== 'assistant' || last.parts.some(part => part.kind === 'tool_call')) return null;
  const text = last.parts.filter(part => part.kind === 'text').map(part => part.text ?? '').join('\n').trim();
  return text === '' ? null : text;
}

/** Whether call (turnOrdinal, order) comes at or before `boundary` (null: nothing is covered). */
function isCovered(boundary: { turnOrdinal: number; order: number } | null, turnOrdinal: number, order: number): boolean {
  return boundary !== null && (turnOrdinal < boundary.turnOrdinal || (turnOrdinal === boundary.turnOrdinal && order <= boundary.order));
}

/** Whether frontier `later` folds more than `earlier`. */
function foldsFurther(request: WireRequest, turns: UserTurn[], earlier: Frontier, later: Frontier): boolean {
  if (later.turnOrdinal !== earlier.turnOrdinal) return later.turnOrdinal > earlier.turnOrdinal;
  if (earlier.throughCallId === null) return false;
  if (later.throughCallId === null) return true;
  const calls = callsOf(request, turns[later.turnOrdinal - 1]);
  return calls.findIndex(call => call.callId === later.throughCallId) > calls.findIndex(call => call.callId === earlier.throughCallId);
}

/** The JSON of the timeline's parts (text blocks) for the protocol, the breakpoint on the last rows block when `ttl` is set. */
function timelinePartsJson(protocol: WireRequest['protocol'], blockTexts: string[], ttl: CacheTtl | null): string[] {
  const partOf = (text: string, marked: boolean) => {
    const encoded = encodeJsonString(text);
    switch (protocol) {
      case 'gemini':
        return `{"text":${encoded}}`;
      case 'openai-responses':
        return `{"type":"input_text","text":${encoded}}`;
      default:
        return `{"type":"text","text":${encoded}${marked ? `,"cache_control":${cacheControlJsonOf(ttl as CacheTtl)}` : ''}}`;
    }
  };
  return [...blockTexts.map((text, index) => partOf(text, ttl !== null && index === blockTexts.length - 1)), partOf(TIMELINE_CLOSE_TAG, false)];
}

/** Every cache_control TTL in the values at `spans`. */
function ttlsIn(bytes: Uint8Array, spans: Array<JsonSpan | undefined>): Array<CacheTtl | null> {
  return spans.flatMap(span => (span ? cacheControlTtlsIn(bytes, span) : []));
}

/**
 * The request with its conversation laid out as leading context, the
 * timeline, then the tail; null (with the reason logged) when the protocol
 * leaves the timeline no place. Gemini: the timeline's parts go first in the
 * user content that starts the tail (two user contents in a row are not
 * allowed), or are a user content of their own when the tail starts with
 * the model's; written as `{"role":"user","parts":[` either way, so the
 * bytes through the timeline are the same in both.
 */
function withTimeline(request: WireRequest, conversationArraySpan: JsonSpan, region: FoldRegion, blockTexts: string[]): Uint8Array | null {
  const body = request.body;
  const raw = (span: JsonSpan) => rawText(body, span);
  let ttl: CacheTtl | null = null;
  if (request.protocol === 'anthropic') {
    const root = new ScannedObject(body, scanDocument(body));
    const topLevel = root.spanOf('cache_control');
    const topLevelTtl = topLevel ? ScannedObject.of(body, topLevel)?.string('ttl') ?? '5m' : undefined;
    // Render order is tools → system → messages; automatic caching (top-level cache_control) marks the last block.
    ttl = gatewayBreakpointTtl(
      ttlsIn(body, [root.spanOf('tools'), root.spanOf('system'), ...region.leadingElements]),
      [...ttlsIn(body, region.tailElements), ...(topLevelTtl === undefined ? [] : [topLevelTtl === '5m' || topLevelTtl === '1h' ? topLevelTtl as CacheTtl : null])],
      'Endless Mode\'s timeline breakpoint',
    );
  }
  const parts = timelinePartsJson(request.protocol, blockTexts, ttl).join(',');
  const items: string[] = region.leadingElements.map(raw);
  let tail = region.tailElements.map(raw);
  switch (request.protocol) {
    case 'anthropic':
    case 'openai-chat':
      items.push(`{"role":"user","content":[${parts}]}`);
      break;
    case 'openai-responses':
      items.push(`{"type":"message","role":"user","content":[${parts}]}`);
      break;
    case 'gemini': {
      const lastLeading = region.leadingElements.at(-1);
      if (lastLeading && ScannedObject.of(body, lastLeading)?.string('role') !== 'model') {
        logger.debug('WIRE', 'Endless Mode has no place for the timeline: the agent\'s leading context ends on a user content');
        return null;
      }
      const first = region.tailElements[0] ? ScannedObject.of(body, region.tailElements[0]) : undefined;
      if (first && first.string('role') === 'user') {
        const members = [...objectMembers(body, first.span)];
        const partsSpan = first.spanOf('parts');
        if (partsSpan?.type !== 'array' || members.some(member => member.key !== 'role' && member.key !== 'parts')) {
          logger.debug('WIRE', 'Endless Mode has no place for the timeline: the tail\'s first user content is not only role and parts');
          return null;
        }
        const userParts = [...arrayElements(body, partsSpan)].map(raw);
        items.push(`{"role":"user","parts":[${[parts, ...userParts].join(',')}]}`);
        tail = tail.slice(1);
      } else {
        items.push(`{"role":"user","parts":[${parts}]}`);
      }
      break;
    }
  }
  return replaceSpan(body, conversationArraySpan, `[${[...items, ...tail].join(',')}]`);
}

export interface EndlessModeStageOptions {
  observationLookup: WireObservationLookup;
  /** CONTEXT_TIMEOUT_MS: how long a turn-start request waits for the observations of earlier turns' work. */
  contextTimeoutMs?: number;
  now?: () => number;
}

/** `promise` settled, or `timeoutMs` passed, whichever comes first; never throws (the lookup never does). */
async function settledWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function createEndlessModeStage(options: EndlessModeStageOptions): WireRewriteStage {
  const now = options.now ?? Date.now;
  const contextTimeoutMs = options.contextTimeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const suspend = (ledger: WireConversationLedgerView) => ledger.record({ type: 'suspended', stage: ENDLESS_MODE_STAGE_NAME, at: new Date(now()).toISOString() });

  return {
    name: ENDLESS_MODE_STAGE_NAME,
    // A turn-start request waits for the worker's observations up to CONTEXT_TIMEOUT_MS, as the
    // durable header's turn-start fetch does, plus the shared margin for the splices and ledger writes.
    budgetMs: contextTimeoutMs + STAGE_BUDGET_MARGIN_MS,
    enabledFor: endlessModeEnabledFor,
    // A conversation whose timeline once went missing (the stage was off for one of its requests) is never
    // given one again: the model has answered the original history since, so putting it back would rewrite it.
    appliesTo: context => context.ledger?.status === 'born' && context.ledger.get(SUSPENDED_ENTRY_ID) === undefined,

    whileOff(ledger) {
      if (ledger.status !== 'born' || ledger.get(SUSPENDED_ENTRY_ID)) return;
      const injection = ledger.get('injection');
      const hadTimeline = ledger.entries().some(entry => entry.type === 'timelineFold' || entry.type === 'cull')
        || (injection?.type === 'injection' && injection.placement === 'timeline');
      if (!hadTimeline) return;
      suspend(ledger);
      logger.debug('WIRE', 'Endless Mode was off for a conversation it had given a timeline; it never folds that conversation again', {
        conversationKey: ledger.conversationKey,
      });
    },

    async onRequest(context: WireRewriteContext, body: Uint8Array) {
      const ledger = context.ledger as WireConversationLedgerView;
      if (ledger.entries().some(entry => entry.type === 'swap' || entry.type === 'thinkingDrop' || entry.type === 'cull')) {
        // Endless Mode v1's swaps, or the earlier per-turn cull layout: neither is put back, so the conversation is left alone for good.
        suspend(ledger);
        logger.debug('WIRE', 'Endless Mode suspended a conversation an earlier layout had changed', { conversationKey: ledger.conversationKey });
        return undefined;
      }
      const rowFormat = endlessTimelineRowFormatOf(context.settings[ENDLESS_ROW_FORMAT_SETTING]);
      const request = context.requestOf(body);
      const conversationArraySpan = conversationArraySpanOf(request);
      const turns = userTurnsOf(request);
      const latestTurn = turns[turns.length - 1];
      if (!conversationArraySpan || !latestTurn) return undefined;
      const conversationElements = [...arrayElements(body, conversationArraySpan)];
      const toolUseIdByCallId = toolUseIdsByCallIdOf(request);
      const observationsOf = (callId: string): WireToolObservation[] => {
        const toolUseId = toolUseIdByCallId.get(callId);
        return (toolUseId === undefined ? undefined : options.observationLookup.cached(ledger.conversationKey, toolUseId)) ?? [];
      };
      const lookupQuery = (toolUseIds: string[]) => ({
        contentSessionId: contentSessionIdOf(context.identity), platformSource: context.identity.agentId, toolUseIds, rowFormat,
      });

      // The in-flight loop's latest assistant message, and what follows it, is never folded.
      let latestAssistantIndex = request.messages.length;
      for (let messageIndex = request.messages.length - 1; messageIndex > latestTurn.startIndex; messageIndex--) {
        if (request.messages[messageIndex].role === 'assistant') {
          latestAssistantIndex = messageIndex;
          break;
        }
      }

      const recordedFolds = ledger.entries().filter((entry): entry is FoldEntry => entry.type === 'timelineFold').sort((first, second) => first.sequence - second.sequence);
      const frontierOf = (fold: FoldEntry | undefined): Frontier => fold
        ? { turnOrdinal: fold.throughTurnOrdinal, throughCallId: fold.throughCallId }
        : { turnOrdinal: 0, throughCallId: null };
      // The newest fold this request's history holds. An older one when the agent sent an earlier request again
      // (a retry): it gets the timeline it had then, and nothing new is folded on it.
      let foldsInForceCount = recordedFolds.length;
      while (foldsInForceCount > 1 && typeof foldRegionOf(request, conversationElements, turns, frontierOf(recordedFolds[foldsInForceCount - 1]), latestAssistantIndex) === 'string') {
        foldsInForceCount--;
      }
      const isRetry = foldsInForceCount < recordedFolds.length;
      if (isRetry && foldsInForceCount <= 1) {
        // Not even the first fold matches: the agent changed the folded history (compaction, rewind), and the
        // frozen timeline no longer describes it.
        suspend(ledger);
        logger.warn('WIRE', 'Endless Mode suspended a conversation: its folded history no longer matches the request', {
          conversationKey: ledger.conversationKey,
          reason: foldRegionOf(request, conversationElements, turns, frontierOf(recordedFolds.at(-1)), latestAssistantIndex),
        });
        return undefined;
      }
      const folds = recordedFolds.slice(0, foldsInForceCount);
      const recordedFrontier = frontierOf(folds.at(-1));
      // The calls not folded yet, in conversation order, with their turn and order in it.
      const unfoldedCalls: Array<{ turn: UserTurn; order: number; call: TurnCall }> = [];
      for (const turn of turns) {
        if (turn.ordinal < recordedFrontier.turnOrdinal || (turn.ordinal === recordedFrontier.turnOrdinal && recordedFrontier.throughCallId === null)) continue;
        const calls = callsOf(request, turn);
        const throughOrder = turn.ordinal === recordedFrontier.turnOrdinal ? calls.findIndex(call => call.callId === recordedFrontier.throughCallId) : -1;
        calls.forEach((call, order) => { if (order > throughOrder) unfoldedCalls.push({ turn, order, call }); });
      }

      // A fold changes the bytes in front of the current turn: with reasoning bound to them, only at a turn start.
      const mayFoldNow = !isRetry && (!turnHoldsReasoning(request, latestTurn) || context.identity.turnStart);
      if (context.identity.turnStart) {
        // A turn start is when a fold of earlier turns costs nothing extra, so it waits (within
        // CONTEXT_TIMEOUT_MS) for their observations, rather than folding mid-loop a request later.
        const toolUseIdsToAwait = unfoldedCalls.filter(({ turn }) => turn !== latestTurn)
          .map(({ call }) => toolUseIdByCallId.get(call.callId)).filter((id): id is string => id !== undefined);
        if (toolUseIdsToAwait.length > 0) {
          const deadline = now() + contextTimeoutMs;
          await settledWithin(options.observationLookup.requestRefresh(ledger.conversationKey, lookupQuery(toolUseIdsToAwait)), contextTimeoutMs);
          // A lookup already in flight (another request's) was joined above; ask again for what it did not cover.
          const remainingMs = deadline - now();
          if (remainingMs > 0) await settledWithin(options.observationLookup.requestRefresh(ledger.conversationKey, lookupQuery(toolUseIdsToAwait)), remainingMs);
        }
      }

      // The new frontier: as far as covered work goes, finished turns whole, then one partial turn.
      let newFrontier: Frontier = recordedFrontier;
      if (mayFoldNow) {
        let boundary: { turnOrdinal: number; order: number } | null = null;
        for (const { turn, order, call } of unfoldedCalls) {
          if (turn === latestTurn && call.messageIndex >= latestAssistantIndex) break;
          if (observationsOf(call.callId).length > 0) boundary = { turnOrdinal: turn.ordinal, order };
        }
        const startOrdinal = recordedFrontier.throughCallId === null ? recordedFrontier.turnOrdinal + 1 : recordedFrontier.turnOrdinal;
        for (const turn of turns.slice(startOrdinal - 1)) {
          const calls = callsOf(request, turn);
          const fullyCovered = calls.every((_, order) => isCovered(boundary, turn.ordinal, order));
          if (turn !== latestTurn && fullyCovered) {
            const candidate: Frontier = { turnOrdinal: turn.ordinal, throughCallId: null };
            if (typeof foldRegionOf(request, conversationElements, turns, candidate, latestAssistantIndex) !== 'string') {
              newFrontier = candidate;
              continue;
            }
            // The whole turn may not go (a context item in it): as far into it as may.
          }
          // Partly covered: through the latest covered call whose run may go, never a position id.
          for (let order = calls.length - 1; order >= 0; order--) {
            if (!isCovered(boundary, turn.ordinal, order)) continue;
            const call = calls[order];
            if (GEMINI_REQUEST_POSITIONAL_CALL_ID_PATTERN.test(call.callId)) continue;
            // The run's last call: a later call before its result (a parallel sibling) would be the one it runs through.
            const resultIndex = resultIndexOf(request, turn, call.callId, call.messageIndex);
            if ((calls[order + 1]?.messageIndex ?? Number.POSITIVE_INFINITY) <= resultIndex) continue;
            // An assistant message with a call that is not covered is not folded: the run stops before it.
            if (calls.some((other, otherOrder) => otherOrder > order && other.messageIndex === call.messageIndex)) continue;
            const candidate: Frontier = { turnOrdinal: turn.ordinal, throughCallId: call.callId };
            if (!foldsFurther(request, turns, newFrontier, candidate)) break;
            if (typeof foldRegionOf(request, conversationElements, turns, candidate, latestAssistantIndex) !== 'string') {
              newFrontier = candidate;
              break;
            }
          }
          break;
        }
      }

      let newFold: FoldEntry | null = null;
      if (foldsFurther(request, turns, recordedFrontier, newFrontier)) {
        const seenObservationIds = new Set(folds.flatMap(fold => fold.observationIds));
        const rows: string[] = [];
        const observationIds: number[] = [];
        const startOrdinal = recordedFrontier.throughCallId === null ? recordedFrontier.turnOrdinal + 1 : recordedFrontier.turnOrdinal;
        for (const turn of turns.slice(startOrdinal - 1, newFrontier.turnOrdinal)) {
          if (turn.ordinal > recordedFrontier.turnOrdinal) {
            const words = userWordsInMessage(request.messages[turn.startIndex]);
            if (words !== '') rows.push(renderAgentUserPromptRow(words));
          }
          const calls = callsOf(request, turn);
          const fromOrder = turn.ordinal === recordedFrontier.turnOrdinal ? calls.findIndex(call => call.callId === recordedFrontier.throughCallId) + 1 : 0;
          const throughOrder = turn.ordinal === newFrontier.turnOrdinal && newFrontier.throughCallId !== null
            ? calls.findIndex(call => call.callId === newFrontier.throughCallId) : calls.length - 1;
          for (const call of calls.slice(fromOrder, throughOrder + 1)) {
            for (const observation of observationsOf(call.callId)) {
              if (seenObservationIds.has(observation.observationId)) continue;
              seenObservationIds.add(observation.observationId);
              observationIds.push(observation.observationId);
              rows.push(observation.row);
            }
          }
          const whole = turn.ordinal < newFrontier.turnOrdinal || newFrontier.throughCallId === null;
          const reply = whole ? finalReplyTextOf(request, turn) : null;
          if (reply !== null) rows.push(renderAgentAssistantMessageRow(reply));
        }
        const before = foldRegionOf(request, conversationElements, turns, recordedFrontier, latestAssistantIndex) as FoldRegion;
        const after = foldRegionOf(request, conversationElements, turns, newFrontier, latestAssistantIndex) as FoldRegion;
        const wasRemoved = new Set(before.removedElements.map(element => element.start));
        const removedTokens = after.removedElements.filter(element => !wasRemoved.has(element.start))
          .reduce((sum, element) => sum + estimateTextTokens(rawText(body, element)), 0);
        newFold = {
          type: 'timelineFold', sequence: (recordedFolds.at(-1)?.sequence ?? 0) + 1,
          throughTurnOrdinal: newFrontier.turnOrdinal, throughCallId: newFrontier.throughCallId,
          rows, observationIds, culledTokensEst: Math.max(0, removedTokens - estimateTextTokens(timelineRowsBlockText(rows))),
        };
      }

      // Opened on the first request the stage applies to; recorded before the cut and the fold that build on it.
      if (folds.length === 0) {
        const opener: FoldEntry = { type: 'timelineFold', sequence: 0, throughTurnOrdinal: 0, throughCallId: null, rows: [], observationIds: [], culledTokensEst: 0 };
        folds.push(ledger.record(opener) as FoldEntry);
      }
      // Recorded before the fold that needs it: held writes commit in order, with no rollback. Every turn start
      // cuts up to itself, fold or not, so each cut only takes out thinking after the previous turn-start request's last message.
      let cutUntilTurnOrdinal = request.protocol === 'anthropic' ? thinkingCutInForce(ledger) : null;
      if ((newFold !== null || (context.identity.turnStart && latestTurn.ordinal > 1)) && request.protocol === 'anthropic'
        && (cutUntilTurnOrdinal === null || cutUntilTurnOrdinal < latestTurn.ordinal)) {
        ledger.record({ type: 'thinkingCut', untilTurnOrdinal: latestTurn.ordinal });
        cutUntilTurnOrdinal = latestTurn.ordinal;
      }
      let frontierInForce = recordedFrontier;
      if (newFold !== null) {
        const recorded = ledger.record(newFold);
        if (recorded === newFold) {
          folds.push(newFold);
          frontierInForce = newFrontier;
          context.estimates.culledTokens += newFold.culledTokensEst;
        } else if (recorded.type === 'timelineFold') {
          // First write wins: another request recorded this sequence; it goes as recorded, on the next request.
          logger.debug('WIRE', 'Endless Mode found its fold already recorded by another request; this request keeps the timeline it had', {
            conversationKey: ledger.conversationKey, sequence: newFold.sequence,
          });
        }
      }

      // Background lookups for the calls not folded yet; never waited for.
      const foldedCallIds = new Set<string>();
      const inForceRegion = foldRegionOf(request, conversationElements, turns, frontierInForce, latestAssistantIndex) as FoldRegion;
      for (const messageIndex of inForceRegion.removedMessageIndexes) {
        for (const part of request.messages[messageIndex].parts) if (part.kind === 'tool_call' && part.callId) foldedCallIds.add(part.callId);
      }
      const toolUseIdsToLookUp = [...toolUseIdByCallId].filter(([callId]) => !foldedCallIds.has(callId)).map(([, toolUseId]) => toolUseId);
      if (toolUseIdsToLookUp.length > 0) void options.observationLookup.requestRefresh(ledger.conversationKey, lookupQuery(toolUseIdsToLookUp));

      // The thinking cut first, on the agent's bytes; then the layout, on the cut request (positions are ordinals and call ids).
      let cutRequest = request;
      if (cutUntilTurnOrdinal !== null) {
        const cutSplices = thinkingCutSplices(request, cutUntilTurnOrdinal);
        if (cutSplices.length > 0) cutRequest = context.requestOf(applyByteSplices(body, cutSplices));
      }
      const cutArraySpan = conversationArraySpanOf(cutRequest) as JsonSpan;
      const cutTurns = userTurnsOf(cutRequest);
      let cutLatestAssistantIndex = cutRequest.messages.length;
      for (let messageIndex = cutRequest.messages.length - 1; messageIndex > cutTurns[cutTurns.length - 1].startIndex; messageIndex--) {
        if (cutRequest.messages[messageIndex].role === 'assistant') {
          cutLatestAssistantIndex = messageIndex;
          break;
        }
      }
      const region = foldRegionOf(cutRequest, [...arrayElements(cutRequest.body, cutArraySpan)], cutTurns, frontierInForce, cutLatestAssistantIndex);
      if (typeof region === 'string') throw new Error(`the fold in force does not apply to the cut request: ${region}`);
      const injection = ledger.get('injection');
      const sessionStartText = injection?.type === 'injection' && injection.placement === 'timeline' ? injection.text : null;
      const blockTexts = timelineBlockTextsOf(sessionStartText, folds.map(fold => fold.rows));
      const rewritten = withTimeline(cutRequest, cutArraySpan, region, blockTexts);
      if (rewritten === null) {
        // Without a place for the timeline the frozen layout cannot be put back; failing open on every request
        // would send the original history, so the conversation goes as it comes from now on.
        suspend(ledger);
        logger.warn('WIRE', 'Endless Mode suspended a conversation: its timeline has no place in the request', { conversationKey: ledger.conversationKey });
        return undefined;
      }
      if (sessionStartText) context.estimates.injectedTokens += estimateTextTokens(sessionStartText);
      return rewritten;
    },
  };
}
