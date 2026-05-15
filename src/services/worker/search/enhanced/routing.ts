import { significantTokens } from './tokenize.js';

export interface RoutableObservation {
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
}

export interface RoutingConfig {
  /** Fraction of query tokens the top FTS5 hit must cover to skip hybrid. */
  coverageThreshold: number;
  /** FTS5 result count below which hybrid is forced. */
  minFtsResults: number;
}

/** Tunable defaults — coverageThreshold is validated against LongMemEval in Phase 5. */
export const ROUTING_DEFAULTS: RoutingConfig = {
  coverageThreshold: 0.75,
  minFtsResults: 1,
};

export interface RoutingDecision {
  useHybrid: boolean;
  reason: 'fts-empty' | 'fts-confident' | 'fts-flat' | 'no-significant-tokens';
  topCoverage: number;
}

/**
 * Decide whether to engage Chroma + RRF on top of FTS5, based on how completely
 * the top FTS5 hit covers the query's significant tokens.
 */
export function shouldUseHybrid(
  query: string,
  ftsResults: RoutableObservation[],
  config: RoutingConfig = ROUTING_DEFAULTS,
): RoutingDecision {
  if (ftsResults.length < config.minFtsResults) {
    return { useHybrid: true, reason: 'fts-empty', topCoverage: 0 };
  }

  const queryTokens = significantTokens(query);
  if (queryTokens.size === 0) {
    return { useHybrid: false, reason: 'no-significant-tokens', topCoverage: 1 };
  }

  const top = ftsResults[0];
  const topText = [top.title, top.subtitle, top.narrative, top.facts]
    .filter(Boolean)
    .join(' ');
  const topTokens = significantTokens(topText);

  let covered = 0;
  for (const t of queryTokens) if (topTokens.has(t)) covered++;
  const topCoverage = covered / queryTokens.size;

  if (topCoverage >= config.coverageThreshold) {
    return { useHybrid: false, reason: 'fts-confident', topCoverage };
  }
  return { useHybrid: true, reason: 'fts-flat', topCoverage };
}
