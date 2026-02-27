/**
 * Score the Phase 03 prototype results with both F1 and LLM-as-a-Judge.
 *
 * Loads prototype results from `evals/locomo/results/qa-prototype-results.json`,
 * applies token-level F1 scoring, then runs LLM-as-a-Judge (10 runs per question)
 * for statistical significance. Outputs dual comparison tables against published
 * baselines.
 *
 * Auth: Uses ANTHROPIC_API_KEY if set. Otherwise falls back to OpenRouter
 * via the key in ~/.claude-mem/settings.json.
 *
 * Usage: bun evals/locomo/scripts/score-prototype.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import {
  scoreResultsF1,
  aggregateF1ByCategory,
  computeOverallF1,
  formatFullReport,
} from "../src/scoring/reporter.js";
import { judgeAnswerMultipleRuns } from "../src/scoring/judge.js";
import type { QAResult } from "../src/types.js";

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

ensureAnthropicAuth();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JUDGE_RUNS_PER_QUESTION = 10;
const DELAY_BETWEEN_QUESTIONS_MS = 200;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(MODULE_DIR, "../results");
const PROTOTYPE_RESULTS_FILE = resolve(RESULTS_DIR, "qa-prototype-results.json");
const SCORED_RESULTS_FILE = resolve(RESULTS_DIR, "qa-prototype-scored.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Prototype result shape (from run-qa-one.ts output)
// ---------------------------------------------------------------------------

interface PrototypeResult {
  question: string;
  category: string;
  predicted_answer: string;
  ground_truth: string;
  search_results_count: number;
  search_latency_ms: number;
  answer_latency_ms: number;
  answer_input_tokens: number;
  answer_output_tokens: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Load prototype results
  if (!existsSync(PROTOTYPE_RESULTS_FILE)) {
    console.error(`Prototype results not found: ${PROTOTYPE_RESULTS_FILE}`);
    console.error("Run the QA pipeline first: bun evals/locomo/scripts/run-qa-one.ts");
    process.exit(1);
  }

  const rawResults: PrototypeResult[] = JSON.parse(
    readFileSync(PROTOTYPE_RESULTS_FILE, "utf-8")
  );
  console.log(`Loaded ${rawResults.length} prototype results.\n`);

  // 2. F1 scoring
  console.log("=== F1 Scoring ===\n");
  const f1Results = scoreResultsF1(rawResults);

  // Map back the fields that scoreResultsF1 doesn't carry from the raw shape
  for (let i = 0; i < f1Results.length; i++) {
    f1Results[i].search_results_used = rawResults[i].search_results_count;
    f1Results[i].search_latency_ms = rawResults[i].search_latency_ms;
    f1Results[i].answer_latency_ms = rawResults[i].answer_latency_ms;
    f1Results[i].answer_input_tokens = rawResults[i].answer_input_tokens;
    f1Results[i].answer_output_tokens = rawResults[i].answer_output_tokens;
  }

  const catF1 = aggregateF1ByCategory(f1Results);
  const overallF1 = computeOverallF1(f1Results);

  console.log(`Overall F1: ${(overallF1 * 100).toFixed(2)}%`);
  for (const [cat, stats] of Object.entries(catF1)) {
    console.log(
      `  ${cat}: ${(stats.mean_f1 * 100).toFixed(2)}% (n=${stats.count}, min=${(stats.min_f1 * 100).toFixed(2)}%, max=${(stats.max_f1 * 100).toFixed(2)}%)`
    );
  }
  console.log();

  // 3. LLM-as-a-Judge scoring (10 runs per question)
  console.log("=== LLM-as-a-Judge Scoring ===\n");
  console.log(
    `Running ${JUDGE_RUNS_PER_QUESTION} judge evaluations per question (${rawResults.length} questions = ~${rawResults.length * JUDGE_RUNS_PER_QUESTION} API calls)...\n`
  );

  let judgeFailures = 0;
  for (let i = 0; i < f1Results.length; i++) {
    const r = f1Results[i];
    const startTime = Date.now();

    try {
      const judgeAggregation = await judgeAnswerMultipleRuns(
        r.question,
        r.ground_truth_answer,
        r.predicted_answer,
        r.category,
        JUDGE_RUNS_PER_QUESTION
      );

      f1Results[i].judge_scores = judgeAggregation;

      const elapsed = Date.now() - startTime;
      console.log(
        `  [${i + 1}/${f1Results.length}] ${r.category} | J=${judgeAggregation.mean_score.toFixed(1)} ±${judgeAggregation.std_dev.toFixed(1)} (${judgeAggregation.run_count} runs, ${elapsed}ms) | "${r.question.slice(0, 50)}..."`
      );
    } catch (err: unknown) {
      judgeFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [${i + 1}/${f1Results.length}] FAILED: ${msg.slice(0, 100)}`
      );
    }

    // Rate limit delay between questions (skip after last)
    if (i < f1Results.length - 1) {
      await sleep(DELAY_BETWEEN_QUESTIONS_MS);
    }
  }

  if (judgeFailures > 0) {
    console.warn(`\n${judgeFailures}/${f1Results.length} questions failed judge scoring (API errors).`);
  }

  console.log();

  // 4. Save scored results
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
  writeFileSync(SCORED_RESULTS_FILE, JSON.stringify(f1Results, null, 2));
  console.log(`Scored results saved to: ${SCORED_RESULTS_FILE}\n`);

  // 5. Print full report
  console.log("=".repeat(72));
  console.log();
  console.log(formatFullReport(f1Results));
  console.log();
  console.log("=".repeat(72));
  console.log(
    "\nNote: Prototype only (~20 questions from 1 conversation). Full eval in Phase 05."
  );
}

main().catch((err) => {
  console.error("Scoring failed:", err.message ?? err);
  process.exit(1);
});
