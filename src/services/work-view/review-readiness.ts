import { normalizeRequestStatus } from '../../ui/my-work/src/live/status-normalization.js';

// A request is ready for a human check once its explicit lifecycle reports it complete, shipped, or waiting for review.
// Statuses are compared lowercased with `_` and spaces read as `-`, matching the viewer's status normalization.
const READY_FOR_CHECK_LIFECYCLE_STATUSES = [
  'done', 'completed', 'complete', 'shipped', 'delivered',
  'needs-review', 'review', 'in-review', 'awaiting-review', 'ready-for-review',
];
type RecordedLifecycle = { explicit?: boolean; complete?: boolean | null; status?: string | null; atEpoch?: number | null } | null | undefined;
type ReadyCheckItem = { kind: string; status: string; judgedStatus?: string | null; lastUpdateEpoch?: number };

/** Mirrors the viewer's reviewIsNewerThanLifecycle (src/ui/my-work/src/live/to-work-model.ts). */
function reviewIsNewerThanLifecycle(review: { checkedAt?: string | null }, lifecycle: RecordedLifecycle): boolean {
  if (!lifecycle?.explicit || !lifecycle.atEpoch) return true;
  const reviewedAt = Date.parse(review.checkedAt ?? '');
  return Number.isFinite(reviewedAt) && reviewedAt >= lifecycle.atEpoch;
}

/** Ready for a person's check: the explicit lifecycle says so, or a memory review newer than it reached 100%.
 * The viewer offers "Mark checked" on exactly these requests. */
export function isReportedReadyForCheck(request: { lifecycle?: RecordedLifecycle; progress?: { percent?: number; checkedAt?: string | null } | null; items?: ReadyCheckItem[] }, now = Date.now()): boolean {
  const { lifecycle, progress } = request;
  if (progress?.percent === 100 && reviewIsNewerThanLifecycle(progress, lifecycle)) return true;
  // Item statuses, Jev's judged ones included, read with the viewer's own rule: an item an agent marked needs-review,
  // or one a confident label judged finished, makes the viewer offer "Mark checked", so the check is accepted.
  if (request.items?.length) {
    const itemStatus = normalizeRequestStatus({ items: request.items, checked: false,
      lifecycle: lifecycle?.explicit ? { status: lifecycle.status ?? null, explicit: true, complete: lifecycle.complete } : null }, now);
    if (itemStatus === 'needs-review' || itemStatus === 'done') return true;
  }
  if (!lifecycle?.explicit) return false;
  const status = String(lifecycle.status ?? '').trim().toLowerCase().replace(/[_ ]/g, '-');
  return lifecycle.complete === true || READY_FOR_CHECK_LIFECYCLE_STATUSES.includes(status);
}
