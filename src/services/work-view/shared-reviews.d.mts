import type { Database } from 'bun:sqlite';
import type { SharedRecordState } from './shared-record-store.mjs';
export { SHARED_REVIEW_KIND, SHARED_REVIEW_VERSION, isSharedReviewValue } from './shared-review-value.mjs';
export interface SharedReviewDescriptor { version: 2; requestId: string; fingerprint: string; complete: boolean; missingEvidence: string[]; }
export interface SharedReviewState { checked: boolean; checkedAtEpoch: number | null; actor: 'shared-user' | null; available: boolean; mode: 'shared'; conflict: boolean; matches: boolean; /** Complete observed-head token for expectedReviewHash. */ hash: string | null; recordHash: string | null; version: 2; writer: string | null; message?: string; }
export function sharedReviewRequestId(request: Record<string, any>, originalRef?: unknown): string;
export function sharedReviewDescriptor(database: Database, request: Record<string, any>, options: { deviceId: string; sharedState?: SharedRecordState | null; evidenceRows?: Map<string, unknown> }): SharedReviewDescriptor;
export function readSharedReview(sharedState: SharedRecordState | null, descriptor: SharedReviewDescriptor): SharedReviewState;
export function publishSharedReview(database: Database, options: { deviceId: string; project: string; descriptor: SharedReviewDescriptor; checked: boolean; expectedHash: string | null; now?: number }): { changed: number; rowIds: number[]; batchId: string | null };
export function getSharedReviews(database: Database, deviceId: string, options?: { includeHistory?: boolean }): SharedRecordState;
export function sharedSuggestionDescriptor(sharedState: SharedRecordState | null, conversationKey: string): { hash: string | null; conflict: boolean; groupKeys: string[]; targetId?: string; suggestion?: Record<string, any> };
export function sharedConflictSuggestions(sharedState: SharedRecordState | null): Array<Record<string, any>>;
