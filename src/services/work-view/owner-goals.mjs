// The owner-goals skill saves the owner's top priorities and open asks to the
// "owner-goals" list (the current month) and past months to
// "owner-goals/<YYYY-MM-DD start>". My Work shows them as Goals; they are never
// request cards or SessionStart work state.
export const OWNER_GOALS_LIST = 'owner-goals';

export function isOwnerGoalsList(name) {
  return name === OWNER_GOALS_LIST || String(name ?? '').startsWith(`${OWNER_GOALS_LIST}/`);
}
