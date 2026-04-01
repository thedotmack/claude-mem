import type { AgentResult } from './aggregator.js';
import type { Prompt } from '../types.js';

// --- Interfaces ---

export interface BaselineComparison {
  promptId: string;
  promptTitle: string;
  arm: string;
  ourCostUsd: number;
  baselineCostUsd: number | null;
  costDeltaPercent: number | null;
  ourDurationSeconds: number;
  baselineDurationSeconds: number | null;
  durationDeltaPercent: number | null;
  ourQualityScore: number;
  baselineArchitecture: string | null;
  baselineSource: string;
  notes: string;
}

// --- Baseline Notes ---

const BASELINE_NOTES: Record<string, string> = {
  'anthropic:retro-forge':
    'Single-agent vs 3-agent pipeline',
  'anthropic:browser-daw':
    'Single-agent vs 3-agent pipeline',
  'anthropic:dutch-art-museum':
    'Quality comparison only, no cost baseline',
  'openai:design-desk':
    'Token comparison, estimated cost from 13M tokens',
};

function getBaselineNote(source: string, promptId: string): string {
  // Try specific source:prompt lookup first
  const specificKey = `${source}:${promptId}`;
  for (const [key, note] of Object.entries(BASELINE_NOTES)) {
    if (specificKey.includes(key) || promptId.includes(key.split(':')[1])) {
      return note;
    }
  }

  // Generic note based on source
  if (source === 'anthropic') {
    return 'Single-agent vs 3-agent pipeline';
  }
  if (source === 'openai') {
    return 'Token comparison, estimated cost from 13M tokens';
  }

  return '';
}

// --- Helpers ---

function computeWeightedQualityScore(rubricScores: {
  functionality: number;
  code_quality: number;
  ux: number;
  completeness: number;
}): number {
  // Weighted average: functionality and completeness weighted more heavily
  const weights = {
    functionality: 0.35,
    code_quality: 0.2,
    ux: 0.15,
    completeness: 0.3,
  };

  return (
    rubricScores.functionality * weights.functionality +
    rubricScores.code_quality * weights.code_quality +
    rubricScores.ux * weights.ux +
    rubricScores.completeness * weights.completeness
  );
}

function computeDeltaPercent(
  ours: number,
  baseline: number | null,
): number | null {
  if (baseline === null || baseline === 0) return null;
  return ((ours - baseline) / baseline) * 100;
}

// --- Public API ---

/**
 * Compares agent results against industry baselines from prompt frontmatter.
 * Only includes prompts where industry_baseline.source !== 'none'.
 */
export function compareWithBaselines(
  results: AgentResult[],
  prompts: Prompt[],
): BaselineComparison[] {
  const promptMap = new Map<string, Prompt>();
  for (const prompt of prompts) {
    promptMap.set(prompt.frontmatter.id, prompt);
  }

  const comparisons: BaselineComparison[] = [];

  for (const result of results) {
    const prompt = promptMap.get(result.prompt_id);
    if (!prompt) continue;

    const baseline = prompt.frontmatter.industry_baseline;
    if (baseline.source === 'none') continue;

    const ourQualityScore = computeWeightedQualityScore(result.rubric_scores);
    const notes = getBaselineNote(baseline.source, result.prompt_id);

    comparisons.push({
      promptId: result.prompt_id,
      promptTitle: prompt.frontmatter.title,
      arm: result.arm,
      ourCostUsd: result.cost_usd,
      baselineCostUsd: baseline.reference_cost_usd,
      costDeltaPercent: computeDeltaPercent(
        result.cost_usd,
        baseline.reference_cost_usd,
      ),
      ourDurationSeconds: result.wall_clock_seconds,
      baselineDurationSeconds: baseline.reference_duration_seconds,
      durationDeltaPercent: computeDeltaPercent(
        result.wall_clock_seconds,
        baseline.reference_duration_seconds,
      ),
      ourQualityScore,
      baselineArchitecture: baseline.reference_architecture,
      baselineSource: baseline.source,
      notes,
    });
  }

  return comparisons;
}

/**
 * Formats baseline comparisons into a markdown table.
 */
export function formatComparisonTable(
  comparisons: BaselineComparison[],
): string {
  if (comparisons.length === 0) {
    return '_No industry baseline comparisons available._';
  }

  const header = [
    '| Prompt | Arm | Our Cost | Baseline Cost | Cost Delta | Our Duration | Baseline Duration | Duration Delta | Quality | Baseline Arch | Source | Notes |',
    '|--------|-----|----------|---------------|------------|--------------|-------------------|----------------|---------|---------------|--------|-------|',
  ];

  const rows = comparisons.map((c) => {
    const costStr = `$${c.ourCostUsd.toFixed(2)}`;
    const baselineCostStr =
      c.baselineCostUsd !== null ? `$${c.baselineCostUsd.toFixed(2)}` : 'N/A';
    const costDeltaStr =
      c.costDeltaPercent !== null
        ? `${c.costDeltaPercent >= 0 ? '+' : ''}${c.costDeltaPercent.toFixed(1)}%`
        : 'N/A';
    const durationStr = `${c.ourDurationSeconds}s`;
    const baselineDurationStr =
      c.baselineDurationSeconds !== null
        ? `${c.baselineDurationSeconds}s`
        : 'N/A';
    const durationDeltaStr =
      c.durationDeltaPercent !== null
        ? `${c.durationDeltaPercent >= 0 ? '+' : ''}${c.durationDeltaPercent.toFixed(1)}%`
        : 'N/A';
    const qualityStr = c.ourQualityScore.toFixed(1);
    const archStr = c.baselineArchitecture ?? 'N/A';

    return `| ${c.promptId} | ${c.arm} | ${costStr} | ${baselineCostStr} | ${costDeltaStr} | ${durationStr} | ${baselineDurationStr} | ${durationDeltaStr} | ${qualityStr} | ${archStr} | ${c.baselineSource} | ${c.notes} |`;
  });

  return [...header, ...rows].join('\n');
}
