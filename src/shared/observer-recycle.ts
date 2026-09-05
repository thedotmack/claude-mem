/**
 * Observer conversation generations (#3800).
 *
 * The observer keeps one long-lived conversation per session and appends every
 * captured tool call to it. Nothing bounded it, so a busy session grew that
 * conversation until the provider refused it with "Prompt is too long" — and
 * because the refusal was never classified, every later tool call re-sent an
 * over-ceiling prompt that could not succeed.
 *
 * The fix is NOT to trim the transcript. claude-mem already has a compressed
 * representation of a session: the observations it has been writing all along.
 * So the conversation runs in bounded *generations* — when one approaches the
 * ceiling it is retired and a fresh one starts, seeded with the session's own
 * observations (see buildSessionSoFar in sdk/prompts.ts). Continuity is carried
 * by the memory the product exists to produce, not by raw turns.
 *
 * This module owns only the "is this generation full?" decision.
 */

import type { ConversationMessage } from '../services/worker-types.js';

/**
 * Character budget for one observer generation.
 *
 * ~4 chars/token puts 400k chars near 100k tokens — half of a 200k window, so a
 * generation retires with room to spare rather than discovering the ceiling by
 * being refused at it. Narrower-window models are covered by the reactive
 * overflow path, which recycles on the provider's actual refusal.
 */
export const OBSERVER_CONVERSATION_MAX_CHARS = 400_000;

/** Total characters currently held in a session's conversation. */
export function conversationChars(history: ConversationMessage[]): number {
  let sum = 0;
  for (const message of history) {
    sum += message.content.length;
  }
  return sum;
}

/**
 * True when this generation has used its budget and should be retired before
 * the next observation is sent.
 *
 * Checked BEFORE sending, so the request that would have crossed the ceiling is
 * never paid for.
 */
export function shouldRecycleConversation(
  history: ConversationMessage[],
  maxChars: number = OBSERVER_CONVERSATION_MAX_CHARS,
): boolean {
  return conversationChars(history) >= maxChars;
}

/**
 * Resolve the budget from settings, falling back to the default when unset or
 * malformed. #3800 noted operators had no knob for this among the 102 settings.
 */
export function resolveConversationMaxChars(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return OBSERVER_CONVERSATION_MAX_CHARS;
  }
  return parsed;
}
