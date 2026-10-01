/**
 * IDF-weighted TF-IDF cosine similarity for near-duplicate detection (#3038).
 *
 * Each title is a bag of tokens weighted by IDF (tf=1 — titles are short, ~5-12
 * tokens, so term repetition is negligible). Cosine of the two IDF vectors.
 *
 * Why this and not plain string/token similarity: a rare discriminating token
 * present on one side only (`rdlp-api` vs `rdlp-plugin`, `ffmpeg-7.1` vs `6.1`)
 * has a large IDF, so it inflates that side's norm while contributing nothing to
 * the dot product — pulling cosine down. Plain Levenshtein/token-sort sees high
 * character overlap and wrongly scores these ~0.9.
 */

function idfVector(tokens: string[], idfFn: (t: string) => number): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of new Set(tokens)) v.set(t, idfFn(t));
  return v;
}

export function tfidfCosine(a: string[], b: string[], idfFn: (t: string) => number): number {
  const va = idfVector(a, idfFn);
  const vb = idfVector(b, idfFn);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [t, w] of va) {
    normA += w * w;
    const wb = vb.get(t);
    if (wb !== undefined) dot += w * wb;
  }
  for (const [, w] of vb) normB += w * w;
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
