#!/usr/bin/env node

/**
 * Benchmark Results Analyzer
 *
 * Compares control vs experimental group results and generates reports
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BenchmarkResult {
  scenarioId: string;
  group: 'control' | 'experimental';
  startTime: number;
  endTime?: number;
  sessions: SessionResult[];
  metrics: Record<string, number | string | boolean>;
  success: boolean;
}

interface SessionResult {
  sessionNumber: number;
  startTime: number;
  endTime: number;
  validationResults: ValidationResult[];
  contextAccuracy: number;
  redundancyCount: number;
}

interface ValidationResult {
  question: string;
  expectedAnswer: string;
  actualAnswer: string;
  correct: boolean;
  points: number;
}

interface ComparisonReport {
  scenarioId: string;
  timestamp: string;
  control: GroupStats;
  experimental: GroupStats;
  improvements: Improvements;
  conclusion: string;
}

interface GroupStats {
  runs: number;
  avgContextAccuracy: number;
  avgTime: number;
  avgRedundancy: number;
  resolvedRate: number;
  successRate: number;
}

interface Improvements {
  contextAccuracy: number;
  time: number;
  redundancy: number;
  resolvedRate: number;
  successRate: number;
}

class BenchmarkAnalyzer {
  private resultsDir: string;

  constructor() {
    this.resultsDir = path.join(__dirname, '..', 'results');
  }

  analyze(scenarioId?: string): void {
    console.log('\n' + '='.repeat(80));
    console.log('BENCHMARK RESULTS ANALYSIS');
    console.log('='.repeat(80) + '\n');

    // Load all results
    const controlResults = this.loadResults('control', scenarioId);
    const experimentalResults = this.loadResults('experimental', scenarioId);

    if (controlResults.length === 0 && experimentalResults.length === 0) {
      console.log('No results found. Run benchmarks first.');
      return;
    }

    // Group by scenario
    const scenarios = new Set([
      ...controlResults.map(r => r.scenarioId),
      ...experimentalResults.map(r => r.scenarioId)
    ]);

    const reports: ComparisonReport[] = [];

    for (const scenario of scenarios) {
      const controlForScenario = controlResults.filter(r => r.scenarioId === scenario);
      const experimentalForScenario = experimentalResults.filter(r => r.scenarioId === scenario);

      const report = this.compareScenario(scenario, controlForScenario, experimentalForScenario);
      reports.push(report);
      this.printReport(report);
    }

    // Save combined report
    this.saveCombinedReport(reports);
  }

  private loadResults(group: 'control' | 'experimental', scenarioId?: string): BenchmarkResult[] {
    const groupDir = path.join(this.resultsDir, group);

    if (!fs.existsSync(groupDir)) {
      return [];
    }

    const files = fs.readdirSync(groupDir)
      .filter(f => f.endsWith('.json'));

    return files
      .map(file => {
        const content = fs.readFileSync(path.join(groupDir, file), 'utf-8');
        return JSON.parse(content) as BenchmarkResult;
      })
      .filter(result => !scenarioId || result.scenarioId === scenarioId);
  }

  private compareScenario(
    scenarioId: string,
    control: BenchmarkResult[],
    experimental: BenchmarkResult[]
  ): ComparisonReport {
    const controlStats = this.calculateStats(control);
    const experimentalStats = this.calculateStats(experimental);

    const improvements: Improvements = {
      contextAccuracy: experimentalStats.avgContextAccuracy - controlStats.avgContextAccuracy,
      time: ((controlStats.avgTime - experimentalStats.avgTime) / controlStats.avgTime) * 100,
      redundancy: controlStats.avgRedundancy - experimentalStats.avgRedundancy,
      resolvedRate: experimentalStats.resolvedRate - controlStats.resolvedRate,
      successRate: experimentalStats.successRate - controlStats.successRate
    };

    const conclusion = this.generateConclusion(improvements);

    return {
      scenarioId,
      timestamp: new Date().toISOString(),
      control: controlStats,
      experimental: experimentalStats,
      improvements,
      conclusion
    };
  }

  private calculateStats(results: BenchmarkResult[]): GroupStats {
    if (results.length === 0) {
      return {
        runs: 0,
        avgContextAccuracy: 0,
        avgTime: 0,
        avgRedundancy: 0,
        resolvedRate: 0,
        successRate: 0
      };
    }

    const contextAccuracies = results.map(r => Number(r.metrics.context_accuracy) || 0);
    const times = results.map(r => Number(r.metrics.total_time_minutes) || 0);
    const redundancies = results.map(r => Number(r.metrics.redundancy_count) || 0);
    const resolutions = results.map(r => Number(r.metrics.resolved) || 0);
    const successes = results.map(r => r.success ? 100 : 0);

    return {
      runs: results.length,
      avgContextAccuracy: this.average(contextAccuracies),
      avgTime: this.average(times),
      avgRedundancy: this.average(redundancies),
      resolvedRate: this.average(resolutions),
      successRate: this.average(successes)
    };
  }

  private average(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  }

  private generateConclusion(improvements: Improvements): string {
    const positives: string[] = [];
    const negatives: string[] = [];

    if (improvements.contextAccuracy > 5) {
      positives.push(`${improvements.contextAccuracy.toFixed(1)}% better context retention`);
    } else if (improvements.contextAccuracy < -5) {
      negatives.push(`${Math.abs(improvements.contextAccuracy).toFixed(1)}% worse context retention`);
    }

    if (improvements.time > 10) {
      positives.push(`${improvements.time.toFixed(1)}% faster completion`);
    } else if (improvements.time < -10) {
      negatives.push(`${Math.abs(improvements.time).toFixed(1)}% slower completion`);
    }

    if (improvements.redundancy > 1) {
      positives.push(`${improvements.redundancy.toFixed(0)} fewer redundant questions`);
    } else if (improvements.redundancy < -1) {
      negatives.push(`${Math.abs(improvements.redundancy).toFixed(0)} more redundant questions`);
    }

    if (improvements.resolvedRate > 5) {
      positives.push(`${improvements.resolvedRate.toFixed(1)}% higher resolution rate`);
    }

    if (positives.length === 0 && negatives.length === 0) {
      return 'No significant differences observed between control and experimental groups.';
    }

    let conclusion = 'Claude-mem (experimental group) shows ';

    if (positives.length > 0) {
      conclusion += positives.join(', ');
      if (negatives.length > 0) {
        conclusion += ' but ' + negatives.join(', ');
      }
    } else {
      conclusion += negatives.join(', ');
    }

    conclusion += ' compared to the control group.';

    return conclusion;
  }

  private printReport(report: ComparisonReport): void {
    console.log('─'.repeat(80));
    console.log(`Scenario: ${report.scenarioId}`);
    console.log('─'.repeat(80));

    // Control group stats
    console.log('\n📊 Control Group (without claude-mem):');
    console.log(`  Runs: ${report.control.runs}`);
    console.log(`  Context Accuracy: ${report.control.avgContextAccuracy.toFixed(2)}%`);
    console.log(`  Avg Time: ${report.control.avgTime.toFixed(2)} minutes`);
    console.log(`  Avg Redundancy: ${report.control.avgRedundancy.toFixed(2)}`);
    console.log(`  Resolution Rate: ${report.control.resolvedRate.toFixed(2)}%`);
    console.log(`  Success Rate: ${report.control.successRate.toFixed(2)}%`);

    // Experimental group stats
    console.log('\n🧪 Experimental Group (with claude-mem):');
    console.log(`  Runs: ${report.experimental.runs}`);
    console.log(`  Context Accuracy: ${report.experimental.avgContextAccuracy.toFixed(2)}%`);
    console.log(`  Avg Time: ${report.experimental.avgTime.toFixed(2)} minutes`);
    console.log(`  Avg Redundancy: ${report.experimental.avgRedundancy.toFixed(2)}`);
    console.log(`  Resolution Rate: ${report.experimental.resolvedRate.toFixed(2)}%`);
    console.log(`  Success Rate: ${report.experimental.successRate.toFixed(2)}%`);

    // Improvements
    console.log('\n📈 Improvements (Experimental vs Control):');
    const contextDiff = report.improvements.contextAccuracy;
    const contextSymbol = contextDiff > 0 ? '↑' : contextDiff < 0 ? '↓' : '→';
    console.log(`  ${contextSymbol} Context Accuracy: ${contextDiff > 0 ? '+' : ''}${contextDiff.toFixed(2)}%`);

    const timeDiff = report.improvements.time;
    const timeSymbol = timeDiff > 0 ? '↑' : timeDiff < 0 ? '↓' : '→';
    console.log(`  ${timeSymbol} Time Saved: ${timeDiff > 0 ? '+' : ''}${timeDiff.toFixed(2)}%`);

    const redundancyDiff = report.improvements.redundancy;
    const redundancySymbol = redundancyDiff > 0 ? '↑' : redundancyDiff < 0 ? '↓' : '→';
    console.log(`  ${redundancySymbol} Redundancy Reduction: ${redundancyDiff > 0 ? '+' : ''}${redundancyDiff.toFixed(2)}`);

    const resolvedDiff = report.improvements.resolvedRate;
    const resolvedSymbol = resolvedDiff > 0 ? '↑' : resolvedDiff < 0 ? '↓' : '→';
    console.log(`  ${resolvedSymbol} Resolution Rate: ${resolvedDiff > 0 ? '+' : ''}${resolvedDiff.toFixed(2)}%`);

    // Conclusion
    console.log('\n💡 Conclusion:');
    console.log(`  ${report.conclusion}`);
    console.log('');
  }

  private saveCombinedReport(reports: ComparisonReport[]): void {
    const analysisDir = path.join(this.resultsDir, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const filename = `comparison-${timestamp}.json`;
    const filepath = path.join(analysisDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(reports, null, 2));
    console.log(`\n📊 Analysis saved to: ${filepath}\n`);

    // Generate markdown report
    this.generateMarkdownReport(reports, analysisDir, timestamp);
  }

  private generateMarkdownReport(reports: ComparisonReport[], dir: string, timestamp: string): void {
    let markdown = '# Claude-Mem Benchmark Results\n\n';
    markdown += `Generated: ${new Date().toISOString()}\n\n`;

    markdown += '## Summary\n\n';
    markdown += '| Scenario | Context Accuracy Δ | Time Saved | Redundancy Δ | Resolution Rate Δ |\n';
    markdown += '|----------|-------------------|------------|--------------|------------------|\n';

    for (const report of reports) {
      markdown += `| ${report.scenarioId} `;
      markdown += `| ${report.improvements.contextAccuracy > 0 ? '+' : ''}${report.improvements.contextAccuracy.toFixed(1)}% `;
      markdown += `| ${report.improvements.time > 0 ? '+' : ''}${report.improvements.time.toFixed(1)}% `;
      markdown += `| ${report.improvements.redundancy > 0 ? '+' : ''}${report.improvements.redundancy.toFixed(1)} `;
      markdown += `| ${report.improvements.resolvedRate > 0 ? '+' : ''}${report.improvements.resolvedRate.toFixed(1)}% |\n`;
    }

    markdown += '\n## Detailed Results\n\n';

    for (const report of reports) {
      markdown += `### ${report.scenarioId}\n\n`;
      markdown += `**Conclusion**: ${report.conclusion}\n\n`;

      markdown += '#### Control Group (without claude-mem)\n\n';
      markdown += `- Runs: ${report.control.runs}\n`;
      markdown += `- Context Accuracy: ${report.control.avgContextAccuracy.toFixed(2)}%\n`;
      markdown += `- Avg Time: ${report.control.avgTime.toFixed(2)} minutes\n`;
      markdown += `- Avg Redundancy: ${report.control.avgRedundancy.toFixed(2)}\n`;
      markdown += `- Resolution Rate: ${report.control.resolvedRate.toFixed(2)}%\n\n`;

      markdown += '#### Experimental Group (with claude-mem)\n\n';
      markdown += `- Runs: ${report.experimental.runs}\n`;
      markdown += `- Context Accuracy: ${report.experimental.avgContextAccuracy.toFixed(2)}%\n`;
      markdown += `- Avg Time: ${report.experimental.avgTime.toFixed(2)} minutes\n`;
      markdown += `- Avg Redundancy: ${report.experimental.avgRedundancy.toFixed(2)}\n`;
      markdown += `- Resolution Rate: ${report.experimental.resolvedRate.toFixed(2)}%\n\n`;
    }

    markdown += '## Methodology\n\n';
    markdown += 'These benchmarks evaluate Claude-mem\'s persistent memory system by comparing ';
    markdown += 'multi-session coding tasks with and without the plugin installed.\n\n';
    markdown += '**Key Metrics**:\n';
    markdown += '- **Context Accuracy**: Percentage of correct answers to validation questions about previous sessions\n';
    markdown += '- **Time Saved**: Reduction in total completion time\n';
    markdown += '- **Redundancy**: Reduction in repeated questions for the same information\n';
    markdown += '- **Resolution Rate**: Percentage of tasks completed successfully\n\n';

    const markdownPath = path.join(dir, `comparison-${timestamp}.md`);
    fs.writeFileSync(markdownPath, markdown);
    console.log(`📄 Markdown report saved to: ${markdownPath}\n`);
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const scenarioId = args[0]; // Optional: filter by scenario

  const analyzer = new BenchmarkAnalyzer();
  analyzer.analyze(scenarioId);
}

main();
