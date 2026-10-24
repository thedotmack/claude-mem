// SPDX-License-Identifier: Apache-2.0
//
// Where the user's turns start (plan Phase 4 task 7). Ported from magpie
// `turnIn` (internal/gateway/affinity.go:199-246, MIT, Copyright (c) 2026
// yetone).
//
// A turn begins with what the user said (even beside tool results), or an
// image or file of theirs. A tool result is within the current turn. A user
// message the agent wrote alone (a task notification, a todo nudge, an agent
// list, Codex's context) begins none: after an answer it carries the turn
// on, and right after the user's own message it leaves that as it was.

import type { WireMessage, WireRequest } from '../ir/types.js';
import { userWordsInMessage } from './user-words.js';

export interface UserTurnPosition {
  /** How many user turns the conversation holds so far (1 for the first). */
  userTurnOrdinal: number;
  /** The request hands the model tool results, or the agent's own notes, within the latest turn. */
  withinTurn: boolean;
}

/**
 * A user message that begins a turn: the user's own words, or (with no tool
 * result) an image or file of theirs. Words begin a turn even beside tool
 * results: after an interrupt, Codex sends the cut turn's tool outputs, its
 * <turn_aborted> note and the next prompt as one user message (seen live,
 * codex 0.163). Media beside a tool result is the tool's, not the user's.
 */
export function startsUserTurn(message: WireMessage): boolean {
  if (message.role !== 'user') return false;
  if (userWordsInMessage(message) !== '') return true;
  return !message.parts.some(part => part.kind === 'tool_result')
    && message.parts.some(part => part.kind === 'image' || part.kind === 'file');
}

export function userTurnPositionOfRequest(request: WireRequest): UserTurnPosition {
  let userTurnOrdinal = 0;
  let withinTurn = false;
  let answeredSinceLastUserMessage = false;
  for (const message of request.messages) {
    if (message.role === 'assistant') answeredSinceLastUserMessage = true;
    if (message.role !== 'user') continue;
    if (startsUserTurn(message)) {
      userTurnOrdinal++;
      withinTurn = false;
    } else if (message.parts.some(part => part.kind === 'tool_result')) {
      withinTurn = true;
    } else if (answeredSinceLastUserMessage) {
      withinTurn = userTurnOrdinal > 0;
    }
    answeredSinceLastUserMessage = false;
  }
  return { userTurnOrdinal, withinTurn };
}
