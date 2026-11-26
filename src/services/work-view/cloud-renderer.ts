// Portable Work View server entry. All inputs belong to one previously authenticated account.
// The build includes only projection code and the canonical codecs, never a viewer worker.
export { foldCloudBatch, renderCloudWorkView, applyGroupDecisions } from './cloud-renderer-core.mjs';
export { createSharedEntry, createSharedBatch } from './shared-records.mjs';
export { focusAreaRowFields, placementRowFields, navWordIn } from './my-focus.mjs';
export { focusChangeVersion } from '../../shared/focus-change-version.js';
export { ruleRowFields } from './my-rules.mjs';
export { agentStopFields } from './agent-lifecycle.mjs';
export { groupIdFor, placeholderTitleFromAsk } from './request-groups.mjs';
export { sharedSuggestionDescriptor } from './shared-reviews.mjs';
export { isSharedProjectionValue } from './shared-projection.mjs';
export { isSharedReviewValue } from './shared-review-value.mjs';
