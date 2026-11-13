// What an agent's finished turn waits for from the person: an answer (it asked something it needs to go on), a review
// (it finished work the person should look at), an approval (it wants a go-ahead for one action), or nothing (the turn
// is complete and nothing is owed). The turn-end session summary records it: src/sdk/prompts.ts asks, src/sdk/parser.ts
// reads, session_summaries.waiting_for stores, and My Work words it on the request card. No Node imports: My Work
// loads this file.
export const WAITING_FOR = ['answer', 'review', 'approval', 'nothing'];

/** The value a summary's `<waiting_for>` text names, or null: an unknown word is never guessed at. */
export function parseWaitingFor(text) {
  const word = typeof text === 'string' ? text.trim().toLowerCase() : '';
  return WAITING_FOR.includes(word) ? word : null;
}
