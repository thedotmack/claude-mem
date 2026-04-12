/**
 * Lightweight string similarity utilities for observation deduplication.
 * Uses Levenshtein distance normalized by the length of the longer string.
 * No external dependencies — narratives are typically short (1-3 sentences).
 */

/**
 * Normalize a string for comparison: Unicode NFC, collapse whitespace, trim, lowercase.
 */
export function normalizeForComparison(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Max string length for Levenshtein comparison. Longer strings skip fuzzy matching to avoid O(n*m) cost. */
const MAX_LEVENSHTEIN_LENGTH = 1000;

/**
 * Compute normalized similarity between two strings.
 * Returns a value between 0.0 (completely different) and 1.0 (identical).
 * Applies whitespace/case normalization before comparison.
 * Strings longer than 1000 chars skip Levenshtein and fall back to exact match only.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (na === nb) return 1.0;
  if (!na.length || !nb.length) return 0.0;
  if (Math.max(na.length, nb.length) > MAX_LEVENSHTEIN_LENGTH) return 0.0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

/**
 * Compute Levenshtein (edit) distance between two strings.
 * O(n*m) time and O(n) space using two-row optimization.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimize: ensure a is the shorter string for space efficiency
  if (m > n) return levenshtein(b, a);

  let prev = new Array(m + 1);
  let curr = new Array(m + 1);

  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      curr[i] = a[i - 1] === b[j - 1]
        ? prev[i - 1]
        : 1 + Math.min(prev[i], curr[i - 1], prev[i - 1]);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}
