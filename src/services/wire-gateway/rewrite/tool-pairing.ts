// SPDX-License-Identifier: Apache-2.0
//
// The pairing check (plan Phase 10 task 4, D7.6): after the rewrite stages
// ran, every tool call must still have its result and every result its
// call. It only validates; it mends nothing. magpie mends unpaired history
// when it builds a body (anthropic.go:977-1070, chat.go:506-619,
// responses.go:606-758, codeassist.go:404-477; MIT, Copyright (c) 2026
// yetone); the gateway never builds one, so a rewrite that leaves a pair
// broken is simply not sent.
//
// History the agent sent is taken as it is: a call already unanswered in the
// original (the request a tool loop is waiting on, an interrupted turn)
// stays allowed. What a rewrite may not do is break a pair that was whole,
// or add an unpaired call or result.

import type { WireRequest } from '../ir/types.js';

export interface UnpairedToolParts {
  /** Ids of calls with no result after them, with how many such calls. */
  callsWithoutResult: Map<string, number>;
  /** Ids of results with no call before them, with how many such results. */
  resultsWithoutCall: Map<string, number>;
}

function increment(counts: Map<string, number>, id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

/**
 * The calls and results of a request that have no partner. A result pairs
 * with an earlier unanswered call of its id; a part without an id counts
 * under the empty id.
 */
export function unpairedToolPartsOf(request: WireRequest): UnpairedToolParts {
  const unansweredCallCounts = new Map<string, number>();
  const resultsWithoutCall = new Map<string, number>();
  for (const message of request.messages) {
    for (const part of message.parts) {
      const id = part.callId ?? '';
      if (part.kind === 'tool_call') {
        increment(unansweredCallCounts, id);
      } else if (part.kind === 'tool_result') {
        const unanswered = unansweredCallCounts.get(id) ?? 0;
        if (unanswered > 0) unansweredCallCounts.set(id, unanswered - 1);
        else increment(resultsWithoutCall, id);
      }
    }
  }
  const callsWithoutResult = new Map([...unansweredCallCounts].filter(([, count]) => count > 0));
  return { callsWithoutResult, resultsWithoutCall };
}

function countsWithin(rewritten: Map<string, number>, original: Map<string, number>): string | null {
  for (const [id, count] of rewritten) {
    if (count > (original.get(id) ?? 0)) return id;
  }
  return null;
}

/**
 * Null when the rewritten request breaks no pair the original kept;
 * otherwise what it broke.
 */
export function toolPairingProblem(original: WireRequest, rewritten: WireRequest): string | null {
  const before = unpairedToolPartsOf(original);
  const after = unpairedToolPartsOf(rewritten);
  const unansweredCallId = countsWithin(after.callsWithoutResult, before.callsWithoutResult);
  if (unansweredCallId !== null) return `tool call "${unansweredCallId}" lost its result`;
  const orphanResultId = countsWithin(after.resultsWithoutCall, before.resultsWithoutCall);
  if (orphanResultId !== null) return `tool result "${orphanResultId}" lost its call`;
  return null;
}
