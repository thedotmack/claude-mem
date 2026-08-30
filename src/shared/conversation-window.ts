/**
 * Bounded observer conversation window (#3800).
 *
 * The observer keeps ONE long-lived conversation per Claude session and appends
 * to it on every captured tool call. Nothing trimmed it. Providers that send the
 * transcript themselves (`OpenAICompatibleProvider.query(session.conversationHistory)`)
 * therefore re-sent the entire accumulated history on every single observation:
 *
 *   observation 1 → send [init, reply, obs1]
 *   observation 2 → send [init, reply, obs1, reply1, obs2]
 *   observation N → send O(N) messages
 *
 * Total input tokens over a session are O(N²). A single observation prompt is
 * field-truncated to ~32k chars (`OBS_PROMPT_FIELD_MAX_CHARS`, sdk/prompts.ts),
 * so ~25-30 observations is enough to cross a 200k-token ceiling. Past that the
 * provider answers "Prompt is too long" forever and every subsequent tool call
 * pays full freight for a request that cannot succeed.
 *
 * This module caps the window so per-observation cost stays flat instead of
 * growing with session length. The first message is pinned because it carries
 * the observer's framing (project, session id, mode); the newest messages are
 * kept because they are the ones with continuity value. Everything in between
 * is dropped oldest-first, and the drop is announced to the model so it does not
 * treat the gap as a fact about the session.
 */

import type { ConversationMessage } from '../services/worker-types.js';

/**
 * Character budget for the whole window. ~4 chars/token puts 260k chars near
 * 65k tokens — comfortably inside every supported model's context window while
 * still leaving room for the largest single observation prompt (~32k chars) and
 * the model's reply.
 */
export const DEFAULT_HISTORY_MAX_CHARS = 260_000;

/**
 * Hard ceiling on message count, independent of size. Protects against a long
 * tail of small messages that never trips the character budget but still costs
 * per-message overhead on every request.
 */
export const DEFAULT_HISTORY_MAX_MESSAGES = 60;

/** Messages always kept at the head of the window (the framing prompt). */
const PINNED_HEAD_MESSAGES = 1;

/**
 * Room reserved for the `<elided .../>` marker so the compacted window honours
 * `maxChars` *including* the marker. Comfortably above the marker's real length;
 * the only cost of over-reserving is a few hundred spare characters.
 */
const MARKER_RESERVE_CHARS = 512;

export interface CompactionResult {
  /** The compacted window. Same array identity is never returned; callers assign. */
  history: ConversationMessage[];
  /** How many messages were dropped. 0 means the window was already within budget. */
  dropped: number;
  /** Total characters dropped — the per-request saving this compaction bought. */
  droppedChars: number;
}

function totalChars(history: ConversationMessage[]): number {
  let sum = 0;
  for (const message of history) {
    sum += message.content.length;
  }
  return sum;
}

/**
 * Trim `history` to fit `maxChars`/`maxMessages`, dropping oldest-first from the
 * middle while pinning the framing message at the head.
 *
 * Returns the original array untouched when it already fits, so the common path
 * allocates nothing.
 */
export function compactConversationHistory(
  history: ConversationMessage[],
  options: { maxChars?: number; maxMessages?: number } = {}
): CompactionResult {
  const maxChars = options.maxChars ?? DEFAULT_HISTORY_MAX_CHARS;
  const maxMessages = options.maxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES;

  const startingChars = totalChars(history);
  if (history.length <= maxMessages && startingChars <= maxChars) {
    return { history, dropped: 0, droppedChars: 0 };
  }

  // Never drop the pinned head, and never drop the newest message — that is the
  // observation currently being asked about.
  const head = history.slice(0, PINNED_HEAD_MESSAGES);
  const tail = history.slice(PINNED_HEAD_MESSAGES);

  const headChars = totalChars(head);
  const kept: ConversationMessage[] = [];
  let keptChars = 0;

  // Reaching here means at least one message is being dropped, so the elision
  // marker will be inserted. Charge its worst-case size to the budget now —
  // otherwise the returned window exceeds maxChars by the marker's length.
  const availableChars = maxChars - headChars - MARKER_RESERVE_CHARS;

  // Walk newest → oldest, keeping what fits.
  for (let i = tail.length - 1; i >= 0; i--) {
    const message = tail[i];
    const withinMessageBudget = kept.length + head.length + 1 <= maxMessages;
    const withinCharBudget = keptChars + message.content.length <= availableChars;

    // Always keep the newest message even if it alone blows the budget: dropping
    // the live observation would send a prompt with no question in it.
    if (kept.length === 0 || (withinMessageBudget && withinCharBudget)) {
      kept.push(message);
      keptChars += message.content.length;
      continue;
    }
    break;
  }

  kept.reverse();

  const dropped = history.length - head.length - kept.length;
  if (dropped <= 0) {
    return { history, dropped: 0, droppedChars: 0 };
  }

  const droppedChars = startingChars - headChars - keptChars;

  // Tell the model the window was trimmed, mirroring how sdk/prompts.ts marks a
  // truncated field, so it reports only what it can see.
  const marker: ConversationMessage = {
    role: 'user',
    content:
      `<elided messages="${dropped}" chars="${droppedChars}" />\n` +
      'Earlier turns in this session were dropped to keep the observer prompt within ' +
      'the model context window. Observe only the tool call below; do not infer ' +
      'anything about the elided range.',
  };
  return {
    history: [...head, marker, ...kept],
    dropped,
    droppedChars,
  };
}
