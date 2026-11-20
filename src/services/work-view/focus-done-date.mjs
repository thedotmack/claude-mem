// When a focus area was marked done: the one rule, shared by the worker's reducer (my-focus.mjs buildFocusAreas) and
// My Work's sample, which stands in for the worker (src/ui/my-work/src/live/sample-source.ts). No imports, so the
// browser bundle can load it.
//
// The change that moves an area into done dates it. Every owner row repeats the whole area, so a later rename or goal
// edit of a done area keeps that day; leaving done clears it, and marking it done again starts anew.
export function doneAtAfterChange({ statusBefore, doneAtBefore, statusAfter, changedAt }) {
  if (statusAfter !== 'done') return null;
  return statusBefore === 'done' ? doneAtBefore : changedAt;
}
