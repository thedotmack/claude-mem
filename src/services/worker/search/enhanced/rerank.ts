import { significantTokens, jaccard } from './tokenize.js';

export interface RerankableObservation {
  id: number;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  created_at_epoch: number;
  /** Usage history; column added by migration, defaults to 0. */
  relevance_count?: number;
}

export interface RerankOptions {
  /** Weight of normalized recency (0..1 across the candidate set). */
  recencyWeight?: number;
  /** Weight of Jaccard entity-match between query and observation text. */
  entityWeight?: number;
  /**
   * Weight of the saturating usage signal derived from relevance_count.
   * Note: no code path increments relevance_count yet, so this term is
   * currently inert (always 0) and activates once a writer is added.
   */
  usageWeight?: number;
}

/**
 * Rerank RRF-merged candidates. Base score is the positional prior 1/(rank+1)
 * — this preserves the upstream RRF order; bonuses only perturb it. Ported from
 * lib_baseline.rerank, with relevance_count added (the synthetic prototype had
 * no usage history).
 */
export function rerank<T extends RerankableObservation>(
  candidates: T[],
  query: string,
  options: RerankOptions = {},
): T[] {
  if (candidates.length === 0) return [];

  const recencyWeight = options.recencyWeight ?? 0.10;
  const entityWeight = options.entityWeight ?? 0.15;
  const usageWeight = options.usageWeight ?? 0.05;

  const epochs = candidates.map(c => c.created_at_epoch);
  const minEpoch = epochs.reduce((a, b) => Math.min(a, b), epochs[0]);
  const maxEpoch = epochs.reduce((a, b) => Math.max(a, b), epochs[0]);
  const span = maxEpoch - minEpoch;

  const queryTokens = significantTokens(query);

  const scored = candidates.map((candidate, index) => {
    const base = 1 / (index + 1);
    const recency = span > 0 ? (candidate.created_at_epoch - minEpoch) / span : 0;

    const text = [candidate.title, candidate.subtitle, candidate.narrative, candidate.facts]
      .filter(Boolean)
      .join(' ');
    const entity = jaccard(queryTokens, significantTokens(text));

    const usage = Math.log1p(candidate.relevance_count ?? 0);
    const usageSaturated = usage / (usage + 1); // pointwise saturation 0..1

    const total = base + recencyWeight * recency + entityWeight * entity + usageWeight * usageSaturated;
    return { candidate, total };
  });

  scored.sort((a, b) => b.total - a.total);
  return scored.map(s => s.candidate);
}
