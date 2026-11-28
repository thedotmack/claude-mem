/** What a request-progress review says a request is (progress-states.mjs, the one definition). */
export const PROGRESS_STATES: readonly ['shipped', 'in-progress', 'stalled', 'abandoned', 'unknown'];
export type ProgressState = (typeof PROGRESS_STATES)[number];
