/**
 * Full LoCoMo evaluation runner.
 *
 * Orchestrates the complete QA + Judge scoring pipeline across all 10 LoCoMo
 * conversations using the eval runner from src/runner.ts. Supports checkpointing,
 * rolling progress output, and configurable CLI options.
 *
 * Auth: Uses ANTHROPIC_API_KEY if set. Otherwise falls back to OpenRouter
 * via the key in ~/.claude-mem/settings.json.
 *
 * Usage: bun evals/locomo/scripts/full-eval.ts [options]
 *
 * Options:
 *   --no-resume          Ignore existing checkpoints, start fresh
 *   --qa-delay <ms>      Milliseconds between QA API calls (default: 500)
 *   --judge-delay <ms>   Milliseconds between judge batches (default: 300)
 *   --conversation <id>  Run only one specific conversation (for debugging)
 *   --limit <n>          Max questions per conversation (default: all)
 *   --skip-judge         Skip the J-scoring pass entirely
 *   --judge-runs <n>     Number of judge runs per question (default: 10)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import {
  runFullEval,
  DEFAULT_EVAL_OPTIONS,
} from "../src/runner.js";
import type {
  EvalRunnerOptions,
  QAProgressEvent,
  JudgeProgressEvent,
} from "../src/runner.js";
import type {
  EvalReport,
  CategoryF1Stats,
  CategoryJudgeStats,
  LatencyStats,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Auth setup — fall back to OpenRouter when no Anthropic API key is set
// ---------------------------------------------------------------------------

function ensureAnthropicAuth(): void {
  if (process.env.ANTHROPIC_API_KEY) return;

  const settingsPath = resolve(homedir(), ".claude-mem", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const openRouterKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY;
    if (openRouterKey) {
      process.env.ANTHROPIC_API_KEY = openRouterKey;
      process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
      console.log("Auth: Using OpenRouter (no ANTHROPIC_API_KEY set)\n");
      return;
    }
  } catch {
    // Settings file not found or unreadable
  }

  console.error(
    "No Anthropic API key found.\n" +
      "Set ANTHROPIC_API_KEY or configure CLAUDE_MEM_OPENROUTER_API_KEY in ~/.claude-mem/settings.json"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  noResume: boolean;
  qaDelay: number;
  judgeDelay: number;
  conversation: string | null;
  limit: number | null;
  skipJudge: boolean;
  judgeRuns: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    noResume: false,
    qaDelay: 500,
    judgeDelay: 300,
    conversation: null,
    limit: null,
    skipJudge: false,
    judgeRuns: 10,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--no-resume":
        args.noResume = true;
        break;
      case "--qa-delay":
        args.qaDelay = parseInt(argv[++i], 10);
        if (isNaN(args.qaDelay) || args.qaDelay < 0) {
          console.error("--qa-delay requires a non-negative number");
          process.exit(1);
        }
        break;
      case "--judge-delay":
        args.judgeDelay = parseInt(argv[++i], 10);
        if (isNaN(args.judgeDelay) || args.judgeDelay < 0) {
          console.error("--judge-delay requires a non-negative number");
          process.exit(1);
        }
        break;
      case "--conversation":
        args.conversation = argv[++i];
        if (!args.conversation) {
          console.error("--conversation requires a sample_id");
          process.exit(1);
        }
        break;
      case "--limit":
        args.limit = parseInt(argv[++i], 10);
        if (isNaN(args.limit) || args.limit < 1) {
          console.error("--limit requires a positive number");
          process.exit(1);
        }
        break;
      case "--skip-judge":
        args.skipJudge = true;
        break;
      case "--judge-runs":
        args.judgeRuns = parseInt(argv[++i], 10);
        if (isNaN(args.judgeRuns) || args.judgeRuns < 1) {
          console.error("--judge-runs requires a positive number");
          process.exit(1);
        }
        break;
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function padNum(value: number | string, width: number): string {
  return String(value).padStart(width);
}

function printF1Table(
  perCategoryF1: Record<string, CategoryF1Stats>,
  overallF1: number,
): void {
  const categories = ["single-hop", "multi-hop", "temporal", "open-domain"];
  console.log("=== F1 Scores ===");
  console.log("Category     | Count | Mean F1 | Min  | Max");
  console.log("-------------+-------+---------+------+------");

  for (const cat of categories) {
    const stats = perCategoryF1[cat];
    if (!stats) continue;
    console.log(
      `${pad(cat, 13)}| ${padNum(stats.count, 5)} | ${padNum((stats.mean_f1 * 100).toFixed(1) + "%", 7)} | ${padNum((stats.min_f1 * 100).toFixed(0) + "%", 4)} | ${padNum((stats.max_f1 * 100).toFixed(0) + "%", 4)}`
    );
  }

  const totalCount = Object.values(perCategoryF1).reduce((s, v) => s + v.count, 0);
  console.log(
    `${pad("OVERALL", 13)}| ${padNum(totalCount, 5)} | ${padNum((overallF1 * 100).toFixed(1) + "%", 7)} |      |`
  );
  console.log();
}

function printJudgeTable(
  perCategoryJudge: Record<string, CategoryJudgeStats>,
  overallJudge: { mean_score: number; std_dev: number },
): void {
  const categories = ["single-hop", "multi-hop", "temporal", "open-domain"];
  console.log("=== LLM-as-a-Judge Scores ===");
  console.log("Category     | Count | Mean J  | ±Std");
  console.log("-------------+-------+---------+------");

  for (const cat of categories) {
    const stats = perCategoryJudge[cat];
    if (!stats) continue;
    console.log(
      `${pad(cat, 13)}| ${padNum(stats.count, 5)} | ${padNum(stats.mean_j.toFixed(2), 7)} | ±${stats.std_dev.toFixed(2)}`
    );
  }

  const totalCount = Object.values(perCategoryJudge).reduce((s, v) => s + v.count, 0);
  console.log(
    `${pad("OVERALL", 13)}| ${padNum(totalCount, 5)} | ${padNum(overallJudge.mean_score.toFixed(2), 7)} | ±${overallJudge.std_dev.toFixed(2)}`
  );
  console.log();
}

function printLatencyTable(
  latencyStats: LatencyStats,
  tokenStats: { total_input_tokens: number; total_output_tokens: number; mean_tokens_per_question: number },
  totalQuestions: number,
): void {
  console.log("=== Latency & Efficiency ===");
  console.log(
    `Search p50: ${latencyStats.search_p50_ms}ms | Search p95: ${latencyStats.search_p95_ms}ms`
  );
  console.log(
    `Answer p50: ${latencyStats.answer_p50_ms}ms | Answer p95: ${latencyStats.answer_p95_ms}ms`
  );
  console.log(
    `Total  p50: ${latencyStats.total_p50_ms}ms | Total  p95: ${latencyStats.total_p95_ms}ms`
  );

  const meanInput = totalQuestions > 0
    ? Math.round(tokenStats.total_input_tokens / totalQuestions)
    : 0;
  const meanOutput = totalQuestions > 0
    ? Math.round(tokenStats.total_output_tokens / totalQuestions)
    : 0;

  console.log(
    `Mean tokens/question: ${meanInput.toLocaleString()} (input) + ${meanOutput.toLocaleString()} (output)`
  );
  console.log(
    `Total API tokens consumed: ${(tokenStats.total_input_tokens + tokenStats.total_output_tokens).toLocaleString()}`
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureAnthropicAuth();

  const cliArgs = parseArgs(Bun.argv.slice(2));

  // Build options from CLI args
  const options: EvalRunnerOptions = {
    ...DEFAULT_EVAL_OPTIONS,
    resumeFromCheckpoints: !cliArgs.noResume,
    delayBetweenQACallsMs: cliArgs.qaDelay,
    delayBetweenJudgeCallsMs: cliArgs.judgeDelay,
    maxQuestionsPerConversation: cliArgs.limit,
    skipJudgePass: cliArgs.skipJudge,
    judgeRunsPerQuestion: cliArgs.judgeRuns,
  };

  // Print configuration
  console.log("╔════════════════════════════════════════════╗");
  console.log("║     LoCoMo Full Evaluation Runner          ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log();
  console.log(`Resume from checkpoints: ${options.resumeFromCheckpoints}`);
  console.log(`QA delay: ${options.delayBetweenQACallsMs}ms`);
  console.log(`Judge delay: ${options.delayBetweenJudgeCallsMs}ms`);
  console.log(`Search limit: ${options.searchLimit}`);
  console.log(`Max questions/conversation: ${options.maxQuestionsPerConversation ?? "all"}`);
  console.log(`Judge runs/question: ${options.judgeRunsPerQuestion}`);
  console.log(`Skip judge pass: ${options.skipJudgePass}`);
  if (cliArgs.conversation) {
    console.log(`Single conversation: ${cliArgs.conversation}`);
  }
  console.log();

  const evalStartTime = performance.now();

  // Progress callbacks for rolling output
  const callbacks = {
    onQAProgress: (event: QAProgressEvent) => {
      console.log(
        `[QA ${event.conversationIndex}/${event.totalConversations}] ${event.sampleId} — ` +
          `Q ${event.questionIndex}/${event.totalQuestions} — ` +
          `F1: ${event.runningF1.toFixed(3)} — ` +
          `search: ${event.searchLatencyMs}ms — ` +
          `Elapsed: ${formatElapsed(event.elapsedMs)}`
      );
    },
    onJudgeProgress: (event: JudgeProgressEvent) => {
      console.log(
        `[JUDGE ${event.conversationIndex}/${event.totalConversations}] ${event.sampleId} — ` +
          `Q ${event.questionIndex}/${event.totalQuestions} — ` +
          `J: ${event.runningJScore.toFixed(1)}±${event.runningJStdDev.toFixed(1)} — ` +
          `Elapsed: ${formatElapsed(event.elapsedMs)}`
      );
    },
  };

  // Run the eval
  let report: EvalReport;
  try {
    report = await runFullEval(options, callbacks);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nEvaluation failed: ${msg}`);
    process.exit(1);
  }

  // Save results with timestamp
  const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
  const RESULTS_DIR = resolve(MODULE_DIR, "../results");
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
  const resultsFilePath = resolve(RESULTS_DIR, `eval-results-${timestamp}.json`);
  writeFileSync(resultsFilePath, JSON.stringify(report, null, 2));
  console.log(`\nResults saved to: ${resultsFilePath}\n`);

  // Print final summary
  console.log("=".repeat(60));
  console.log();

  printF1Table(report.per_category_f1_scores, report.overall_f1);
  printJudgeTable(report.per_category_judge_scores, report.overall_judge_score);
  printLatencyTable(
    report.latency_stats,
    report.token_stats,
    report.metadata.total_questions,
  );

  const totalElapsed = performance.now() - evalStartTime;
  console.log("=".repeat(60));
  console.log(`Total time: ${formatElapsed(totalElapsed)}`);
  console.log(`Total questions: ${report.metadata.total_questions}`);
  console.log(`Scoring methods: ${report.metadata.scoring_methods.join(", ")}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err.message ?? err);
    process.exit(1);
  });
}
