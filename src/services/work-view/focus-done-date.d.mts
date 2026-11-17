/** When a focus area was marked done after one change to it: the day it moved into done, kept while it stays done. */
export function doneAtAfterChange(change: {
  /** Its status before the change (none for an area the change creates). */
  statusBefore: string | undefined;
  /** When it was marked done, before the change. */
  doneAtBefore: string | null;
  /** Its status after the change. */
  statusAfter: string | undefined;
  /** When the change was saved. */
  changedAt: string;
}): string | null;
