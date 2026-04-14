/**
 * 2-Layer Dedup Pipeline for search results
 *
 * Simplified from 4-layer GBrain adaptation based on real-data analysis
 * (see spec 005-dedup-pipeline.md for original design):
 * - L1 (session top-3) and L4 (session cap) were redundant -> merged into single session cap
 * - L2 (Jaccard similarity) had zero hits on 3700+ observations (even at 0.6 threshold) -> removed
 * - L3 (project diversity) retained as precision filter with low collateral damage
 *
 * Empirical results (14 queries x 50 results on real dataset):
 * - Old 4-layer pipeline: 51.7% drop rate, 53.0% fact loss (near-random truncation)
 * - New 2-layer (cap=5):  23.6% drop rate, 24.3% fact loss
 * - New 2-layer (cap=8):  12.3% drop rate, 12.1% fact loss, 0 high-score drops
 *
 * Layers:
 *   1. Project diversity — no single project > maxRatio of results
 *   2. Session cap — max N results per session in final output
 */

/**
 * Minimum interface for a dedupable search result
 */
export interface DedupableResult {
  id: number;
  text: string | null;
  title: string | null;
  narrative: string | null;
  score?: number;
  memory_session_id?: string;
  project?: string;
}

export interface DedupOptions {
  /** Max ratio of results from a single project (default: 0.6) */
  maxProjectRatio?: number;
  /** Max results per session in final output (default: 8) */
  maxPerSession?: number;
}

/**
 * Compute Jaccard similarity between two texts based on word sets
 *
 * Retained as a utility for future use or external callers,
 * but no longer used in the pipeline (zero hits on real data).
 */
export function jaccardSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersectionSize++;
  }

  const unionSize = wordsA.size + wordsB.size - intersectionSize;
  if (unionSize === 0) return 0.0;

  return intersectionSize / unionSize;
}

/**
 * Layer 1: Enforce project diversity (no single project > maxRatio of results)
 *
 * Prevents a single dominant project from monopolizing search results
 * in cross-project queries. Low collateral damage (~4% drop rate, ~3.7% fact loss).
 */
function enforceProjectDiversity(
  results: DedupableResult[],
  maxRatio: number
): DedupableResult[] {
  const maxPerProject = Math.max(1, Math.ceil(results.length * maxRatio));
  const projectCounts = new Map<string, number>();
  const kept: DedupableResult[] = [];

  for (const r of results) {
    const project = r.project || 'unknown';
    const count = projectCounts.get(project) || 0;
    if (count < maxPerProject) {
      kept.push(r);
      projectCounts.set(project, count + 1);
    }
  }

  return kept;
}

/**
 * Layer 2: Cap results per session in final output
 *
 * Ensures no single session dominates results while preserving
 * information diversity within sessions. Default cap of 8 provides
 * conservative filtering (~10% token savings, ~10% fact loss, 0 high-score drops).
 *
 * Sensitivity analysis (on real 3700+ obs dataset):
 *   cap=2:  50.7% drop, 52.5% fact loss  (too aggressive)
 *   cap=3:  38.0% drop, 39.7% fact loss  (still aggressive)
 *   cap=5:  22.0% drop, 23.2% fact loss  (moderate)
 *   cap=8:   9.8% drop, 10.0% fact loss  (conservative, recommended)
 *   cap=10:  5.7% drop,  5.8% fact loss  (minimal filtering)
 */
function capPerSession(
  results: DedupableResult[],
  max: number
): DedupableResult[] {
  const sessionCounts = new Map<string, number>();
  const kept: DedupableResult[] = [];

  for (const r of results) {
    const key = r.memory_session_id || 'unknown';
    const count = sessionCounts.get(key) || 0;
    if (count < max) {
      kept.push(r);
      sessionCounts.set(key, count + 1);
    }
  }

  return kept;
}

/**
 * Run the 2-layer dedup pipeline on search results
 *
 * Layer 1: Project diversity (no project > 60% of results)
 * Layer 2: Session cap (max N per session)
 */
export function dedupResults<T extends DedupableResult>(
  results: T[],
  opts: DedupOptions = {}
): T[] {
  const maxRatio = opts.maxProjectRatio ?? 0.6;
  const maxPerSession = opts.maxPerSession ?? 8;

  if (results.length <= 1) return results;

  let deduped: DedupableResult[] = results;

  // Layer 1: Project diversity (no project > 60%)
  deduped = enforceProjectDiversity(deduped, maxRatio);

  // Layer 2: Session cap (max N per session)
  deduped = capPerSession(deduped, maxPerSession);

  return deduped as T[];
}
