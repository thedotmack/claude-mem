// SPDX-License-Identifier: Apache-2.0
//
// Endless Mode at the wire (Endless Mode v2, plan Phase 4): the "work/tools
// → observations" loop. In a conversation born under the gateway, a
// finished stretch of tool work whose observation exists leaves the request
// whole, and the one-line timeline entry of each observation it produced is
// appended to the user message that started its turn:
//
//   <claude-mem-work>
//   #<id> <time> <icon> <title>
//   </claude-mem-work>
//
// Each cull is frozen in the conversation ledger the first time it is made
// and put back byte for byte on every later request (and after a restart),
// so the middle of the request only grows by those lines.
//
// The rules, each from the plan:
// - Covered calls: in a turn, the latest tool call with an observation is
//   the boundary; every call at or before it is covered, the ones the
//   observer skipped included. The only trigger is "an observation exists",
//   never age or size.
// - Whole messages: the run from the turn's first assistant message that
//   carries a tool call through the message that carries the result of the
//   run's last call, exactly, so a recorded `throughCallId` alone fixes the
//   run on every later request. An assistant message is culled only if every
//   call in it is covered, so the run stops before one that is not. The
//   turn's user message and its final reply are never culled. A run must
//   hold every call's result and every result's call, and must remove whole
//   array elements (Responses input items, Gemini `contents[i]`) made only
//   of tool calls, tool results, thinking or sealed reasoning, and the
//   model's text: it stops before a context item (a Codex compaction, a web
//   search), an item the parser skipped, and anything carrying cache_control.
// - Gemini positional call ids (`gemini:<content>:<part>`) are message
//   indexes, so none is ever recorded: a turn whose calls have only those is
//   not culled.
// - When: new culls at a user-turn start (any earlier turn), or mid-turn
//   when the current turn holds no thinking, sealed reasoning or signature
//   (then nothing in it is bound to the prefix). The latest assistant
//   message of the in-flight loop, and what follows it, is never culled.
// - Lines go in the turn's user message, never an assistant message (the
//   model would read them as its own words). A later cull of the same turn
//   records a new entry with the later call and the full line list, the
//   lines already frozen kept as they were.
// - Anthropic: culling changes the messages earlier thinking was signed
//   against, so a request that records a cull first records a
//   `thinkingCut` up to the latest turn (held writes commit in order), and
//   every request applies the cut in force.
// - Positions are turn ordinals and call ids, never message indexes.
// - The agent never waits: observations come from a cache a background
//   lookup fills (observation-lookup.ts); no observation, no cull.
// - A conversation the v1 swap stage changed is suspended: its swaps are
//   not put back, and it is never culled.
// - Any failure leaves the bytes as they came (the seam fails open, D7.7);
//   the relay's pairing check is the last guard.

import { logger } from '../../../utils/logger.js';
import { GEMINI_REQUEST_POSITIONAL_CALL_ID_PATTERN, contentSessionIdOf } from '../capture/capture-assembler.js';
import { startsUserTurn } from '../identity/turn-start.js';
import { userWordsInText } from '../identity/user-words.js';
import { ScannedObject } from '../ir/scanned-object.js';
import type { WireRequest } from '../ir/types.js';
import { applyByteSplices, type ByteSplice } from '../json/byte-splices.js';
import { arrayElements, objectMembers, rawText, scanDocument, type JsonSpan } from '../json/scanner.js';
import { appendArrayItemSplice, arrayItemRemovalSplices } from '../json/splice.js';
import type { WireConversationLedgerView, WireLedgerEntry } from '../ledger/conversation-ledger.js';
import { appendToStringSplice, tagWrappedBlock, textBlockJson } from '../memory/memory-injection-stage.js';
import { estimateTextTokens } from '../metrics/context-buckets.js';
import type { WireGatewayRoute } from '../routes.js';
import { DEFAULT_CONTEXT_TIMEOUT_MS } from '../memory/memory-injection-stage.js';
import { STAGE_BUDGET_MARGIN_MS, type WireRewriteContext, type WireRewriteStage } from '../rewrite/rewrite-stage.js';
import { thinkingCutInForce, thinkingCutSplices } from '../rewrite/thinking-drop.js';
import type { WireObservationLookup } from './observation-lookup.js';
import { toolUseIdsByCallIdOf } from './tool-use-ids.js';

export const ENDLESS_MODE_STAGE_NAME = 'endless-mode';

/**
 * Endless Mode's setting, read by the gateway at start (config.ts validates
 * it; changing it needs `claude-mem wire restart`). A route's
 * `features.endlessMode` is read live.
 */
export const ENDLESS_MODE_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE';

const WORK_TAG_NAME = 'claude-mem-work';

const SUSPENDED_ENTRY_ID = `suspended:${ENDLESS_MODE_STAGE_NAME}`;

type CullEntry = Extract<WireLedgerEntry, { type: 'cull' }>;

/** Whether Endless Mode is on for a route: its own `features.endlessMode`, else the setting (off by default, D9). */
export function endlessModeEnabledFor(route: WireGatewayRoute, settings: Readonly<Record<string, string>>): boolean {
  return route.features?.endlessMode ?? settings[ENDLESS_MODE_SETTING] === 'true';
}

/** The block a cull appends to its turn's user message: one timeline line per observation. */
export function culledWorkBlock(lines: readonly string[]): string {
  return tagWrappedBlock(WORK_TAG_NAME, lines.join('\n'));
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

/** A run of whole messages to cull, and the array elements that hold them. */
interface CullRun {
  turn: UserTurn;
  firstIndex: number;
  lastIndex: number;
  elements: JsonSpan[];
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

/**
 * The array a conversation's messages are elements of: Anthropic and Chat
 * `messages`, Responses `input`, Gemini `contents`. Null when there is none.
 */
function conversationArraySpanOf(request: WireRequest): JsonSpan | null {
  const root = new ScannedObject(request.body, scanDocument(request.body));
  const key = request.protocol === 'openai-responses' ? 'input' : request.protocol === 'gemini' ? 'contents' : 'messages';
  const span = root.spanOf(key);
  return span?.type === 'array' ? span : null;
}

/** Whether the JSON value at `span` holds a `cache_control` member anywhere in it. */
function holdsCacheControl(bytes: Uint8Array, span: JsonSpan): boolean {
  if (span.type === 'object') {
    for (const member of objectMembers(bytes, span)) {
      if (member.key === 'cache_control' || holdsCacheControl(bytes, member.value)) return true;
    }
  } else if (span.type === 'array') {
    for (const element of arrayElements(bytes, span)) if (holdsCacheControl(bytes, element)) return true;
  }
  return false;
}

/**
 * Whether message `messageIndex` is the harness's note about the run's own
 * work: a system-role message (Claude Code 2.1.310 sends
 * `{"role":"system","content":"<total_tokens>… tokens left</total_tokens>"}`
 * after every tool result; the Anthropic parser keeps it as a system message
 * with one text part) that sits strictly inside the run, after a tool result
 * and before the next assistant message that calls a tool, with only other
 * such notes between. Culling the work culls its chatter; a system message
 * anywhere else stops the run.
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

/** Why an array element of a run may not be removed; null when it may (only tool calls and results, reasoning, the model's text, the harness's notes about the work). */
function unremovableElementReason(request: WireRequest, element: JsonSpan, firstIndex: number, lastIndex: number): string | null {
  let partCount = 0;
  for (let messageIndex = firstIndex; messageIndex <= lastIndex; messageIndex++) {
    const message = request.messages[messageIndex];
    if (!spansOverlap(message.span, element)) continue;
    for (const part of message.parts) {
      if (!spansOverlap(part.span, element)) continue;
      partCount++;
      const removable = part.kind === 'tool_call' || part.kind === 'tool_result' || part.kind === 'thinking' || part.kind === 'sealed'
        || (part.kind === 'text' && message.role === 'assistant')
        || (part.kind === 'text' && isHarnessNoteInsideRun(request, messageIndex, firstIndex, lastIndex));
      if (!removable) return `it holds a ${part.kind === 'context' ? `${part.name ?? 'context'} item` : `${message.role} ${part.kind} part`}`;
    }
  }
  if (partCount === 0) return 'it is an element the parser skipped';
  if (holdsCacheControl(request.body, element)) return 'it carries cache_control';
  return null;
}

/**
 * The run of messages firstIndex..lastIndex, when it may be culled whole:
 * it ends on a message that is not the model's, holds every result of its
 * calls and the call of every result, and its array elements hold nothing
 * else (no message outside it, nothing but tool work, reasoning and the
 * model's text). Null otherwise.
 */
function cullRunOf(request: WireRequest, conversationElements: JsonSpan[], turn: UserTurn, firstIndex: number, lastIndex: number): CullRun | null {
  if (firstIndex <= turn.startIndex || lastIndex < firstIndex || lastIndex >= turn.endIndex) return null;
  if (request.messages[lastIndex].role === 'assistant') return null;
  const unpaired = new Map<string, number>();
  for (let messageIndex = firstIndex; messageIndex <= lastIndex; messageIndex++) {
    for (const part of request.messages[messageIndex].parts) {
      if (part.kind !== 'tool_call' && part.kind !== 'tool_result') continue;
      if (!part.callId) return null;
      unpaired.set(part.callId, (unpaired.get(part.callId) ?? 0) + (part.kind === 'tool_call' ? 1 : -1));
    }
  }
  if ([...unpaired.values()].some(count => count !== 0)) return null;

  const runSpan: JsonSpan = { start: request.messages[firstIndex].span.start, end: request.messages[lastIndex].span.end, type: 'object' };
  const elements = conversationElements.filter(element => spansOverlap(element, runSpan));
  if (elements.length === 0) return null;
  const removedSpan: JsonSpan = { start: elements[0].start, end: elements[elements.length - 1].end, type: 'array' };
  const before = request.messages[firstIndex - 1];
  const after = request.messages[lastIndex + 1];
  if (spansOverlap(before.span, removedSpan) || (after && spansOverlap(after.span, removedSpan))) return null;
  for (const element of elements) {
    const reason = unremovableElementReason(request, element, firstIndex, lastIndex);
    if (reason === null) continue;
    logger.debug('WIRE', `Endless Mode stopped a cull before an element: ${reason}`, { protocol: request.protocol, turnOrdinal: turn.ordinal });
    return null;
  }
  return { turn, firstIndex, lastIndex, elements };
}

/** The run a recorded cull removes: from the turn's first call through the message with the result of `throughCallId`; null when the history no longer has it whole. */
function recordedCullRunOf(request: WireRequest, conversationElements: JsonSpan[], turn: UserTurn, calls: TurnCall[], throughCallId: string, endLimit: number): CullRun | null {
  const through = calls.find(call => call.callId === throughCallId);
  if (!through) return null;
  const resultIndex = resultIndexOf(request, turn, throughCallId, through.messageIndex);
  if (resultIndex < 0 || resultIndex >= endLimit) return null;
  return cullRunOf(request, conversationElements, turn, calls[0].messageIndex, resultIndex);
}

/**
 * The longest run that may be culled now, with the call it runs through: it
 * ends exactly on the message with the result of its last call (so that
 * call alone fixes it on replay), holds no call after the boundary (the
 * latest call with an observation), and ends before `endLimit`. A Gemini
 * positional id is never the call it runs through. Null when there is none.
 */
function newCullRunOf(
  request: WireRequest,
  conversationElements: JsonSpan[],
  turn: UserTurn,
  calls: TurnCall[],
  boundaryCallOrder: number,
  endLimit: number,
): { run: CullRun; throughCallId: string } | null {
  const firstIndex = calls[0].messageIndex;
  // An assistant message with a call after the boundary is only partly covered: the run stops before it.
  const firstPartlyCoveredIndex = calls[boundaryCallOrder + 1]?.messageIndex ?? Number.POSITIVE_INFINITY;
  for (let throughOrder = boundaryCallOrder; throughOrder >= 0; throughOrder--) {
    const through = calls[throughOrder];
    if (GEMINI_REQUEST_POSITIONAL_CALL_ID_PATTERN.test(through.callId)) continue;
    const lastIndex = resultIndexOf(request, turn, through.callId, through.messageIndex);
    if (lastIndex < 0 || lastIndex >= endLimit || lastIndex >= firstPartlyCoveredIndex) continue;
    // The run's last call: a later call before this result (a parallel sibling) would be the one it runs through.
    if ((calls[throughOrder + 1]?.messageIndex ?? Number.POSITIVE_INFINITY) <= lastIndex) continue;
    const run = cullRunOf(request, conversationElements, turn, firstIndex, lastIndex);
    if (run) return { run, throughCallId: through.callId };
  }
  return null;
}

/**
 * The splice that appends `block` to the user message that starts a turn
 * (null when there is no content to append to, or it already ends with it):
 * to its content string after a blank line, or as a text block after its
 * last one (memory injection's append rules). On Responses and Gemini the
 * message may span several elements; the block goes into the last one that
 * holds the user's words (or, with none, the last that holds content).
 */
function appendToTurnStartSplice(request: WireRequest, conversationElements: JsonSpan[], turn: UserTurn, block: string): ByteSplice | null {
  const message = request.messages[turn.startIndex];
  const body = request.body;
  const contentKey = request.protocol === 'gemini' ? 'parts' : 'content';
  const holders = conversationElements
    .filter(element => spansOverlap(element, message.span))
    .map(element => ScannedObject.of(body, element))
    .filter((holder): holder is ScannedObject => holder !== undefined && holder.spanOf(contentKey) !== undefined
      && (request.protocol !== 'openai-responses' || holder.string('role') === 'user'));
  const wordsPart = [...message.parts].reverse().find(part => part.kind === 'text' && userWordsInText(part.text ?? '') !== '');
  const holder = (wordsPart && holders.find(candidate => spansOverlap(candidate.span, wordsPart.span))) ?? holders[holders.length - 1];
  if (!holder) return null;
  const contentSpan = holder.spanOf(contentKey)!;
  if (contentSpan.type === 'string') return appendToStringSplice(body, contentSpan, block);
  if (contentSpan.type === 'array') return appendArrayItemSplice(body, contentSpan, textBlockJson(request.protocol, block));
  return null;
}

/** What a run takes out, less what its lines put back, in estimated tokens. */
function culledTokensOf(request: WireRequest, run: CullRun, block: string): number {
  const removedTokens = run.elements.reduce((sum, element) => sum + estimateTextTokens(rawText(request.body, element)), 0);
  return Math.max(0, removedTokens - estimateTextTokens(block));
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
    // A conversation whose culls once went missing (the stage was off for one
    // of its requests) is never culled again: the model has answered the
    // original history since, so putting the culls back would rewrite it.
    appliesTo: context => context.ledger?.status === 'born' && context.ledger.get(SUSPENDED_ENTRY_ID) === undefined,

    whileOff(ledger) {
      if (ledger.status !== 'born' || ledger.get(SUSPENDED_ENTRY_ID)) return;
      if (!ledger.entries().some(entry => entry.type === 'cull')) return;
      suspend(ledger);
      logger.debug('WIRE', 'Endless Mode was off for a conversation it had culled; it never culls that conversation again', {
        conversationKey: ledger.conversationKey,
      });
    },

    async onRequest(context: WireRewriteContext, body: Uint8Array) {
      const ledger = context.ledger as WireConversationLedgerView;
      if (ledger.entries().some(entry => entry.type === 'swap' || entry.type === 'thinkingDrop')) {
        // Endless Mode v1 swapped this conversation; v2 does not put swaps back, so it leaves it alone for good.
        suspend(ledger);
        logger.debug('WIRE', 'Endless Mode suspended a conversation the v1 swap stage had changed', { conversationKey: ledger.conversationKey });
        return undefined;
      }
      const request = context.requestOf(body);
      const conversationArraySpan = conversationArraySpanOf(request);
      const turns = userTurnsOf(request);
      const latestTurn = turns[turns.length - 1];
      if (!conversationArraySpan || !latestTurn) return undefined;
      const conversationElements = [...arrayElements(body, conversationArraySpan)];
      const toolUseIdByCallId = toolUseIdsByCallIdOf(request);
      const observationOf = (callId: string) => {
        const toolUseId = toolUseIdByCallId.get(callId);
        return toolUseId === undefined ? undefined : options.observationLookup.cached(ledger.conversationKey, toolUseId);
      };

      // New culls: at a turn start, or mid-turn when nothing in the current turn is bound to the prefix.
      const currentTurnHoldsReasoning = turnHoldsReasoning(request, latestTurn);
      // (At a turn start the latest turn holds no tool work, so only earlier turns can be culled.)
      const mayCullNow = !currentTurnHoldsReasoning || context.identity.turnStart;
      // The in-flight loop's latest assistant message, and what follows it, is never culled.
      let latestAssistantIndex = request.messages.length;
      for (let messageIndex = request.messages.length - 1; messageIndex > latestTurn.startIndex; messageIndex--) {
        if (request.messages[messageIndex].role === 'assistant') {
          latestAssistantIndex = messageIndex;
          break;
        }
      }

      const recordedByTurn = new Map<number, CullEntry>();
      for (const entry of ledger.entries()) {
        if (entry.type === 'cull') recordedByTurn.set(entry.turnOrdinal, entry);
      }

      if (context.identity.turnStart) {
        // A turn start is the one moment a cull of earlier turns costs the cache nothing extra, so this request
        // waits (within CONTEXT_TIMEOUT_MS) for the observations of their work not culled yet, rather than
        // culling on the next request, mid-loop, and rewriting the cache twice. Mid-loop requests never wait.
        const toolUseIdsToAwait: string[] = [];
        for (const turn of turns) {
          if (turn === latestTurn) continue;
          const calls = callsOf(request, turn);
          const recorded = recordedByTurn.get(turn.ordinal);
          const recordedThroughOrder = recorded ? calls.findIndex(call => call.callId === recorded.throughCallId) : -1;
          for (const call of calls.slice(recordedThroughOrder + 1)) {
            const toolUseId = toolUseIdByCallId.get(call.callId);
            if (toolUseId !== undefined) toolUseIdsToAwait.push(toolUseId);
          }
        }
        if (toolUseIdsToAwait.length > 0) {
          const deadline = now() + contextTimeoutMs;
          const query = { contentSessionId: contentSessionIdOf(context.identity), platformSource: context.identity.agentId, toolUseIds: toolUseIdsToAwait };
          await settledWithin(options.observationLookup.requestRefresh(ledger.conversationKey, query), contextTimeoutMs);
          // A lookup already in flight (another request's) was joined above; ask again for what it did not cover.
          const remainingMs = deadline - now();
          if (remainingMs > 0) await settledWithin(options.observationLookup.requestRefresh(ledger.conversationKey, query), remainingMs);
        }
      }

      const runs: Array<{ run: CullRun; entry: CullEntry; appendSplice: ByteSplice }> = [];
      const newCulls: Array<{ run: CullRun; entry: CullEntry; appendSplice: ByteSplice }> = [];
      for (const turn of turns) {
        const calls = callsOf(request, turn);
        if (calls.length === 0) continue;
        const endLimit = turn === latestTurn ? latestAssistantIndex : turn.endIndex;
        const recorded = recordedByTurn.get(turn.ordinal);
        const recordedRun = recorded ? recordedCullRunOf(request, conversationElements, turn, calls, recorded.throughCallId, endLimit) : null;
        if (recorded && !recordedRun) {
          // The agent changed this turn's history (compaction, rewind): nothing of it is culled now, or built on.
          logger.debug('WIRE', 'Endless Mode left a turn as it came: its recorded cull no longer matches the history', {
            conversationKey: ledger.conversationKey, turnOrdinal: turn.ordinal,
          });
          continue;
        }
        if (recorded && recordedRun) {
          const appendSplice = appendToTurnStartSplice(request, conversationElements, turn, culledWorkBlock(recorded.lines));
          if (!appendSplice) {
            // Without its lines the cull cannot be put back as it was frozen; failing open on every request would
            // send the original history, so the conversation goes as it comes from now on.
            suspend(ledger);
            logger.warn('WIRE', 'Endless Mode suspended a conversation: a recorded cull\'s lines have no place in its turn\'s user message', {
              conversationKey: ledger.conversationKey, turnOrdinal: turn.ordinal,
            });
            return undefined;
          }
          runs.push({ run: recordedRun, entry: recorded, appendSplice });
        }
        if (!mayCullNow) continue;

        let boundaryCallOrder = -1;
        calls.forEach((call, order) => {
          if (observationOf(call.callId)) boundaryCallOrder = order;
        });
        const recordedThroughOrder = recorded ? calls.findIndex(call => call.callId === recorded.throughCallId) : -1;
        if (boundaryCallOrder <= recordedThroughOrder) continue;
        if (GEMINI_REQUEST_POSITIONAL_CALL_ID_PATTERN.test(calls[boundaryCallOrder].callId)) {
          // A position id is a message index: it would name another call once the history shifts.
          logger.debug('WIRE', 'Endless Mode left a turn as it came: its boundary call has only a position id', {
            conversationKey: ledger.conversationKey, turnOrdinal: turn.ordinal,
          });
          continue;
        }
        const found = newCullRunOf(request, conversationElements, turn, calls, boundaryCallOrder, endLimit);
        if (!found) continue;
        const { run, throughCallId } = found;
        if (calls.findIndex(call => call.callId === throughCallId) <= recordedThroughOrder) continue;
        const callsInRun = calls.filter(call => call.messageIndex <= run.lastIndex);

        // The lines already frozen stay as they were; observations new to this turn follow, in message order.
        const lines = [...(recorded?.lines ?? [])];
        const observationIds = [...(recorded?.observationIds ?? [])];
        for (const call of callsInRun) {
          const observation = observationOf(call.callId);
          if (!observation || observationIds.includes(observation.observationId)) continue;
          observationIds.push(observation.observationId);
          lines.push(observation.timelineLine);
        }
        // A cull needs a line; one that grows needs none of its own (the worker links a whole batch to its first observation).
        if (observationIds.length === 0) continue;
        const appendSplice = appendToTurnStartSplice(request, conversationElements, turn, culledWorkBlock(lines));
        if (!appendSplice) {
          logger.debug('WIRE', 'Endless Mode left a turn as it came: its user message has no content to append lines to', {
            conversationKey: ledger.conversationKey, turnOrdinal: turn.ordinal,
          });
          continue;
        }
        newCulls.push({
          run,
          appendSplice,
          entry: { type: 'cull', turnOrdinal: turn.ordinal, throughCallId, lines, observationIds, culledTokensEst: culledTokensOf(request, run, culledWorkBlock(lines)) },
        });
      }

      // Recorded before the culls that need it: held writes commit in order, with no rollback.
      let cutUntilTurnOrdinal = request.protocol === 'anthropic' ? thinkingCutInForce(ledger) : null;
      if (newCulls.length > 0 && request.protocol === 'anthropic' && (cutUntilTurnOrdinal === null || cutUntilTurnOrdinal < latestTurn.ordinal)) {
        ledger.record({ type: 'thinkingCut', untilTurnOrdinal: latestTurn.ordinal });
        cutUntilTurnOrdinal = latestTurn.ordinal;
      }
      for (const newCull of newCulls) {
        const recorded = ledger.record(newCull.entry);
        if (recorded.type !== 'cull') continue;
        if (recorded === newCull.entry) {
          // Tokens saved count each cull once: only what this entry takes out beyond the turn's earlier cull, never the replays.
          const earlierCulledTokensEst = recordedByTurn.get(newCull.run.turn.ordinal)?.culledTokensEst ?? 0;
          context.estimates.culledTokens += Math.max(0, recorded.culledTokensEst - earlierCulledTokensEst);
        }
        const index = runs.findIndex(applied => applied.run.turn === newCull.run.turn);
        // First write wins: an entry already there under this id keeps its own lines.
        const appendSplice = recorded === newCull.entry ? newCull.appendSplice : appendToTurnStartSplice(request, conversationElements, newCull.run.turn, culledWorkBlock(recorded.lines));
        if (!appendSplice) continue;
        const applied = { run: newCull.run, entry: recorded, appendSplice };
        if (index >= 0) runs[index] = applied;
        else runs.push(applied);
      }

      // Background lookups for the calls not culled yet; never waited for.
      const culledCallIds = new Set<string>();
      for (const { run } of runs) {
        for (let messageIndex = run.firstIndex; messageIndex <= run.lastIndex; messageIndex++) {
          for (const part of request.messages[messageIndex].parts) if (part.kind === 'tool_call' && part.callId) culledCallIds.add(part.callId);
        }
      }
      const toolUseIdsToLookUp = [...toolUseIdByCallId].filter(([callId]) => !culledCallIds.has(callId)).map(([, toolUseId]) => toolUseId);
      if (toolUseIdsToLookUp.length > 0) {
        void options.observationLookup.requestRefresh(ledger.conversationKey, {
          contentSessionId: contentSessionIdOf(context.identity),
          platformSource: context.identity.agentId,
          toolUseIds: toolUseIdsToLookUp,
        });
      }

      let rewritten = request.body;
      if (runs.length > 0) {
        const removedElementStarts = new Set(runs.flatMap(({ run }) => run.elements.map(element => element.start)));
        const splices = [
          ...arrayItemRemovalSplices(body, conversationArraySpan, element => removedElementStarts.has(element.start)),
          ...runs.map(({ appendSplice }) => appendSplice),
        ];
        rewritten = applyByteSplices(body, splices);
      }
      if (cutUntilTurnOrdinal !== null) {
        const cutSplices = thinkingCutSplices(rewritten === request.body ? request : context.requestOf(rewritten), cutUntilTurnOrdinal);
        if (cutSplices.length > 0) rewritten = applyByteSplices(rewritten, cutSplices);
      }
      return rewritten === request.body ? undefined : rewritten;
    },
  };
}
