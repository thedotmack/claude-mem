// SPDX-License-Identifier: Apache-2.0

/**
 * Pure metric functions — no DB, no I/O. Unit-tested in tests/memory-eval-metrics.test.ts.
 */

/** Fraction of queries where at least one gold id appears in the top-k of the ranked list. */
export function hitRateAtK(rankedIds: number[][], goldIds: number[][], k: number): number {
  if (rankedIds.length === 0) return 0;
  let hits = 0;
  for (let i = 0; i < rankedIds.length; i++) {
    const top = new Set(rankedIds[i].slice(0, k));
    if (goldIds[i].some(id => top.has(id))) hits++;
  }
  return hits / rankedIds.length;
}

/** Per-query boolean hit vector (for disagreement reporting). */
export function hitVector(rankedIds: number[][], goldIds: number[][], k: number): boolean[] {
  return rankedIds.map((ids, i) => {
    const top = new Set(ids.slice(0, k));
    return goldIds[i].some(id => top.has(id));
  });
}

/** Mean of per-query token costs. */
export function meanTokens(costs: number[]): number {
  if (costs.length === 0) return 0;
  return costs.reduce((a, b) => a + b, 0) / costs.length;
}

/** Mean judge relevance: judge returns relevant-count per query (0..k); metric is the mean fraction. */
export function meanRelevance(counts: number[], k: number): number {
  if (counts.length === 0 || k <= 0) return 0;
  return counts.reduce((a, b) => a + Math.min(b, k) / k, 0) / counts.length;
}

/**
 * Rule 4 — disagreement between the lexical metric and the judge:
 * queries where hit@k and (judgeCount > 0) give different answers.
 */
export function disagreementCount(hits: boolean[], judgeCounts: number[]): number {
  let n = 0;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i] !== (judgeCounts[i] > 0)) n++;
  }
  return n;
}

/** Saturation (rule 5): fraction of queries whose gold is already in the no-retrieval recent block. */
export function saturationRate(recentBlockIds: number[][], goldIds: number[][]): number {
  if (recentBlockIds.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < recentBlockIds.length; i++) {
    const block = new Set(recentBlockIds[i]);
    if (goldIds[i].some(id => block.has(id))) n++;
  }
  return n / recentBlockIds.length;
}

/** Parse a decay-exponent grid like "0.2..1.0" with a step (default 0.1). */
export function parseGrid(spec: string | undefined, step: number = 0.1): number[] {
  const fallback = { lo: 0.2, hi: 1.0 };
  let { lo, hi } = fallback;
  if (spec) {
    const m = spec.match(/^(\d*\.?\d+)\.\.(\d*\.?\d+)$/);
    if (m) {
      lo = Number(m[1]);
      hi = Number(m[2]);
    }
  }
  const out: number[] = [];
  for (let d = lo; d <= hi + 1e-9; d += step) {
    out.push(Math.round(d * 100) / 100);
  }
  return out;
}
