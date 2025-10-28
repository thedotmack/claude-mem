#!/usr/bin/env node

/**
 * Benchmark Runner for Claude-Mem Multi-Session Evaluation
 *
 * This script orchestrates the execution of benchmark scenarios,
 * managing session boundaries and collecting metrics.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BenchmarkScenario {
  id: string;
  name: string;
  tier: number;
  difficulty: string;
  estimatedTime: number;
  sessions: Session[];
  validation: Validation;
  metrics: MetricConfig;
}

interface Session {
  sessionNumber: number;
  title: string;
  prompt: string;
  contextDependencies: ContextDependency[];
  initialFiles: FileDefinition[];
  expectedOutputs: ExpectedOutput[];
  validationQuestions: ValidationQuestion[];
}

interface ContextDependency {
  type: string;
  description: string;
  fromSession: number;
  critical: boolean;
}

interface FileDefinition {
  path: string;
  content: string;
  description: string;
}

interface ExpectedOutput {
  type: string;
  description: string;
  validation: string;
}

interface ValidationQuestion {
  question: string;
  correctAnswer: string;
  contextSource: number;
  answerType: string;
  points: number;
}

interface Validation {
  testSuite: string;
  successCriteria: string[];
  qualityChecks: QualityCheck[];
}

interface QualityCheck {
  type: string;
  command: string;
  threshold: number;
}

interface MetricConfig {
  primary: string[];
  secondary: string[];
  custom?: CustomMetric[];
}

interface CustomMetric {
  name: string;
  description: string;
  calculation: string;
}

interface BenchmarkResult {
  scenarioId: string;
  group: 'control' | 'experimental';
  startTime: number;
  endTime?: number;
  sessions: SessionResult[];
  metrics: Record<string, number | string>;
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

class BenchmarkRunner {
  private scenario: BenchmarkScenario;
  private group: 'control' | 'experimental';
  private workspaceDir: string;
  private resultsDir: string;
  private result: BenchmarkResult;

  constructor(scenarioPath: string, group: 'control' | 'experimental') {
    // Load scenario
    const scenarioContent = fs.readFileSync(scenarioPath, 'utf-8');
    this.scenario = JSON.parse(scenarioContent);
    this.group = group;

    // Setup workspace
    const benchmarksRoot = path.join(__dirname, '..');
    this.workspaceDir = path.join(benchmarksRoot, 'workspaces', this.scenario.id, `${group}-${Date.now()}`);
    this.resultsDir = path.join(benchmarksRoot, 'results', group);

    // Initialize result
    this.result = {
      scenarioId: this.scenario.id,
      group: this.group,
      startTime: Date.now(),
      sessions: [],
      metrics: {},
      success: false
    };

    // Create directories
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.resultsDir, { recursive: true });
  }

  async run(): Promise<BenchmarkResult> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Starting Benchmark: ${this.scenario.name}`);
    console.log(`Group: ${this.group}`);
    console.log(`Estimated Time: ${this.scenario.estimatedTime} minutes`);
    console.log(`${'='.repeat(80)}\n`);

    try {
      // Run each session
      for (const session of this.scenario.sessions) {
        console.log(`\n${'-'.repeat(80)}`);
        console.log(`Session ${session.sessionNumber}: ${session.title}`);
        console.log(`${'-'.repeat(80)}\n`);

        const sessionResult = await this.runSession(session);
        this.result.sessions.push(sessionResult);

        // Wait between sessions to ensure clean session boundaries
        if (session.sessionNumber < this.scenario.sessions.length) {
          console.log('\nWaiting 5 seconds before next session...\n');
          await this.sleep(5000);
        }
      }

      // Run validation
      await this.runValidation();

      // Calculate metrics
      this.calculateMetrics();

      this.result.endTime = Date.now();
      this.result.success = true;

      // Save results
      this.saveResults();

      console.log(`\n${'='.repeat(80)}`);
      console.log(`Benchmark Complete!`);
      console.log(`Total Time: ${((this.result.endTime - this.result.startTime) / 1000 / 60).toFixed(2)} minutes`);
      console.log(`Success: ${this.result.success}`);
      console.log(`${'='.repeat(80)}\n`);

      return this.result;

    } catch (error) {
      this.result.endTime = Date.now();
      this.result.success = false;
      this.result.metrics['error'] = String(error);
      this.saveResults();
      throw error;
    }
  }

  private async runSession(session: Session): Promise<SessionResult> {
    const sessionStartTime = Date.now();

    // Create initial files for this session
    if (session.initialFiles.length > 0) {
      console.log(`Setting up ${session.initialFiles.length} initial files...`);
      for (const file of session.initialFiles) {
        const filePath = path.join(this.workspaceDir, file.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content);
        console.log(`  ✓ Created ${file.path}`);
      }
    }

    // Display context dependencies
    if (session.contextDependencies.length > 0) {
      console.log(`\nContext Dependencies (${session.contextDependencies.length}):`);
      for (const dep of session.contextDependencies) {
        const criticalMark = dep.critical ? '🔴' : '🟡';
        console.log(`  ${criticalMark} ${dep.type} from Session ${dep.fromSession}: ${dep.description}`);
      }
    }

    // Display the prompt
    console.log('\n' + '─'.repeat(80));
    console.log('PROMPT:');
    console.log('─'.repeat(80));
    console.log(session.prompt);
    console.log('─'.repeat(80) + '\n');

    // Write prompt to file for manual execution
    const promptFile = path.join(this.workspaceDir, `session-${session.sessionNumber}-prompt.txt`);
    fs.writeFileSync(promptFile, session.prompt);

    // Instructions for manual execution
    console.log('📋 MANUAL EXECUTION REQUIRED:');
    console.log('─'.repeat(80));
    console.log(`1. Open Claude Code in: ${this.workspaceDir}`);
    console.log(`2. ${this.group === 'experimental' ? 'Ensure claude-mem is installed' : 'Ensure claude-mem is NOT installed'}`);
    console.log(`3. Copy the prompt above and paste it into Claude Code`);
    console.log(`4. Work with Claude until the task is complete`);
    console.log(`5. Press ENTER here when done to continue...`);
    console.log('─'.repeat(80) + '\n');

    // Wait for user confirmation
    await this.waitForEnter();

    // Validate expected outputs
    console.log('\nValidating expected outputs...');
    for (const output of session.expectedOutputs) {
      const valid = await this.validateOutput(output);
      const mark = valid ? '✓' : '✗';
      console.log(`  ${mark} ${output.description}`);
    }

    // Ask validation questions
    const validationResults: ValidationResult[] = [];
    if (session.validationQuestions.length > 0) {
      console.log(`\n${'─'.repeat(80)}`);
      console.log('VALIDATION QUESTIONS (for context retention evaluation):');
      console.log('─'.repeat(80));

      for (const question of session.validationQuestions) {
        console.log(`\nQ: ${question.question}`);
        console.log(`Expected: ${question.correctAnswer}`);
        console.log('Enter actual answer from Claude (or press ENTER to skip):');

        const actualAnswer = await this.readLine();
        const correct = this.evaluateAnswer(actualAnswer, question.correctAnswer, question.answerType);

        validationResults.push({
          question: question.question,
          expectedAnswer: question.correctAnswer,
          actualAnswer,
          correct,
          points: question.points
        });

        console.log(correct ? '✓ Correct' : '✗ Incorrect');
      }
    }

    // Calculate context accuracy for this session
    const totalPoints = session.validationQuestions.reduce((sum, q) => sum + q.points, 0);
    const earnedPoints = validationResults
      .filter(r => r.correct)
      .reduce((sum, r) => sum + r.points, 0);
    const contextAccuracy = totalPoints > 0 ? (earnedPoints / totalPoints) * 100 : 100;

    const sessionEndTime = Date.now();

    return {
      sessionNumber: session.sessionNumber,
      startTime: sessionStartTime,
      endTime: sessionEndTime,
      validationResults,
      contextAccuracy,
      redundancyCount: 0 // TODO: Implement redundancy tracking
    };
  }

  private async validateOutput(output: ExpectedOutput): Promise<boolean> {
    try {
      const { execSync } = await import('child_process');
      execSync(output.validation, {
        cwd: this.workspaceDir,
        stdio: 'pipe'
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  private evaluateAnswer(actual: string, expected: string, answerType: string): boolean {
    if (!actual || actual.trim() === '') {
      return false;
    }

    const actualNorm = actual.toLowerCase().trim();
    const expectedNorm = expected.toLowerCase().trim();

    switch (answerType) {
      case 'exact':
        return actualNorm === expectedNorm;

      case 'semantic':
      case 'code_equivalent':
        // Simple semantic matching - check if expected is contained in actual
        return actualNorm.includes(expectedNorm) ||
               expectedNorm.includes(actualNorm);

      default:
        return actualNorm === expectedNorm;
    }
  }

  private async runValidation(): Promise<void> {
    console.log(`\n${'='.repeat(80)}`);
    console.log('FINAL VALIDATION');
    console.log(`${'='.repeat(80)}\n`);

    // Run test suite
    console.log(`Running test suite: ${this.scenario.validation.testSuite}`);
    try {
      const { execSync } = await import('child_process');
      const output = execSync(this.scenario.validation.testSuite, {
        cwd: this.workspaceDir,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      console.log('✓ Test suite passed');
      this.result.metrics['test_suite_passed'] = true;
    } catch (error: any) {
      console.log('✗ Test suite failed');
      this.result.metrics['test_suite_passed'] = false;
      console.log(error.stdout || error.message);
    }

    // Check success criteria
    console.log('\nSuccess Criteria:');
    for (const criteria of this.scenario.validation.successCriteria) {
      console.log(`  • ${criteria}`);
    }
  }

  private calculateMetrics(): void {
    // Context Accuracy (average across all sessions)
    const avgContextAccuracy = this.result.sessions.reduce((sum, s) => sum + s.contextAccuracy, 0) / this.result.sessions.length;
    this.result.metrics['context_accuracy'] = Math.round(avgContextAccuracy * 100) / 100;

    // Total Time
    if (this.result.endTime) {
      const totalMinutes = (this.result.endTime - this.result.startTime) / 1000 / 60;
      this.result.metrics['total_time_minutes'] = Math.round(totalMinutes * 100) / 100;
    }

    // Redundancy Score (total across all sessions)
    const totalRedundancy = this.result.sessions.reduce((sum, s) => sum + s.redundancyCount, 0);
    this.result.metrics['redundancy_count'] = totalRedundancy;

    // Resolution Status
    this.result.metrics['resolved'] = this.result.metrics['test_suite_passed'] ? 100 : 0;

    console.log(`\n${'='.repeat(80)}`);
    console.log('METRICS:');
    console.log(`${'='.repeat(80)}`);
    console.log(`Context Accuracy: ${this.result.metrics['context_accuracy']}%`);
    console.log(`Total Time: ${this.result.metrics['total_time_minutes']} minutes`);
    console.log(`Redundancy Count: ${this.result.metrics['redundancy_count']}`);
    console.log(`Resolved: ${this.result.metrics['resolved']}%`);
    console.log(`${'='.repeat(80)}\n`);
  }

  private saveResults(): void {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const filename = `${this.scenario.id}-${timestamp}.json`;
    const filepath = path.join(this.resultsDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(this.result, null, 2));
    console.log(`\n📊 Results saved to: ${filepath}\n`);
  }

  private async waitForEnter(): Promise<void> {
    return new Promise((resolve) => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  }

  private async readLine(): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          process.stdin.off('data', onData);
          resolve(data.trim());
        }
      };
      process.stdin.on('data', onData);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: npm run benchmark -- <scenario-path> <control|experimental>');
    console.error('\nExample:');
    console.error('  npm run benchmark -- benchmarks/scenarios/feature-evolution-auth.json experimental');
    process.exit(1);
  }

  const [scenarioPath, group] = args;

  if (group !== 'control' && group !== 'experimental') {
    console.error('Error: Group must be either "control" or "experimental"');
    process.exit(1);
  }

  if (!fs.existsSync(scenarioPath)) {
    console.error(`Error: Scenario file not found: ${scenarioPath}`);
    process.exit(1);
  }

  // Setup stdin for interactive mode
  process.stdin.setRawMode(false);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const runner = new BenchmarkRunner(scenarioPath, group);

  try {
    await runner.run();
    process.exit(0);
  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}

main();
