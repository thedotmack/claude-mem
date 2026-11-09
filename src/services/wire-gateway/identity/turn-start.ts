// SPDX-License-Identifier: Apache-2.0
//
// Where the user's turns start (plan Phase 4 task 7). Ported from magpie
// `turnIn` (internal/gateway/affinity.go:199-246, MIT, Copyright (c) 2026
// yetone).
//
// A turn begins with what the user said, or an image or file of theirs. A
// message that carries a tool result (Anthropic tool_result, Chat role:tool,
// Responses function_call_output, Gemini functionResponse) never begins one,
// whatever text sits beside the result: Claude Code puts its own text there
// ("Tool loaded." after ToolSearch, a skill's base directory, an image note),
// and a turn starting at a result would split the call from it. A user
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
 * A user message that begins a turn: the user's own words, or an image or
 * file of theirs, in a message that carries no tool result. Text or media
 * beside a tool result is the harness's or the tool's (Claude Code's
 * "Tool loaded.", a skill's base directory, an image note), never a new turn.
 * (After an interrupt, Codex sends the cut turn's outputs and then the next
 * prompt as its own message item; the Responses parser keeps that item a
 * message of its own, so the prompt still begins a turn.)
 */
export function startsUserTurn(message: WireMessage): boolean {
  if (message.role !== 'user') return false;
  if (message.parts.some(part => part.kind === 'tool_result')) return false;
  if (userWordsInMessage(message) !== '') return true;
  return message.parts.some(part => part.kind === 'image' || part.kind === 'file');
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

/** The index of the latest message that begins a user turn; -1 when none does. */
export function latestUserTurnStartIndex(request: WireRequest): number {
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex--) {
    if (startsUserTurn(request.messages[messageIndex])) return messageIndex;
  }
  return -1;
}
