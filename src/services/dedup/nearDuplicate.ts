/**
 * Near-duplicate tier decision for #3038.
 *
 * Two safe tiers, both deterministic:
 *   - Tier-0 "exact": titles equal after normalization → safe silent auto-merge.
 *   - Tier-1 "candidate": IDF-weighted cosine >= threshold AND the IDF-veto does
 *     NOT fire → a near-duplicate CANDIDATE (persisted for review / future
 *     LLM adjudication), never a silent merge.
 * Everything else → "none".
 *
 * Validated against a real 7,651-observation DB: simhash-over-narrative was
 * useless (false-positive dominated); IDF-cosine + veto separates true rewords
 * from distinct-but-similar titles that differ in a rare token.
 */
import { normalizeTitle, tokenizeWs } from './normalize.js';
import { tfidfCosine } from './tfidfCosine.js';
import { vetoFires } from './idfVeto.js';

export type DedupTier = 'exact' | 'candidate' | 'none';
export type DedupMethod = 'exact' | 'idf_cosine' | 'none';

export interface ClassifyThresholds {
  /** Minimum IDF-weighted cosine for a Tier-1 candidate. */
  cosineThreshold: number;
  /** A symmetric-difference token with idf above this vetoes the merge. */
  vetoThetaIdf: number;
  /**
   * Minimum count of shared tokens required before computing cosine. Short titles
   * make cosine "jumpy" — a single shared rare token can dominate it to ~1.0 even
   * when the titles are otherwise disjoint (sparse-vector noise). Defaults to 2.
   */
  minSharedTokens?: number;
}

export interface PairClassification {
  tier: DedupTier;
  method: DedupMethod;
  score: number;
}

/** Runtime configuration surfaced via settings (resolved to thresholds by the store). */
export interface FuzzyDedupConfig {
  enabled: boolean;
  cosineThreshold: number;
  /** A token appearing in <= idfVetoDf records is "discriminating". */
  idfVetoDf: number;
}

export function classifyPair(
  a: string | null | undefined,
  b: string | null | undefined,
  idfFn: (t: string) => number,
  thresholds: ClassifyThresholds
): PairClassification {
  // Tier-0 requires a NON-EMPTY normal form: null/empty/whitespace/punctuation-only/
  // emoji-only titles all normalize to '' and must NOT collapse into each other
  // (that would silently auto-merge distinct observations — data loss). The Tier-1
  // fall-through is already safe for these (empty tokens → cosine 0 → 'none').
  const normA = normalizeTitle(a);
  if (normA !== '' && normA === normalizeTitle(b)) {
    return { tier: 'exact', method: 'exact', score: 1 };
  }
  const ta = tokenizeWs(a);
  const tb = tokenizeWs(b);
  // Sparse-vector noise guard: require >=N shared tokens before trusting cosine.
  const minShared = thresholds.minSharedTokens ?? 2;
  const setB = new Set(tb);
  let shared = 0;
  for (const t of new Set(ta)) if (setB.has(t)) shared++;
  if (shared < minShared) return { tier: 'none', method: 'none', score: 0 };
  const score = tfidfCosine(ta, tb, idfFn);
  if (score >= thresholds.cosineThreshold && !vetoFires(ta, tb, idfFn, thresholds.vetoThetaIdf)) {
    return { tier: 'candidate', method: 'idf_cosine', score };
  }
  return { tier: 'none', method: 'none', score };
}
