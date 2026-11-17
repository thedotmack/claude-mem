/**
 * Limits of the canonical cloud sync protocol, defined once for the sync code
 * (src/services/sync/CanonicalContent.ts) and for clients that must stay inside
 * them before they write, such as `claude-mem import`. This module has no
 * imports, so a client takes the numbers without loading any sync code.
 */

/**
 * The largest canonical content body, in UTF-8 bytes: one synced record. It is
 * the protocol's per-record cap ("Each individual canonical body is capped at
 * 256,000 encoded bytes", docs/public/cloud-sync.mdx). The sending side refuses
 * to build a larger body and the receiving side refuses to parse one, so
 * CloudSync quarantines such a record and it never leaves this device.
 */
export const CONTENT_BODY_MAX_BYTES = 256_000;

/** The longest `origin_device_id` the protocol accepts, in UTF-8 bytes. */
export const ORIGIN_DEVICE_ID_MAX_BYTES = 128;
