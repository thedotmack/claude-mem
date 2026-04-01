import { writeFile } from 'node:fs/promises';
import type { AgentResult, Summary, SummaryStats } from './aggregator.js';
import type { BaselineComparison } from './baseline-compare.js';
import { generateSummary } from './aggregator.js';
import { formatComparisonTable } from './baseline-compare.js';

// --- Interfaces ---

export interface ReportConfig {
  resultsDir: string;
  results: AgentResult[];
  comparisons: BaselineComparison[];
  calibrationReport?: Record<string, unknown>;
}

// --- Helpers ---

function formatStats(stats: SummaryStats, decimals: number = 2): string {
  return `${stats.mean.toFixed(decimals)} +/- ${stats.stdDev.toFixed(decimals)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

// --- Report Sections ---

function generateExecutiveSummary(
  results: AgentResult[],
  summary: Summary,
): string {
  const totalAgents = summary.totalAgents;
  const completionRate = formatPercent(summary.completionRate);

  const allFunctionality = results.map(
    (r) => r.rubric_scores.functionality,
  );
  const averageQuality =
    allFunctionality.length > 0
      ? (
          allFunctionality.reduce((sum, v) => sum + v, 0) /
          allFunctionality.length
        ).toFixed(1)
      : 'N/A';

  const allCosts = results.map((r) => r.cost_usd);
  const averageCost =
    allCosts.length > 0
      ? formatDollars(
          allCosts.reduce((sum, v) => sum + v, 0) / allCosts.length,
        )
      : 'N/A';

  return [
    '## Executive Summary',
    '',
    `- **Total agents**: ${totalAgents}`,
    `- **Completion rate**: ${completionRate}`,
    `- **Average quality (functionality)**: ${averageQuality}/9`,
    `- **Average cost per agent**: ${averageCost}`,
    '',
  ].join('\n');
}

function generateMethodology(): string {
  return [
    '## Methodology',
    '',
    'Each agent was deployed in an isolated Docker container with a single Claude Code session. Agents in the claude-mem arm had the claude-mem plugin installed; vanilla agents ran without it. All agents used the same model version and received identical prompts. Smoke tests validated functional requirements; an LLM judge (blinded to arm assignment) scored outputs on functionality, code quality, UX, and completeness using a 1-9 rubric.',
    '',
  ].join('\n');
}

function generateArmComparisonTable(summary: Summary): string {
  if (summary.perArm.length === 0) {
    return '## Per-Arm Comparison\n\n_No arm data available._\n';
  }

  const header = [
    '| Metric | ' + summary.perArm.map((a) => a.arm).join(' | ') + ' |',
    '|--------|' + summary.perArm.map(() => '------').join('|') + '|',
  ];

  const metrics = [
    {
      label: 'Agent Count',
      values: summary.perArm.map((a) => String(a.agentCount)),
    },
    {
      label: 'Tokens (mean +/- std)',
      values: summary.perArm.map((a) => formatStats(a.tokens, 0)),
    },
    {
      label: 'Cost USD (mean +/- std)',
      values: summary.perArm.map((a) => formatStats(a.costUsd)),
    },
    {
      label: 'Wall Clock (mean +/- std)',
      values: summary.perArm.map((a) => formatStats(a.wallClockSeconds, 0)),
    },
    {
      label: 'Functionality (mean +/- std)',
      values: summary.perArm.map((a) => formatStats(a.rubricFunctionality, 1)),
    },
    {
      label: 'Code Quality (mean +/- std)',
      values: summary.perArm.map((a) => formatStats(a.rubricCodeQuality, 1)),
    },
    {
      label: 'UX (mean +/- std)',
      values: summary.perArm.map((a) => formatStats(a.rubricUx, 1)),
    },
    {
      label: 'Completeness (mean +/- std)',
      values: summary.perArm.map((a) => formatStats(a.rubricCompleteness, 1)),
    },
    {
      label: 'Smoke Pass Rate',
      values: summary.perArm.map((a) => formatPercent(a.smokePassRate)),
    },
  ];

  const rows = metrics.map(
    (m) => `| ${m.label} | ${m.values.join(' | ')} |`,
  );

  return [
    '## Per-Arm Comparison',
    '',
    ...header,
    ...rows,
    '',
  ].join('\n');
}

function generatePromptBreakdown(summary: Summary): string {
  if (summary.perPrompt.length === 0) {
    return '## Per-Prompt Breakdown\n\n_No prompt data available._\n';
  }

  const header = [
    '| Prompt ID | Category | Agents | Mean Cost | Mean Duration | Mean Functionality | Mean Completeness | Smoke Pass Rate |',
    '|-----------|----------|--------|-----------|---------------|--------------------|-------------------|-----------------|',
  ];

  const rows = summary.perPrompt.map((p) =>
    `| ${p.promptId} | ${p.promptCategory} | ${p.agentCount} | ${formatDollars(p.meanCostUsd)} | ${p.meanWallClockSeconds.toFixed(0)}s | ${p.meanFunctionality.toFixed(1)} | ${p.meanCompleteness.toFixed(1)} | ${formatPercent(p.smokePassRate)} |`,
  );

  return [
    '## Per-Prompt Breakdown',
    '',
    ...header,
    ...rows,
    '',
  ].join('\n');
}

function generateBaselineSection(
  comparisons: BaselineComparison[],
): string {
  return [
    '## Industry Baseline Comparison',
    '',
    formatComparisonTable(comparisons),
    '',
  ].join('\n');
}

function generateStatisticalNotes(summary: Summary): string {
  const lines = ['## Statistical Notes', ''];

  for (const arm of summary.perArm) {
    lines.push(`### ${arm.arm}`);
    lines.push('');
    lines.push(`- **Tokens**: mean=${arm.tokens.mean.toFixed(0)}, median=${arm.tokens.median.toFixed(0)}, p95=${arm.tokens.p95.toFixed(0)}, std=${arm.tokens.stdDev.toFixed(0)}`);
    lines.push(`- **Cost**: mean=${formatDollars(arm.costUsd.mean)}, median=${formatDollars(arm.costUsd.median)}, p95=${formatDollars(arm.costUsd.p95)}, std=${formatDollars(arm.costUsd.stdDev)}`);
    lines.push(`- **Wall Clock**: mean=${arm.wallClockSeconds.mean.toFixed(0)}s, median=${arm.wallClockSeconds.median.toFixed(0)}s, p95=${arm.wallClockSeconds.p95.toFixed(0)}s, std=${arm.wallClockSeconds.stdDev.toFixed(0)}s`);
    lines.push(`- **Functionality**: mean=${arm.rubricFunctionality.mean.toFixed(1)}, median=${arm.rubricFunctionality.median.toFixed(1)}, p95=${arm.rubricFunctionality.p95.toFixed(1)}, std=${arm.rubricFunctionality.stdDev.toFixed(1)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function generateCalibrationSection(
  calibrationReport?: Record<string, unknown>,
): string {
  if (!calibrationReport) return '';

  const lines = ['## Calibration Report Summary', ''];

  if (typeof calibrationReport.summary === 'string') {
    lines.push(calibrationReport.summary);
  } else if (calibrationReport.totalEvaluations !== undefined) {
    lines.push(`- **Total calibration evaluations**: ${calibrationReport.totalEvaluations}`);
    if (typeof calibrationReport.meanDrift === 'number') {
      lines.push(`- **Mean drift**: ${(calibrationReport.meanDrift as number).toFixed(2)}`);
    }
    if (typeof calibrationReport.maxDrift === 'number') {
      lines.push(`- **Max drift**: ${(calibrationReport.maxDrift as number).toFixed(2)}`);
    }
  } else {
    lines.push('Calibration data provided but no structured summary available.');
  }

  lines.push('');
  return lines.join('\n');
}

function generateKnownLimitations(): string {
  return [
    '## Known Limitations',
    '',
    '- Wall-clock time varies with API load and rate limiting; not a reliable performance metric for cross-run comparisons.',
    '- LLM judge scores are inherently subjective and may exhibit positional or anchoring biases despite blinding.',
    '- Smoke tests cover functional requirements but do not measure non-functional qualities like performance or accessibility.',
    '- Cache token counts depend on request ordering and concurrent usage, making exact reproduction difficult.',
    '- Industry baselines use different architectures (multi-agent pipelines vs single-agent), limiting direct comparability.',
    '',
  ].join('\n');
}

// --- Public API ---

/**
 * Generates a full markdown benchmark report from results and comparisons.
 */
export function generateReport(config: ReportConfig): string {
  const summary = generateSummary(config.results);

  const sections = [
    '# 200-Agent Benchmark Report',
    '',
    generateExecutiveSummary(config.results, summary),
    generateMethodology(),
    generateArmComparisonTable(summary),
    generateBaselineSection(config.comparisons),
    generatePromptBreakdown(summary),
    generateStatisticalNotes(summary),
    generateCalibrationSection(config.calibrationReport),
    generateKnownLimitations(),
  ];

  return sections.join('\n');
}

/**
 * Writes a report string to the specified output path.
 */
export async function writeReport(
  report: string,
  outputPath: string,
): Promise<void> {
  await writeFile(outputPath, report, 'utf-8');
}
