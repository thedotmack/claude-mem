export const SHARED_REVIEW_VERSION: 2;
export const SHARED_REVIEW_KIND: 'review';
export function isSharedReviewKey(value: unknown): boolean;
export interface SharedReviewValue { version: 2; requestId: string; fingerprint: string; checked: boolean; checkedAtEpoch: number; }
export function isSharedReviewValue(kind: string, key: string, value: unknown, deleted?: boolean): boolean;
