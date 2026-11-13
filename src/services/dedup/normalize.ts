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

/**
 * The indexed normal form is a candidate key, not proof that two technical
 * titles identify the same fact. Keep C/C++/C#, paths, field names and version
 * identifiers apart before a silent merge, while retaining the existing
 * case, prose-hyphenation and surrounding-punctuation equivalence.
 */
export function exactTitleMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = normalizeTitle(a);
  if (!norm || norm !== normalizeTitle(b)) return false;
  const identifiers = (value: string | null | undefined): string[] =>
    (value ?? '').normalize('NFC').toLowerCase()
      .match(/(?<![\p{L}\p{N}\p{M}])(?:[\p{L}\p{N}\p{M}]+(?:[./_\\:@#=<>]+[\p{L}\p{N}\p{M}]+)+|[\p{L}\p{N}\p{M}]+[+#]+)/gu) ?? [];
  return JSON.stringify(identifiers(a)) === JSON.stringify(identifiers(b));
}

/** Whitespace-only split + lowercase; preserves compound identifiers as single tokens. */
export function tokenizeWs(s: string | null | undefined): string[] {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
