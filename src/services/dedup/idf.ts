/**
 * Inverse document frequency for near-duplicate detection (#3038).
 *
 * IDF is what lets the dedup separate "near-identical but differ in a rare,
 * discriminating token" (e.g. `rdlp-api` vs `rdlp-plugin`) from a true reword:
 * a rare token carries high weight, so a difference in it dominates both the
 * TF-IDF cosine and the IDF-veto. This is the Salton/Fellegi-Sunter insight —
 * disagreement on a rare field is strong evidence of non-match.
 *
 * Pure math only; the document-frequency table is maintained by the store layer.
 */

/**
 * Smoothed IDF: `log(1 + N / (df + 0.5))`.
 * The `+0.5` smoothing keeps `df = 0` (token unseen in corpus) finite and maximal.
 */
export function idf(df: number, n: number): number {
  return Math.log(1 + n / (df + 0.5));
}

/** Build a reusable `token -> idf` function from a df lookup and corpus size N. */
export function buildIdfFn(dfLookup: (token: string) => number, n: number): (token: string) => number {
  return (token: string) => idf(dfLookup(token), n);
}
