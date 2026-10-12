/**
 * What a Gemini error body says about a refusal, read from its structured
 * `error.details` rather than by matching text anywhere in the body.
 *
 * Gemini answers a momentary throttle and a spent allowance identically — 429
 * with `RESOURCE_EXHAUSTED` — so the status and the marker cannot tell them
 * apart. The details can: a `google.rpc.QuotaFailure` names the window of each
 * violated quota (a spent day quota lists its per-minute window too, so the
 * period window is the one that decides), and a `google.rpc.RetryInfo` carries
 * the retry hint Google sends instead of a Retry-After header.
 *
 * Shared by the worker's GeminiProvider and the server runtime's
 * GeminiObservationProvider, which may not import from each other.
 */

export interface GeminiErrorDetails {
  /** A QuotaFailure violation names a window of a day or longer. */
  periodQuotaExhausted: boolean;
  /** RetryInfo.retryDelay in ms, when the body carries one. */
  retryDelayMs?: number;
}

/** quotaId names such as `GenerateRequestsPerDayPerProjectPerModel-FreeTier`. */
const PERIOD_QUOTA_ID = /per(day|week|month)/i;

/**
 * Parse a RetryInfo.retryDelay, a JSON-encoded protobuf Duration ("3s",
 * "1.5s"), into milliseconds. Undefined for a missing or malformed value.
 */
export function parseRetryDelayMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return undefined;
  return Math.round(Number(match[1]) * 1000);
}

function typeOf(detail: unknown): string {
  return detail && typeof detail === 'object' ? String((detail as { '@type'?: unknown })['@type'] ?? '') : '';
}

/**
 * Read the QuotaFailure and RetryInfo details from a Gemini error body. A body
 * that is not JSON, or carries no details, reports neither: the caller decides
 * what an unplaceable refusal means.
 */
export function parseGeminiErrorDetails(bodyText: string): GeminiErrorDetails {
  const result: GeminiErrorDetails = { periodQuotaExhausted: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return result;
  }
  const details = (parsed as { error?: { details?: unknown } } | null)?.error?.details;
  if (!Array.isArray(details)) return result;

  for (const detail of details) {
    const type = typeOf(detail);
    if (type.endsWith('google.rpc.QuotaFailure')) {
      const violations = (detail as { violations?: unknown }).violations;
      if (!Array.isArray(violations)) continue;
      for (const violation of violations) {
        const quotaId = (violation as { quotaId?: unknown } | null)?.quotaId;
        if (typeof quotaId === 'string' && PERIOD_QUOTA_ID.test(quotaId)) {
          result.periodQuotaExhausted = true;
        }
      }
    } else if (type.endsWith('google.rpc.RetryInfo')) {
      const retryDelay = (detail as { retryDelay?: unknown }).retryDelay;
      const ms = parseRetryDelayMs(typeof retryDelay === 'string' ? retryDelay : undefined);
      if (ms !== undefined) result.retryDelayMs = ms;
    }
  }
  return result;
}

/**
 * Google serves the Gemini API in some regions only; elsewhere every request
 * answers "User location is not supported" (a 400 FAILED_PRECONDITION, or a
 * 403). No retry helps, no other key helps, and the batch is not at fault.
 * The worker pauses on it the way it does on a refused key (buffered work
 * kept, one cooldown) and its key pool never rotates on it (api-key-pool.ts);
 * the server runtime fails the job without retrying. Both use this one
 * detector and these words, so the two never disagree.
 */
export const GEMINI_REGION_REFUSAL_CODE = 'location_unsupported';

export const GEMINI_REGION_REFUSAL_ACTION =
  'The Gemini API does not serve this region. Set CLAUDE_MEM_PROVIDER to another provider.';

export function isGeminiRegionRefusal(status: number | undefined, bodyText: string): boolean {
  return (status === 400 || status === 403) && bodyText.toLowerCase().includes('location is not supported');
}

export function geminiRegionRefusalMessage(status: number): string {
  return `Gemini is not available in this region (status ${status})`;
}
