// What a request-progress review says a request is. This is the one definition: the review check
// (request-groups.mjs validateProgress), the shared record check (shared-projection.mjs) and My Work's wire type
// (work-view-api-types.ts WorkViewProgress) all take it from here. No imports, so every bundle can load it.
// Its one writer is the reviewer, through `record-progress`; a review is never moved from one state to another, only
// replaced by the next review.
export const PROGRESS_STATES = ['shipped', 'in-progress', 'stalled', 'abandoned', 'unknown'];
