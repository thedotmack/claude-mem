// Portable Work View server entry. All inputs belong to one previously authenticated account.
// The build includes only projection code and the canonical codecs, never a viewer worker.
export { foldCloudBatch, renderCloudWorkView, applyGroupDecisions } from './cloud-renderer-core.mjs';
export { createSharedEntry, createSharedBatch } from './shared-records.mjs';
export { focusAreaRowFields, placementRowFields, subFocusRowFields, subFocusPlacementRowFields, navWordIn } from './my-focus.mjs';
export { focusChangeVersion } from '../../shared/focus-change-version.js';
export { ruleRowFields } from './my-rules.mjs';
export { agentStopFields } from './agent-lifecycle.mjs';
export { groupIdFor, placeholderTitleFromAsk } from './request-groups.mjs';
export { sharedSuggestionDescriptor } from './shared-reviews.mjs';
export { isSharedProjectionValue } from './shared-projection.mjs';
export { isSharedReviewValue } from './shared-review-value.mjs';
export {
  renderReviewStack, reviewStackPage, reviewStackImage, reviewStackWinners, prepareReviewStackWrite,
  ReviewStackError, isReviewStackKind, REVIEW_STACK_CARD_KIND, REVIEW_STACK_CARD_TOOL_SCHEMA,
  REVIEW_STACK_IMPORT_LIMIT,
} from './review-stack.js';

import type { FocusAreaDecidedBy, PlacementPlacedBy, SubFocusDecidedBy } from './my-focus.mjs';
import type * as CloudTypes from '../../../integrations/cloud-work-view/types/index.d.mts';
/** The package's hand-kept types (integrations/cloud-work-view/types, shipped as this bundle's types without src) restate
 * the my-focus writers. A type only, so the bundle is unchanged: it fails the root typecheck when the two drift apart. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Agrees<Check extends true> = Check;
type CloudFocusWritersAgree = Agrees<Same<CloudTypes.FocusAreaDecidedBy, FocusAreaDecidedBy>>
  | Agrees<Same<CloudTypes.SubFocusDecidedBy, SubFocusDecidedBy>> | Agrees<Same<CloudTypes.PlacementPlacedBy, PlacementPlacedBy>>;
