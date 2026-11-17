/**
 * metadata key, in a POST /api/memory/save request, for a second sourceFingerprint
 * the worker's exact-replay lookup also matches (src/services/memory/save-memory.ts):
 * the fingerprint an earlier client version saved for the same source record, such
 * as the whole-row one `claude-mem import` 15.19.0 saved for a Supermemory document.
 * The lookup tries `sourceFingerprint` first, then this one, under the same project
 * and platform. It is used for the lookup only and never stored with the note; a
 * worker without this support ignores it like any other metadata.
 */
export const LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY = 'lookupOnlyAlternativeSourceFingerprint';
