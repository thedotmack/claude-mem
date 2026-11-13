// What a person can owe a request, and what an agent's finished turn waits for: an answer (the agent asked something it
// needs to go on), a review (it finished work the person should look at), an approval (it wants a go-ahead for one
// action), or nothing (the turn is complete and nothing is owed). The turn-end session summary records the second
// (src/sdk/prompts.ts asks, src/sdk/parser.ts reads, session_summaries.waiting_for stores); My Work files a request
// under it. No Node imports: My Work loads this file.
export const HUMAN_NEEDS = ['answer', 'review', 'approval'];
export const WAITING_FOR = [...HUMAN_NEEDS, 'nothing'];

/** The value a summary's `<waiting_for>` text names, or null: an unknown word is never guessed at. */
export function parseWaitingFor(text) {
  const word = typeof text === 'string' ? text.trim().toLowerCase() : '';
  return WAITING_FOR.includes(word) ? word : null;
}

// With no recorded prompt time, a summary counts only if it was stored as the turn ended; this covers two clocks
// rounding apart.
const SUMMARY_BEFORE_TURN_END_MS = 5000;

/**
 * What the turn that ended at `turnEndedAtEpoch` waits for, from the conversation's latest summary. The owner's last
 * prompt is the boundary: a summary written since then still speaks for the chat when the agent was woken and ended
 * its turn again without a new one (a background task reporting back), and one written before it says nothing about
 * this turn. Only when no prompt time is recorded does the turn's own end decide.
 */
export function waitingForTurn({ turnEndedAtEpoch, lastOwnerPromptEpoch, summary }) {
  const waitingFor = parseWaitingFor(summary?.waitingFor);
  const writtenAt = summary?.createdAtEpoch;
  if (!waitingFor || !Number.isFinite(writtenAt) || !Number.isFinite(turnEndedAtEpoch)) return null;
  const since = Number.isFinite(lastOwnerPromptEpoch) ? lastOwnerPromptEpoch : turnEndedAtEpoch - SUMMARY_BEFORE_TURN_END_MS;
  return writtenAt >= since ? waitingFor : null;
}
