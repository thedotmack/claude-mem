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

/** Canonicalize case/Unicode, retain letters, numbers and meaningful marks, collapse punctuation/whitespace. */
export function normalizeTitle(s: string | null | undefined): string {
  const normalized = (s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Marks alone cannot identify a title, just like punctuation alone.
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : '';
}

/** Whitespace-only split + lowercase; preserves compound identifiers as single tokens. */
export function tokenizeWs(s: string | null | undefined): string[] {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
