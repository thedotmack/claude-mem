// SPDX-License-Identifier: Apache-2.0
//
// Anthropic thinking removal, for the stages that change what an earlier
// thinking block was signed against (the durable header's system prompt,
// Endless Mode's culls). A thinking block stays valid only while the system
// prompt, the tools and the messages before it are unchanged; a change
// invalidates it, so the stage that makes the change records a cut and
// every later request takes those blocks out again, byte for byte, as
// Claude Code's own retry drops them (report 07 §2.2–2.3).
//
// `thinkingCut {untilTurnOrdinal}`: every thinking block before the user
// message that starts that turn, oldest first with no gap, never in the
// in-flight loop. An assistant message left with nothing goes whole;
// Anthropic merges the user messages on either side of it. (Endless Mode
// v1's `thinkingDrop` entries are only parsed, never applied: a conversation
// that holds one is suspended for the cull stage.)

import { latestUserTurnStartIndex, startsUserTurn } from '../identity/turn-start.js';
import { ScannedObject } from '../ir/scanned-object.js';
import type { WireRequest } from '../ir/types.js';
import type { ByteSplice } from '../json/byte-splices.js';
import { scanDocument } from '../json/scanner.js';
import { arrayItemRemovalSplices } from '../json/splice.js';
import type { WireConversationLedgerView } from '../ledger/conversation-ledger.js';

const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

/** The splices that drop an assistant message's thinking blocks; null when the message would be left empty. */
function thinkingDropSplicesOfMessage(request: WireRequest, messageIndex: number): ByteSplice[] | null {
  const message = ScannedObject.of(request.body, request.messages[messageIndex].span);
  const contentSpan = message?.spanOf('content');
  if (contentSpan?.type !== 'array') return [];
  let kept = 0;
  const splices = arrayItemRemovalSplices(request.body, contentSpan, elementSpan => {
    const isThinking = THINKING_BLOCK_TYPES.has(ScannedObject.of(request.body, elementSpan)?.string('type') ?? '');
    if (!isThinking) kept++;
    return isThinking;
  });
  return splices.length > 0 && kept === 0 ? null : splices;
}

/** The turn the ledger's thinking cut reaches (the largest `untilTurnOrdinal`); null when there is none. */
export function thinkingCutInForce(ledger: WireConversationLedgerView): number | null {
  let untilTurnOrdinal: number | null = null;
  for (const entry of ledger.entries()) {
    if (entry.type === 'thinkingCut' && (untilTurnOrdinal === null || entry.untilTurnOrdinal > untilTurnOrdinal)) untilTurnOrdinal = entry.untilTurnOrdinal;
  }
  return untilTurnOrdinal;
}

/**
 * The index of the user message that starts turn `untilTurnOrdinal`, clamped
 * to the request's latest turn start: a history the agent shortened
 * (compaction, rewind) never loses the in-flight loop's thinking.
 */
function thinkingCutEndIndex(request: WireRequest, untilTurnOrdinal: number): number {
  const latestTurnStart = latestUserTurnStartIndex(request);
  let turnOrdinal = 0;
  for (let messageIndex = 0; messageIndex < latestTurnStart; messageIndex++) {
    if (startsUserTurn(request.messages[messageIndex]) && ++turnOrdinal === untilTurnOrdinal) return messageIndex;
  }
  return Math.max(0, latestTurnStart);
}

/**
 * The splices that apply a thinking cut to an Anthropic request: every
 * thinking and redacted_thinking block in the assistant messages before the
 * turn's user message removed, and an assistant message that holds nothing
 * else removed whole. Never fails: a request with nothing to cut gets [].
 */
export function thinkingCutSplices(request: WireRequest, untilTurnOrdinal: number): ByteSplice[] {
  const endIndex = thinkingCutEndIndex(request, untilTurnOrdinal);
  const splices: ByteSplice[] = [];
  const wholeMessageStarts = new Set<number>();
  for (let messageIndex = 0; messageIndex < endIndex; messageIndex++) {
    if (request.messages[messageIndex].role !== 'assistant') continue;
    const messageSplices = thinkingDropSplicesOfMessage(request, messageIndex);
    if (messageSplices === null) wholeMessageStarts.add(request.messages[messageIndex].span.start);
    else splices.push(...messageSplices);
  }
  if (wholeMessageStarts.size > 0) {
    const messagesSpan = new ScannedObject(request.body, scanDocument(request.body)).spanOf('messages');
    if (messagesSpan?.type !== 'array') throw new Error('an Anthropic request with no messages array');
    splices.push(...arrayItemRemovalSplices(request.body, messagesSpan, elementSpan => wholeMessageStarts.has(elementSpan.start)));
  }
  return splices;
}
