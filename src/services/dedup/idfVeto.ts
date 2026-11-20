/**
 * IDF-veto — the discriminating-token gate for near-duplicate detection (#3038).
 *
 * Two titles may be lexically near-identical yet describe DISTINCT work because
 * they differ in one high-information token (`rdlp-api` vs `rdlp-plugin`,
 * `ffmpeg-7.1` vs `6.1`). This is Fellegi-Sunter's "blocking key": disagreement
 * on a rare field (low collision probability `u`) is strong evidence of NON-match.
 *
 * The veto fires when ANY token in the symmetric difference of the two token sets
 * has `idf > thetaIdf` — i.e. a rare, discriminating token is present on exactly
 * one side. A fired veto vetoes the merge regardless of cosine similarity.
 *
 * Known limitation (by design): when the discriminator is a COMMON token
 * (`code` vs `security` review), its IDF is low and the veto does not fire.
 * Lexical methods cannot separate those; that residual is the Branch-2
 * LLM-adjudication tier's job. See tests/dedup/idf-veto.test.ts.
 */
export function vetoFires(
  a: string[],
  b: string[],
  idfFn: (t: string) => number,
  thetaIdf: number
): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  for (const t of setA) if (!setB.has(t) && idfFn(t) > thetaIdf) return true;
  for (const t of setB) if (!setA.has(t) && idfFn(t) > thetaIdf) return true;
  return false;
}
