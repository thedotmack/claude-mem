/**
 * Bounded, ID-only correlation for worker → cmem gateway chat requests.
 *
 * Sent only to the cmem.ai gateway as the `X-Cmem-Correlation` header so the
 * server can tie a metered inference attempt to the worker's logical request,
 * its retry attempt and the media source events it carried (Phase 6 item 4).
 * The value holds a random request UUID, a positive attempt counter and at
 * most four SHA-256 hex event keys. It never holds model text, labels,
 * prompts, paths, URLs, session IDs or keys. The gateway validates it and may
 * ignore it; it is advisory and never changes the chat body. The Pro-side
 * validator is owned by the Pro repository (see the Phase 6 local handoff).
 */
export const CMEM_CORRELATION_HEADER = 'X-Cmem-Correlation';
export const CMEM_CORRELATION_MAX_EVENT_KEYS = 4;
export const CMEM_CORRELATION_MAX_ATTEMPT = 1000;
export const CMEM_CORRELATION_MAX_HEADER_BYTES = 1024;

export interface CmemRequestCorrelation {
  request_id: string;
  attempt: number;
  event_keys: string[];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Build the header value. Event keys are de-duplicated in order and capped at
 * four; anything that is not a lowercase SHA-256 hex key is dropped rather
 * than sent. Invalid request IDs or attempts throw: they are programming
 * errors, not user input.
 */
export function buildCmemCorrelationHeader(input: { requestId: string; attempt: number; eventKeys: readonly string[] }): string {
  if (!UUID_V4.test(input.requestId)) throw new Error('cmem correlation request_id must be a lowercase UUIDv4');
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > CMEM_CORRELATION_MAX_ATTEMPT) {
    throw new Error('cmem correlation attempt must be an integer from 1 to 1000');
  }
  const eventKeys: string[] = [];
  for (const key of input.eventKeys) {
    if (eventKeys.length === CMEM_CORRELATION_MAX_EVENT_KEYS) break;
    if (SHA256_HEX.test(key) && !eventKeys.includes(key)) eventKeys.push(key);
  }
  const correlation: CmemRequestCorrelation = { request_id: input.requestId, attempt: input.attempt, event_keys: eventKeys };
  const value = JSON.stringify(correlation);
  // 4 keys × 66 + UUID + framing is ~360 bytes; the bound is a tripwire.
  if (Buffer.byteLength(value, 'utf8') > CMEM_CORRELATION_MAX_HEADER_BYTES) throw new Error('cmem correlation header exceeds 1 KiB');
  return value;
}
