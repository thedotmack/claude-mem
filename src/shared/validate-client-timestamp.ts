/**
 * Validates a client-supplied original-event timestamp (transcript backfill
 * carries the real event time so replayed history doesn't collapse onto
 * "now"). Shared by every worker route/ingest path that accepts one, so the
 * rule lives in exactly one place.
 *
 * Accepts an ISO 8601 string or an epoch-ms number. Rejects anything that
 * doesn't parse, predates 2020-01-01 (older than claude-mem itself), or sits
 * more than 5 minutes in the future (clock skew allowance). Returns the
 * validated epoch ms, or null — callers fall back to Date.now() on null,
 * which is exactly what happens today when no timestamp is supplied at all.
 */

const MIN_EPOCH_MS = Date.parse('2020-01-01T00:00:00Z');
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function validateClientTimestamp(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;

  let epoch: number;
  if (typeof value === 'number') {
    epoch = value;
  } else if (typeof value === 'string') {
    epoch = Date.parse(value);
  } else {
    return null;
  }

  if (!Number.isFinite(epoch)) return null;
  if (epoch < MIN_EPOCH_MS) return null;
  if (epoch > Date.now() + MAX_FUTURE_SKEW_MS) return null;
  return epoch;
}
