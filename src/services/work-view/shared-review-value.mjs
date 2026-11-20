// A shared review acknowledges one exact semantic version, never completion.
export const SHARED_REVIEW_VERSION = 2;
export const SHARED_REVIEW_KIND = 'review';
export const isSharedReviewKey = value => typeof value === 'string' && /^sr2_[a-f0-9]{64}$/.test(value);

export function isSharedReviewValue(kind, key, value, deleted = false) {
  if (kind !== SHARED_REVIEW_KIND || !isSharedReviewKey(key)) return false;
  if (deleted) return true;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 5
    && value.version === SHARED_REVIEW_VERSION && value.requestId === key
    && /^[a-f0-9]{64}$/.test(value.fingerprint ?? '')
    && typeof value.checked === 'boolean'
    && Number.isSafeInteger(value.checkedAtEpoch) && value.checkedAtEpoch >= 0
    && Number.isFinite(new Date(value.checkedAtEpoch).getTime()));
}
