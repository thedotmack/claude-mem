// SPDX-License-Identifier: Apache-2.0
//
// Where the user's turns start (plan Phase 4 task 7). Ported from magpie
// `turnIn` (internal/gateway/affinity.go:199-246, MIT, Copyright (c) 2026
// yetone).
//
// A turn begins with what the user said, or an image or file of theirs. A
// tool result is within the current turn. A user message the agent wrote
// alone (a task notification, a todo nudge, an agent list, Codex's context)
// begins none: after an answer it carries the turn on, and right after the
// user's own message it leaves that as it was.

import type { WireRequest } from '../ir/types.js';
import { userWordsInMessage } from './user-words.js';

export interface UserTurnPosition {
  /** How many user turns the conversation holds so far (1 for the first). */
  userTurnOrdinal: number;
  /** The request hands the model tool results, or the agent's own notes, within the latest turn. */
  withinTurn: boolean;
}

export function userTurnPositionOfRequest(request: WireRequest): UserTurnPosition {
  let userTurnOrdinal = 0;
  let withinTurn = false;
  let answeredSinceLastUserMessage = false;
  for (const message of request.messages) {
    if (message.role === 'assistant') answeredSinceLastUserMessage = true;
    if (message.role !== 'user') continue;
    let saidSomething = userWordsInMessage(message) !== '';
    let carriesToolResult = false;
    for (const part of message.parts) {
      if (part.kind === 'image' || part.kind === 'file') saidSomething = true;
      if (part.kind === 'tool_result') carriesToolResult = true;
    }
    if (carriesToolResult) {
      withinTurn = true;
    } else if (saidSomething) {
      userTurnOrdinal++;
      withinTurn = false;
    } else if (answeredSinceLastUserMessage) {
      withinTurn = userTurnOrdinal > 0;
    }
    answeredSinceLastUserMessage = false;
  }
  return { userTurnOrdinal, withinTurn };
}
