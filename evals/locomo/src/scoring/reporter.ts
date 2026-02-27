/**
 * Results aggregation and reporting module for LoCoMo QA evaluation.
 *
 * Provides dual-metric reporting (token-level F1 + LLM-as-a-Judge J-score)
 * with comparison tables against published baselines from:
 *   - Original LoCoMo paper (ACL 2024) — F1 baselines
 *   - Mem0 paper (arXiv 2504.19413, ECAI accepted) — J-score baselines
 */

import { computeTokenF1 } from "./f1.js";
import type {
  QAResult,
  LatencyStats,
  CategoryF1Stats,
  CategoryJudgeStats,
} from "../types.js";

// ---------------------------------------------------------------------------
// F1 Baselines (from original LoCoMo paper + Mem0 paper)
// ---------------------------------------------------------------------------

export const F1_BASELINES: Record<string, Record<string, number | null>> = {
  "Human": { overall: 87.9 },
  "Mem0": { overall: null, "single-hop": 38.72, "multi-hop": 28.64, temporal: 48.93, "open-domain": 47.65 },
  "Mem0g": { overall: null, "single-hop": 38.09, "multi-hop": 24.32, temporal: 51.55, "open-domain": 49.27 },
  "Zep": { overall: null, "single-hop": 35.74, "multi-hop": 19.37, temporal: 42.00, "open-domain": 49.56 },
  "LangMem": { overall: null, "single-hop": 35.51, "multi-hop": 26.04, temporal: 30.75, "open-domain": 40.91 },
  "OpenAI Memory": { overall: null, "single-hop": 34.30, "multi-hop": 20.09, temporal: 14.04, "open-domain": 39.31 },
  "A-Mem": { overall: null, "single-hop": 20.76, "multi-hop": 9.22, temporal: 35.40, "open-domain": 33.34 },
  "GPT-3.5-turbo-16K": { overall: 37.8 },
  "RAG-observations (original paper)": { overall: 41.4 },
  "GPT-4-turbo": { overall: 32.1 },
};

// ---------------------------------------------------------------------------
// J-score Baselines (from Mem0 paper, arXiv 2504.19413 — adversarial excluded)
// ---------------------------------------------------------------------------

export const J_BASELINES: Record<string, Record<string, number | null>> = {
  "Full-context": { overall: 72.90 },
  "Mem0g": { overall: 68.44, "single-hop": 65.71, "multi-hop": 47.19, temporal: 58.13, "open-domain": 75.71 },
  "Mem0": { overall: 66.88, "single-hop": 67.13, "multi-hop": 51.15, temporal: 55.51, "open-domain": 72.93 },
  "Zep": { overall: 65.99, "single-hop": 61.70, "multi-hop": 41.35, temporal: 49.31, "open-domain": 76.60 },
  "RAG (best, k=2 256-tok)": { overall: 60.97 },
  "LangMem": { overall: 58.10, "single-hop": 62.23, "multi-hop": 47.92, temporal: 23.43, "open-domain": 71.12 },
  "OpenAI Memory": { overall: 52.90, "single-hop": 63.79, "multi-hop": 42.92, temporal: 21.71, "open-domain": 62.29 },
  "A-Mem": { overall: 48.38, "single-hop": 39.79, "multi-hop": 18.85, temporal: 49.91, "open-domain": 54.05 },
};

// ---------------------------------------------------------------------------
// F1 scoring helpers
// ---------------------------------------------------------------------------

/**
 * Apply computeTokenF1 to each result, populating the f1_score field.
 */
export function scoreResultsF1(
  results: Array<{ predicted_answer: string; ground_truth: string; category: string }>
): QAResult[] {
  return results.map((r) => ({
    question: (r as QAResult).question ?? "",
    predicted_answer: r.predicted_answer,
    ground_truth_answer: r.ground_truth,
    category: r.category,
    f1_score: computeTokenF1(r.predicted_answer, r.ground_truth),
    search_results_used: (r as QAResult).search_results_used ?? 0,
    search_latency_ms: (r as QAResult).search_latency_ms ?? 0,
    answer_latency_ms: (r as QAResult).answer_latency_ms ?? 0,
    answer_input_tokens: (r as QAResult).answer_input_tokens ?? 0,
    answer_output_tokens: (r as QAResult).answer_output_tokens ?? 0,
    judge_scores: (r as QAResult).judge_scores,
  }));
}

/**
 * Group results by category and compute mean/min/max F1 per category.
 */
export function aggregateF1ByCategory(results: QAResult[]): Record<string, CategoryF1Stats> {
  const groups = new Map<string, number[]>();
  for (const r of results) {
    const scores = groups.get(r.category) ?? [];
    scores.push(r.f1_score);
    groups.set(r.category, scores);
  }

  const out: Record<string, CategoryF1Stats> = {};
  for (const [category, scores] of groups) {
    out[category] = {
      mean_f1: scores.reduce((s, v) => s + v, 0) / scores.length,
      count: scores.length,
      min_f1: Math.min(...scores),
      max_f1: Math.max(...scores),
    };
  }
  return out;
}

/**
 * Macro average: sum of all F1 scores / total questions.
 */
export function computeOverallF1(results: QAResult[]): number {
  if (results.length === 0) return 0;
  return results.reduce((sum, r) => sum + r.f1_score, 0) / results.length;
}

// ---------------------------------------------------------------------------
// Judge scoring helpers
// ---------------------------------------------------------------------------

/**
 * Group results by category and compute mean J-score per category.
 * Averages the per-question mean_scores. Computes pooled stddev.
 */
export function aggregateJudgeByCategory(results: QAResult[]): Record<string, CategoryJudgeStats> {
  const groups = new Map<string, { means: number[]; stddevs: number[]; counts: number[] }>();
  for (const r of results) {
    if (!r.judge_scores || r.judge_scores.mean_score < 0) continue;
    const group = groups.get(r.category) ?? { means: [], stddevs: [], counts: [] };
    group.means.push(r.judge_scores.mean_score);
    group.stddevs.push(r.judge_scores.std_dev);
    group.counts.push(r.judge_scores.run_count);
    groups.set(r.category, group);
  }

  const out: Record<string, CategoryJudgeStats> = {};
  for (const [category, { means, stddevs, counts }] of groups) {
    const meanJ = means.reduce((s, v) => s + v, 0) / means.length;
    // Pooled standard deviation: sqrt(mean of variances)
    const pooledVariance =
      stddevs.reduce((sum, sd, i) => sum + sd * sd * counts[i], 0) /
      counts.reduce((s, c) => s + c, 0);
    out[category] = {
      mean_j: Math.round(meanJ * 100) / 100,
      std_dev: Math.round(Math.sqrt(pooledVariance) * 100) / 100,
      count: means.length,
    };
  }
  return out;
}

/**
 * Macro average of per-question mean J-scores, with pooled standard deviation.
 */
export function computeOverallJudge(results: QAResult[]): { mean_j: number; pooled_std_dev: number } {
  const validResults = results.filter(
    (r) => r.judge_scores && r.judge_scores.mean_score >= 0
  );
  if (validResults.length === 0) return { mean_j: 0, pooled_std_dev: 0 };

  const meanJ =
    validResults.reduce((sum, r) => sum + r.judge_scores!.mean_score, 0) / validResults.length;

  // Pooled standard deviation across all runs
  let totalWeightedVariance = 0;
  let totalRuns = 0;
  for (const r of validResults) {
    const js = r.judge_scores!;
    totalWeightedVariance += js.std_dev * js.std_dev * js.run_count;
    totalRuns += js.run_count;
  }
  const pooledStdDev = totalRuns > 0 ? Math.sqrt(totalWeightedVariance / totalRuns) : 0;

  return {
    mean_j: Math.round(meanJ * 100) / 100,
    pooled_std_dev: Math.round(pooledStdDev * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Latency helpers
// ---------------------------------------------------------------------------

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (idx - lower);
}

export function computeLatencyStats(results: QAResult[]): LatencyStats {
  const searchLatencies = results.map((r) => r.search_latency_ms).sort((a, b) => a - b);
  const answerLatencies = results.map((r) => r.answer_latency_ms).sort((a, b) => a - b);
  const totalLatencies = results
    .map((r) => r.search_latency_ms + r.answer_latency_ms)
    .sort((a, b) => a - b);

  return {
    search_p50_ms: Math.round(percentile(searchLatencies, 50)),
    search_p95_ms: Math.round(percentile(searchLatencies, 95)),
    answer_p50_ms: Math.round(percentile(answerLatencies, 50)),
    answer_p95_ms: Math.round(percentile(answerLatencies, 95)),
    total_p50_ms: Math.round(percentile(totalLatencies, 50)),
    total_p95_ms: Math.round(percentile(totalLatencies, 95)),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(value: number | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined) return "—";
  return value.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// F1 comparison table
// ---------------------------------------------------------------------------

const F1_CATEGORIES = ["single-hop", "multi-hop", "temporal", "open-domain"];

export function formatF1ComparisonTable(
  evalResults: QAResult[],
  f1Baselines: Record<string, Record<string, number | null>> = F1_BASELINES
): string {
  const catStats = aggregateF1ByCategory(evalResults);
  const overallF1 = computeOverallF1(evalResults);

  // Convert our F1 to percentage scale (0-100) for comparison
  const ourRow: Record<string, number | null> = { overall: overallF1 * 100 };
  for (const cat of F1_CATEGORIES) {
    ourRow[cat] = catStats[cat] ? catStats[cat].mean_f1 * 100 : null;
  }

  const header = `| System | Overall | ${F1_CATEGORIES.join(" | ")} |`;
  const separator = `|--------|---------|${F1_CATEGORIES.map(() => "---------").join("|")}|`;

  const rows: string[] = [];

  // Our results first
  rows.push(
    `| **claude-mem** | **${fmt(ourRow.overall)}** | ${F1_CATEGORIES.map((c) => `**${fmt(ourRow[c])}**`).join(" | ")} |`
  );

  // Baselines
  for (const [name, baseline] of Object.entries(f1Baselines)) {
    rows.push(
      `| ${name} | ${fmt(baseline.overall)} | ${F1_CATEGORIES.map((c) => fmt(baseline[c])).join(" | ")} |`
    );
  }

  return `### Token-level F1 Comparison\n\n${header}\n${separator}\n${rows.join("\n")}`;
}

// ---------------------------------------------------------------------------
// J-score comparison table
// ---------------------------------------------------------------------------

const J_CATEGORIES = ["single-hop", "multi-hop", "temporal", "open-domain"];

export function formatJudgeComparisonTable(
  evalResults: QAResult[],
  jBaselines: Record<string, Record<string, number | null>> = J_BASELINES
): string {
  const catStats = aggregateJudgeByCategory(evalResults);
  const overallJudge = computeOverallJudge(evalResults);

  const ourRow: Record<string, string> = {
    overall: `${fmt(overallJudge.mean_j)} ±${fmt(overallJudge.pooled_std_dev)}`,
  };
  for (const cat of J_CATEGORIES) {
    ourRow[cat] = catStats[cat]
      ? `${fmt(catStats[cat].mean_j)} ±${fmt(catStats[cat].std_dev)}`
      : "—";
  }

  const header = `| System | Overall | ${J_CATEGORIES.join(" | ")} |`;
  const separator = `|--------|---------|${J_CATEGORIES.map(() => "---------").join("|")}|`;

  const rows: string[] = [];

  // Our results first
  rows.push(
    `| **claude-mem** | **${ourRow.overall}** | ${J_CATEGORIES.map((c) => `**${ourRow[c]}**`).join(" | ")} |`
  );

  // Baselines
  for (const [name, baseline] of Object.entries(jBaselines)) {
    rows.push(
      `| ${name} | ${fmt(baseline.overall)} | ${J_CATEGORIES.map((c) => fmt(baseline[c])).join(" | ")} |`
    );
  }

  return [
    "### LLM-as-a-Judge (J-score) Comparison",
    "",
    header,
    separator,
    ...rows,
    "",
    `> *Letta reports 74.0% "accuracy" using a different scoring methodology (not LLM-as-a-Judge), so it is not directly comparable.*`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Latency comparison table
// ---------------------------------------------------------------------------

export function formatLatencyComparisonTable(latencyStats: LatencyStats): string {
  const header = "| Metric | claude-mem | Mem0 (published) |";
  const separator = "|--------|-----------|-----------------|";

  const rows = [
    `| Search p50 | ${(latencyStats.search_p50_ms / 1000).toFixed(3)}s | 0.148s |`,
    `| Search p95 | ${(latencyStats.search_p95_ms / 1000).toFixed(3)}s | 0.200s |`,
    `| Total p50 | ${(latencyStats.total_p50_ms / 1000).toFixed(3)}s | 0.708s |`,
    `| Total p95 | ${(latencyStats.total_p95_ms / 1000).toFixed(3)}s | 1.440s |`,
  ];

  return `### Latency Comparison\n\n${header}\n${separator}\n${rows.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Full report
// ---------------------------------------------------------------------------

export function formatFullReport(evalResults: QAResult[]): string {
  const latencyStats = computeLatencyStats(evalResults);

  // Token stats
  const totalInputTokens = evalResults.reduce((s, r) => s + r.answer_input_tokens, 0);
  const totalOutputTokens = evalResults.reduce((s, r) => s + r.answer_output_tokens, 0);
  const meanTokensPerQuestion =
    evalResults.length > 0
      ? Math.round((totalInputTokens + totalOutputTokens) / evalResults.length)
      : 0;

  // F1 per-category breakdown
  const catF1 = aggregateF1ByCategory(evalResults);
  const overallF1 = computeOverallF1(evalResults);

  // Judge per-category breakdown
  const catJudge = aggregateJudgeByCategory(evalResults);
  const overallJudge = computeOverallJudge(evalResults);

  // Top-5 and bottom-5 by F1 for error analysis
  const sortedByF1 = [...evalResults].sort((a, b) => b.f1_score - a.f1_score);
  const top5 = sortedByF1.slice(0, 5);
  const bottom5 = sortedByF1.slice(-5).reverse();

  const sections: string[] = [];

  // Header
  sections.push("# LoCoMo Evaluation Report");
  sections.push("");
  sections.push(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  sections.push(`**Questions evaluated:** ${evalResults.length}`);
  sections.push(`**Overall F1:** ${fmt(overallF1 * 100)}%`);

  if (overallJudge.mean_j > 0) {
    sections.push(`**Overall J-score:** ${fmt(overallJudge.mean_j)} ±${fmt(overallJudge.pooled_std_dev)}`);
  }
  sections.push("");

  // F1 comparison table
  sections.push(formatF1ComparisonTable(evalResults));
  sections.push("");

  // J-score comparison table (only if judge scores exist)
  const hasJudgeScores = evalResults.some((r) => r.judge_scores && r.judge_scores.mean_score >= 0);
  if (hasJudgeScores) {
    sections.push(formatJudgeComparisonTable(evalResults));
    sections.push("");
  }

  // Latency comparison
  sections.push(formatLatencyComparisonTable(latencyStats));
  sections.push("");

  // Per-category F1 breakdown
  sections.push("### Per-Category F1 Breakdown");
  sections.push("");
  sections.push("| Category | Mean F1 | Count | Min | Max |");
  sections.push("|----------|---------|-------|-----|-----|");
  for (const [cat, stats] of Object.entries(catF1)) {
    sections.push(
      `| ${cat} | ${fmt(stats.mean_f1 * 100)}% | ${stats.count} | ${fmt(stats.min_f1 * 100)}% | ${fmt(stats.max_f1 * 100)}% |`
    );
  }
  sections.push("");

  // Per-category Judge breakdown (if available)
  if (hasJudgeScores) {
    sections.push("### Per-Category J-score Breakdown");
    sections.push("");
    sections.push("| Category | Mean J | ±StdDev | Count |");
    sections.push("|----------|--------|---------|-------|");
    for (const [cat, stats] of Object.entries(catJudge)) {
      sections.push(`| ${cat} | ${fmt(stats.mean_j)} | ±${fmt(stats.std_dev)} | ${stats.count} |`);
    }
    sections.push("");
  }

  // Token/latency summary
  sections.push("### Token & Latency Summary");
  sections.push("");
  sections.push(`| Metric | Value |`);
  sections.push(`|--------|-------|`);
  sections.push(`| Total input tokens | ${totalInputTokens.toLocaleString()} |`);
  sections.push(`| Total output tokens | ${totalOutputTokens.toLocaleString()} |`);
  sections.push(`| Mean tokens/question | ${meanTokensPerQuestion.toLocaleString()} (Mem0: 1,764) |`);
  sections.push(`| Search p50 | ${(latencyStats.search_p50_ms / 1000).toFixed(3)}s |`);
  sections.push(`| Search p95 | ${(latencyStats.search_p95_ms / 1000).toFixed(3)}s |`);
  sections.push(`| Total p50 | ${(latencyStats.total_p50_ms / 1000).toFixed(3)}s |`);
  sections.push(`| Total p95 | ${(latencyStats.total_p95_ms / 1000).toFixed(3)}s |`);
  sections.push("");

  // Error analysis: top 5
  sections.push("### Top 5 Questions (by F1)");
  sections.push("");
  for (const r of top5) {
    sections.push(`- **F1=${fmt(r.f1_score * 100)}%** [${r.category}] "${r.question}"`);
    sections.push(`  - Predicted: ${r.predicted_answer.slice(0, 100)}${r.predicted_answer.length > 100 ? "..." : ""}`);
    sections.push(`  - Ground truth: ${r.ground_truth_answer}`);
  }
  sections.push("");

  // Error analysis: bottom 5
  sections.push("### Bottom 5 Questions (by F1)");
  sections.push("");
  for (const r of bottom5) {
    sections.push(`- **F1=${fmt(r.f1_score * 100)}%** [${r.category}] "${r.question}"`);
    sections.push(`  - Predicted: ${r.predicted_answer.slice(0, 100)}${r.predicted_answer.length > 100 ? "..." : ""}`);
    sections.push(`  - Ground truth: ${r.ground_truth_answer}`);
  }

  return sections.join("\n");
}
