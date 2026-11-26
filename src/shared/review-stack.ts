/** The wire contract used by the Work View deck, its worker and the hosted adapter. */
export const REVIEW_STACK_MODES = ['browse', 'work'] as const;
export type ReviewStackMode = typeof REVIEW_STACK_MODES[number];
export const REVIEW_STACK_MODE_LABELS: Record<ReviewStackMode, string> = { browse: 'Browse', work: 'Work' };

// Unreviewed → skip → seen, or unreviewed → seen. Undo returns the card to the queue.
// The review-stack event reducer is the only writer of a card's active review.
export const REVIEW_STACK_VERDICTS = ['seen', 'skip'] as const;
export type ReviewStackVerdict = typeof REVIEW_STACK_VERDICTS[number];
export const REVIEW_STACK_VERDICT_LABELS: Record<ReviewStackVerdict, string> = {
  seen: 'Seen', skip: 'Skipped',
};
export const REVIEW_STACK_ACTIONS = [
  ...REVIEW_STACK_VERDICTS, 'undo', 'bookmark', 'follow-up', 'set-follow-up', 'seen-group', 'undo-group',
] as const;

export const REVIEW_STACK_CARD_KIND = 'stack-card';
export const REVIEW_STACK_RECORD_KINDS = [
  REVIEW_STACK_CARD_KIND, 'stack-part', 'stack-event', 'stack-group-part', 'stack-receipt',
] as const;
export type ReviewStackRecordKind = typeof REVIEW_STACK_RECORD_KINDS[number];
const recordKinds = new Set<string>(REVIEW_STACK_RECORD_KINDS);
export const isReviewStackKind = (kind: string): kind is ReviewStackRecordKind => recordKinds.has(kind);

export const REVIEW_STACK_IMPORT_LIMIT = 12;
export const REVIEW_STACK_IMAGE_BYTES = 160 * 1024;
export const reviewStackFocusKey = (focus: string) => focus.normalize('NFKC').toLowerCase();
export const REVIEW_STACK_CARD_TOOL_SCHEMA = {
  type: 'object',
  required: ['key', 'focus', 'title', 'what', 'context'],
  properties: {
    key: { type: 'string', description: 'Stable original asset or variant identifier.' },
    focus: { type: 'string', description: 'Project or focus area.' },
    title: { type: 'string', description: 'A 3–5 word title.' },
    what: { type: 'string', description: 'A 10–15 word description of the original.' },
    context: { type: 'string', description: '10–15 words about where the work lives or what it was for.' },
    source: { type: 'string', description: 'Original HTTPS asset, document or conversation link.' },
    preview: { type: 'string', description: 'Durable HTTPS URL of the original image or its preview.' },
    imageData: { type: 'string', description: 'JPEG, PNG or WebP thumbnail data URL, up to 160 KiB decoded.' },
    excerpt: { type: 'string', description: 'An excerpt of the original work.' },
  },
  additionalProperties: false,
} as const;

export interface ReviewStackImportCard {
  key: string; focus: string; title: string; what: string; context: string;
  source?: string; preview?: string; imageData?: string; excerpt?: string;
}
export interface ReviewStackCard extends ReviewStackImportCard { id: string; createdAt: number }
export interface ReviewStackReview {
  id: string; cardId: string; action: ReviewStackVerdict; createdAt: number; groupId?: string;
}
export interface ReviewStackBookmark { cardId: string; saved: boolean; revision: number }
export interface ReviewStackFollowUp {
  id: string; cardId: string; body: string; createdAt: number; closedAt: number | null; revision: number;
}
export interface ReviewStackGroup { id: string; focus: string; createdAt: number; count: number; activeCount: number }
export interface ReviewStackSnapshot {
  revision: string; cards: ReviewStackCard[]; reviews: ReviewStackReview[]; bookmarks: ReviewStackBookmark[];
  followUps: ReviewStackFollowUp[]; groups: ReviewStackGroup[];
}
export interface ReviewStackPage extends ReviewStackSnapshot { nextCursor: string | null }
export type ReviewStackAction =
  | { action: ReviewStackVerdict; cardId: string; expectedReviewId: string | null }
  | { action: 'undo'; cardId: string; reviewId: string }
  | { action: 'bookmark'; cardId: string; saved: boolean; revision: number }
  | { action: 'follow-up'; cardId: string; body: string }
  | { action: 'set-follow-up'; cardId: string; followUpId: string; closed: boolean; revision: number }
  | { action: 'seen-group'; focus: string }
  | { action: 'undo-group'; groupId: string };
export interface ReviewStackImportResult { added: number; existing: number; firstId: string }
export interface ReviewStackActionResult { ok: true }
export type ReviewStackWriteResult = ReviewStackImportResult | ReviewStackActionResult;
