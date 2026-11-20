// Limits on one work_state_entries write, shared by the generic write route and the
// My Work writers that build rows themselves.
/** One write is a few short fields; anything bigger would crowd the SessionStart section. */
export const MAX_WORK_STATE_FIELDS_JSON_CHARS = 2_000;
