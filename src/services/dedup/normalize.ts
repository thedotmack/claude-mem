/**
 * Text normalization + tokenization for near-duplicate detection (#3038).
 *
 * Two deliberately-different transforms:
 *  - `normalizeTitle` strips punctuation → used for Tier-0 exact-normalized-title
 *    matching (case/whitespace/punctuation-insensitive equality).
 *  - `tokenizeWs` splits on whitespace ONLY (keeping `rdlp-api`, `ffmpeg-7.1.conf`,
 *    `download.rs` as single tokens) → used for IDF weighting and the IDF-veto,
 *    where a compound identifier must stay one rare token. Splitting it would make
 *    `api` look common and break the discriminating-token veto.
 */

/** Lowercase, replace non-alphanumeric (Unicode-aware) with a space, collapse runs, trim. */
export function normalizeTitle(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whitespace-only split + lowercase; preserves compound identifiers as single tokens. */
export function tokenizeWs(s: string | null | undefined): string[] {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
