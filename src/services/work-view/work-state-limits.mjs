// Limits on one work_state_entries write, shared by the generic write route and the
// My Work writers that build rows themselves.
/** One write is a few short fields; anything bigger would crowd the SessionStart section. */
export const MAX_WORK_STATE_FIELDS_JSON_CHARS = 2_000;
/** A focus area's notes are the owner's free text, saved in a row of their own (my-focus.mjs focusNotesRowFields), so they
 * do not share the one-write limit above. No Node imports: My Work loads this file. */
export const MAX_FOCUS_NOTES_CHARS = 2_000;
