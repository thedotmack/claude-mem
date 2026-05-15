// Minimal English stopword list — ported from claude-mem-bench/scripts/lib_baseline.py.
// Kept deliberately small so query terms stay semantically loaded.
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'of', 'in', 'on', 'at',
  'to', 'for', 'with', 'and', 'or', 'but', 'if', 'then', 'what', 'when',
  'where', 'why', 'how', 'who', 'whom', 'which', 'this', 'that', 'these',
  'those', 'you', 'his', 'her', 'hers', 'its', 'our', 'ours', 'their',
  'theirs', 'as', 'by', 'from', 'into', 'about', 'any', 'some', 'all',
  'would', 'could', 'should', 'can', 'will', 'may', 'might', 'must',
]);

/**
 * Lowercase alphanumeric tokens, dropping stopwords and tokens of length <= 2.
 * Used for both rerank entity-match and routing coverage — keep them consistent.
 */
export function significantTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter(w => w.length > 2 && !STOPWORDS.has(w)));
}

/** Jaccard similarity of two token sets. Returns 0 if either set is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
