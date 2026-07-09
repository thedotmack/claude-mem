import type { ConversationMessage } from '../worker-types.js';
import { SUMMARY_MODE_MARKER } from '../../sdk/prompts.js';
import { logger } from '../../utils/logger.js';

// Bounded observer history for the OpenAI-compatible providers.
//
// Those providers own `session.conversationHistory` and re-send the whole
// array on every query() call. Each observation turn appends a user message
// carrying the full tool payload (up to ~32k chars of <parameters> +
// <outcome>), so a session with N tool uses re-transmits every prior payload
// on every subsequent turn: O(N^2) input tokens on per-token billing, and the
// request eventually crosses the model's context window, which the error
// classifiers treat as unrecoverable.
//
// The raw payload is only needed for the single turn that converts it into
// <observation> blocks. After processAgentResponse() persists those blocks to
// SQLite, the payload is dead weight: the assistant messages already in the
// history ARE the compressed record of that work, and the Claude Code
// transcript remains the durable source of truth for replay. So once an
// exchange falls out of the recent window we replace the payload body with a
// small stub that preserves the message's role, position, tool name, and
// timestamp — chronology and role alternation stay intact, the observer keeps
// reading its own observations for continuity, and per-request input becomes
// bounded instead of growing without limit.

/** Marker attribute distinguishing a stub from a live payload message. */
const PRUNED_ATTRIBUTE = 'pruned="true"';

/** Payload messages open with this tag (see buildObservationPrompt). */
const OBSERVATION_OPEN_TAG = '<observed_from_primary_session>';

/**
 * Number of trailing messages never pruned (~4 user/assistant exchanges).
 * Keeps enough verbatim context for the observer to batch related tool uses
 * and dedupe against what it just recorded.
 */
export const KEEP_RECENT_MESSAGES = 8;

/**
 * Messages at or below this size are left alone — a stub would not be
 * meaningfully smaller than the original.
 */
export const MIN_PRUNABLE_CHARS = 600;

function extractTag(content: string, tag: string): string | null {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

function buildStub(content: string): string {
  const toolName = extractTag(content, 'what_happened') ?? 'unknown';
  const occurredAt = extractTag(content, 'occurred_at') ?? '';
  return `<observed_from_primary_session ${PRUNED_ATTRIBUTE}>
  <what_happened>${toolName}</what_happened>${occurredAt ? `\n  <occurred_at>${occurredAt}</occurred_at>` : ''}
  <note>Tool payload removed after it was recorded as observations. Do not re-describe this event.</note>
</observed_from_primary_session>`;
}

/**
 * Replace already-processed observation payloads outside the recent window
 * with compact stubs, in place. Returns the number of messages stubbed.
 *
 * Only user messages that carry a live observation payload are touched. The
 * first message (init/continuation prompt with the observer's role and output
 * format), summary-mode prompts, assistant messages, small messages, and the
 * trailing `keepRecent` messages are always preserved verbatim.
 */
export function pruneProcessedObservationPayloads(
  history: ConversationMessage[],
  keepRecent: number = KEEP_RECENT_MESSAGES,
  minPrunableChars: number = MIN_PRUNABLE_CHARS,
): number {
  const end = history.length - keepRecent;
  let pruned = 0;

  for (let i = 1; i < end; i++) {
    const message = history[i];
    if (message.role !== 'user') continue;
    if (message.content.length <= minPrunableChars) continue;
    if (!message.content.includes(OBSERVATION_OPEN_TAG)) continue;
    if (message.content.includes(SUMMARY_MODE_MARKER)) continue;

    message.content = buildStub(message.content);
    pruned++;
  }

  if (pruned > 0) {
    logger.debug('SDK', 'Pruned processed observation payloads from history', {
      prunedCount: pruned,
      historyLength: history.length,
    });
  }

  return pruned;
}
