// The owner-goals skill sorts what the owner asked for in their own prompts into
// focus areas and asks, saved to the "owner-goals" list (the current month) and
// past months to "owner-goals/<YYYY-MM-DD start>". Rules it finds go to the build
// story's preferences instead (My Rules suggestions). Mined focus areas are also
// suggested in the "my-focus" list. None of these are request cards or
// SessionStart work state.
export const OWNER_GOALS_LIST = 'owner-goals';

/** What one owner-goals item is: a part of the work you can ask for things inside of, or one finishable ask. */
export const GOAL_KINDS = ['focus-area', 'ask'];
// Rows saved before the three tests (2026-10-27) carry the old kinds. Past months are never saved again,
// so they are read as the kind each old one was closest to; the current list is sorted again on its next
// refresh (refresh-task asks the model to apply the three tests to every saved item).
const LEGACY_GOAL_KINDS = { priority: 'focus-area', 'open-ask': 'ask' };

export function isOwnerGoalsList(name) {
  return name === OWNER_GOALS_LIST || String(name ?? '').startsWith(`${OWNER_GOALS_LIST}/`);
}

/** An item's kind, and whether it was saved under an old kind. An unknown kind is refused: Goals never guesses. */
export function goalKindOf(fields) {
  const value = fields?.goal_kind;
  if (GOAL_KINDS.includes(value)) return { kind: value, legacy: false };
  if (Object.hasOwn(LEGACY_GOAL_KINDS, value)) return { kind: LEGACY_GOAL_KINDS[value], legacy: true };
  throw new Error(`Owner-goals item ${JSON.stringify(fields?.task ?? null)} has an unknown goal_kind: ${JSON.stringify(value ?? null)}`);
}
