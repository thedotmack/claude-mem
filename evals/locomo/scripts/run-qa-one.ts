/**
 * QA prototype script — runs the QA pipeline on the first LoCoMo conversation.
 *
 * Loads the first conversation, gets up to 20 non-adversarial QA questions,
 * searches claude-mem for context, and generates answers with Opus 4.6.
 *
 * Auth: Uses ANTHROPIC_API_KEY if set. Otherwise falls back to OpenRouter
 * via the key in ~/.claude-mem/settings.json (sets ANTHROPIC_BASE_URL and
 * ANTHROPIC_API_KEY automatically).
 *
 * Usage: bun evals/locomo/scripts/run-qa-one.ts
 *
 * Prerequisites: Worker must be running at localhost:37777.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import {
  loadDataset,
  getQuestionsForConversation,
} from "../src/dataset-loader.js";
import { generateProjectName } from "../src/ingestion/adapter.js";
import {
  searchForContext,
  formatSearchResultsAsContext,
  buildContextWindow,
} from "../src/qa/searcher.js";
import { answerQuestion } from "../src/qa/answerer.js";
import { LOCOMO_CATEGORY_MAP } from "../src/types.js";
import { WorkerClient } from "../src/ingestion/worker-client.js";

// ---------------------------------------------------------------------------
// Auth setup — fall back to OpenRouter when no Anthropic API key is set
// ---------------------------------------------------------------------------

function ensureAnthropicAuth(): void {
  if (process.env.ANTHROPIC_API_KEY) return;

  // Read OpenRouter API key from claude-mem settings
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
    // Settings file not found or unreadable — fall through
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

const MAX_QUESTIONS = 20;
const SEARCH_RESULT_LIMIT = 10;
const API_DELAY_MS = 500;
const WORKER_BASE_URL = "http://localhost:37777";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(MODULE_DIR, "../results");
const RESULTS_FILE = resolve(RESULTS_DIR, "qa-prototype-results.json");

// ---------------------------------------------------------------------------
// Types
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
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Check worker health
  try {
    const healthResponse = await fetch(`${WORKER_BASE_URL}/api/health`);
    if (!healthResponse.ok) throw new Error("unhealthy");
  } catch {
    console.error(
      "Worker is not running at localhost:37777.\n" +
        "Start it with: bun plugin/scripts/worker-service.cjs start"
    );
    process.exit(1);
  }
  console.log("Worker is running.\n");

  // 2. Load first conversation
  const dataset = loadDataset();
  const sample = dataset[0];
  const projectName = generateProjectName(sample.sample_id);

  console.log(`Conversation: ${sample.sample_id} (project: ${projectName})`);

  // 3. Get QA questions (excludes adversarial by default), limit to 20
  const allQuestions = getQuestionsForConversation(sample);
  const questions = allQuestions.slice(0, MAX_QUESTIONS);

  console.log(
    `QA questions: ${questions.length} (of ${allQuestions.length} non-adversarial)\n`
  );

  // 4. Create shared worker client
  const client = new WorkerClient(WORKER_BASE_URL);

  // 5. Process each question
  const results: PrototypeResult[] = [];

  for (let i = 0; i < questions.length; i++) {
    const qa = questions[i];
    const categoryName = LOCOMO_CATEGORY_MAP[qa.category] ?? `unknown-${qa.category}`;
    const groundTruth = String(qa.answer);

    // 5a. Search for context
    const searchResponse = await searchForContext(
      qa.question,
      projectName,
      SEARCH_RESULT_LIMIT,
      client
    );

    // 5b. Build context window
    const formattedContext = formatSearchResultsAsContext(
      searchResponse.observations
    );
    const contextWindow = buildContextWindow(formattedContext);

    // 5c. Generate answer
    const answerResult = await answerQuestion(
      qa.question,
      contextWindow.context,
      categoryName
    );

    // 5d. Record result
    const result: PrototypeResult = {
      question: qa.question,
      category: categoryName,
      predicted_answer: answerResult.predicted_answer,
      ground_truth: groundTruth,
      search_results_count: searchResponse.observations.length,
      search_latency_ms: searchResponse.search_latency_ms,
      answer_latency_ms: answerResult.answer_latency_ms,
      answer_input_tokens: answerResult.input_tokens,
      answer_output_tokens: answerResult.output_tokens,
    };
    results.push(result);

    // 5e. Log one line
    console.log(
      `${categoryName} | Q: ${truncate(qa.question, 60)} | Pred: ${truncate(answerResult.predicted_answer, 40)} | Truth: ${truncate(groundTruth, 40)} | search: ${searchResponse.search_latency_ms}ms | answer: ${answerResult.answer_latency_ms}ms`
    );

    // 5f. Rate limit delay (skip after last question)
    if (i < questions.length - 1) {
      await sleep(API_DELAY_MS);
    }
  }

  // 6. Save results
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${RESULTS_FILE}`);

  // 7. Print summary
  const searchLatencies = results.map((r) => r.search_latency_ms);
  const answerLatencies = results.map((r) => r.answer_latency_ms);
  const totalTokensPerQuestion = results.map(
    (r) => r.answer_input_tokens + r.answer_output_tokens
  );

  // Category breakdown
  const categoryBreakdown: Record<string, number> = {};
  for (const r of results) {
    categoryBreakdown[r.category] = (categoryBreakdown[r.category] ?? 0) + 1;
  }

  console.log("\n=== QA Prototype Summary ===");
  console.log(`Total questions answered: ${results.length}`);
  console.log("\nCategory breakdown:");
  for (const [cat, count] of Object.entries(categoryBreakdown)) {
    console.log(`  ${cat}: ${count}`);
  }

  console.log("\nSample predictions vs ground truth:");
  const sampleResults = results.slice(0, 3);
  for (const r of sampleResults) {
    console.log(`  [${r.category}] Q: ${truncate(r.question, 60)}`);
    console.log(`    Predicted: ${truncate(r.predicted_answer, 80)}`);
    console.log(`    Truth:     ${truncate(r.ground_truth, 80)}`);
  }

  console.log("\nLatency summary:");
  console.log(
    `  Search — mean: ${Math.round(mean(searchLatencies))}ms, p95: ${Math.round(percentile(searchLatencies, 95))}ms`
  );
  console.log(
    `  Answer — mean: ${Math.round(mean(answerLatencies))}ms, p95: ${Math.round(percentile(answerLatencies, 95))}ms`
  );
  console.log(
    `  Tokens/question — mean: ${Math.round(mean(totalTokensPerQuestion))}`
  );
}

main().catch((err) => {
  console.error("QA prototype failed:", err.message ?? err);
  process.exit(1);
});
