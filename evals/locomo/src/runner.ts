/**
 * Full evaluation orchestrator for the LoCoMo QA pipeline.
 *
 * Runs the QA pipeline across all 10 LoCoMo conversations with:
 *   - Checkpointing for fault tolerance (resume after interruptions)
 *   - Dual scoring: token-level F1 + LLM-as-a-Judge (separate passes)
 *   - Per-conversation progress tracking
 *
 * Architecture:
 *   1. QA Pass — search + answer + F1 for each question, checkpoint per conversation
 *   2. Judge Pass — LLM-as-a-Judge (N runs) for each question, checkpoint per conversation
 *   3. Aggregation — reporter generates EvalReport with comparison tables
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadDataset, getQuestionsForConversation } from "./dataset-loader.js";
import {
  searchForContext,
  formatSearchResultsAsContext,
  buildContextWindow,
} from "./qa/searcher.js";
import { answerQuestion } from "./qa/answerer.js";
import { computeTokenF1 } from "./scoring/f1.js";
import { judgeAnswerMultipleRuns } from "./scoring/judge.js";
import {
  aggregateF1ByCategory,
  computeOverallF1,
  aggregateJudgeByCategory,
  computeOverallJudge,
  computeLatencyStats,
} from "./scoring/reporter.js";
import { WorkerClient } from "./ingestion/worker-client.js";
import { generateProjectName } from "./ingestion/adapter.js";
import { LOCOMO_CATEGORY_MAP } from "./types.js";
import type {
  LoCoMoSample,
  QAResult,
  EvalReport,
  JudgeAggregation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKPOINTS_DIR = resolve(MODULE_DIR, "../results/checkpoints");

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EvalRunnerOptions {
  resumeFromCheckpoints: boolean;
  delayBetweenQACallsMs: number;
  delayBetweenJudgeCallsMs: number;
  searchLimit: number;
  maxQuestionsPerConversation: number | null;
  judgeRunsPerQuestion: number;
  skipJudgePass: boolean;
}

export const DEFAULT_EVAL_OPTIONS: EvalRunnerOptions = {
  resumeFromCheckpoints: true,
  delayBetweenQACallsMs: 500,
  delayBetweenJudgeCallsMs: 300,
  searchLimit: 10,
  maxQuestionsPerConversation: null,
  judgeRunsPerQuestion: 10,
  skipJudgePass: false,
};

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

export interface QAProgressEvent {
  conversationIndex: number;
  totalConversations: number;
  sampleId: string;
  questionIndex: number;
  totalQuestions: number;
  runningF1: number;
  searchLatencyMs: number;
  elapsedMs: number;
}

export interface JudgeProgressEvent {
  conversationIndex: number;
  totalConversations: number;
  sampleId: string;
  questionIndex: number;
  totalQuestions: number;
  runningJScore: number;
  runningJStdDev: number;
  elapsedMs: number;
}

export type ProgressCallback = {
  onQAProgress?: (event: QAProgressEvent) => void;
  onJudgeProgress?: (event: JudgeProgressEvent) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureCheckpointsDir(): void {
  if (!existsSync(CHECKPOINTS_DIR)) {
    mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  }
}

function qaCheckpointPath(sampleId: string): string {
  return resolve(CHECKPOINTS_DIR, `${sampleId}_qa.json`);
}

function judgeCheckpointPath(sampleId: string): string {
  return resolve(CHECKPOINTS_DIR, `${sampleId}_judge.json`);
}

function loadCheckpoint<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function saveCheckpoint(path: string, data: unknown): void {
  ensureCheckpointsDir();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Per-conversation QA pass
// ---------------------------------------------------------------------------

/**
 * Run QA for a single conversation: search + answer + F1 for each question.
 * Returns an array of QAResults with f1_score populated and judge_scores left null.
 */
export async function runEvalForConversation(
  conversation: LoCoMoSample,
  options: EvalRunnerOptions,
  workerClient?: WorkerClient,
): Promise<QAResult[]> {
  const questions = getQuestionsForConversation(conversation);
  const limitedQuestions = options.maxQuestionsPerConversation
    ? questions.slice(0, options.maxQuestionsPerConversation)
    : questions;

  const projectName = generateProjectName(conversation.sample_id);
  const client = workerClient ?? new WorkerClient();
  const results: QAResult[] = [];

  for (let i = 0; i < limitedQuestions.length; i++) {
    const qa = limitedQuestions[i];
    const categoryName = LOCOMO_CATEGORY_MAP[qa.category] ?? `unknown-${qa.category}`;
    const groundTruth = String(qa.answer);

    // 1. Search claude-mem for context
    const searchResponse = await searchForContext(
      qa.question,
      projectName,
      options.searchLimit,
      client,
    );

    const formattedContext = formatSearchResultsAsContext(searchResponse.observations);
    const contextWindow = buildContextWindow(formattedContext);

    // 2. Generate answer
    const answerResult = await answerQuestion(
      qa.question,
      contextWindow.context,
      categoryName,
    );

    // 3. Compute F1
    const f1Score = computeTokenF1(answerResult.predicted_answer, groundTruth);

    results.push({
      question: qa.question,
      predicted_answer: answerResult.predicted_answer,
      ground_truth_answer: groundTruth,
      category: categoryName,
      f1_score: f1Score,
      search_results_used: searchResponse.observations.length,
      search_latency_ms: searchResponse.search_latency_ms,
      answer_latency_ms: answerResult.answer_latency_ms,
      answer_input_tokens: answerResult.input_tokens,
      answer_output_tokens: answerResult.output_tokens,
    });

    // Rate limit delay (skip after last question)
    if (i < limitedQuestions.length - 1 && options.delayBetweenQACallsMs > 0) {
      await sleep(options.delayBetweenQACallsMs);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Judge scoring pass
// ---------------------------------------------------------------------------

/**
 * Run LLM-as-a-Judge scoring on QA results that don't already have judge_scores.
 * Returns the updated QAResults with judge_scores populated.
 */
export async function runJudgeScoringPass(
  results: QAResult[],
  options: EvalRunnerOptions,
): Promise<QAResult[]> {
  const updated = [...results];

  for (let i = 0; i < updated.length; i++) {
    if (updated[i].judge_scores) continue;

    try {
      const judgeAggregation = await judgeAnswerMultipleRuns(
        updated[i].question,
        updated[i].ground_truth_answer,
        updated[i].predicted_answer,
        updated[i].category,
        options.judgeRunsPerQuestion,
      );
      updated[i] = { ...updated[i], judge_scores: judgeAggregation };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[judge] Failed for question "${updated[i].question.slice(0, 60)}...": ${msg.slice(0, 100)}`,
      );
    }

    // Rate limit delay (skip after last)
    if (i < updated.length - 1 && options.delayBetweenJudgeCallsMs > 0) {
      await sleep(options.delayBetweenJudgeCallsMs);
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Full eval orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full evaluation across all 10 LoCoMo conversations.
 *
 * 1. Load dataset and verify ingestion
 * 2. QA Pass with per-conversation checkpointing
 * 3. Judge Pass with per-conversation checkpointing (unless skipped)
 * 4. Aggregate all results into an EvalReport
 */
export async function runFullEval(
  options: EvalRunnerOptions = DEFAULT_EVAL_OPTIONS,
  callbacks?: ProgressCallback,
  workerClient?: WorkerClient,
): Promise<EvalReport> {
  const dataset = loadDataset();
  const client = workerClient ?? new WorkerClient();
  const evalStartMs = performance.now();

  // Verify all conversations are ingested
  console.log("Verifying ingestion for all conversations...");
  for (const sample of dataset) {
    const projectName = generateProjectName(sample.sample_id);
    const { total } = await client.listObservationsByProject(projectName, 1);
    if (total === 0) {
      throw new Error(
        `Conversation ${sample.sample_id} has zero observations in project "${projectName}". ` +
          "Run ingestion first: bun evals/locomo/scripts/ingest-all.ts",
      );
    }
  }
  console.log(`All ${dataset.length} conversations verified.\n`);

  ensureCheckpointsDir();

  // ---- QA Pass ----
  const allQAResults: QAResult[][] = [];

  for (let convIdx = 0; convIdx < dataset.length; convIdx++) {
    const sample = dataset[convIdx];
    const checkpointFile = qaCheckpointPath(sample.sample_id);

    // Check for existing checkpoint
    if (options.resumeFromCheckpoints) {
      const cached = loadCheckpoint<QAResult[]>(checkpointFile);
      if (cached) {
        console.log(`[QA ${convIdx + 1}/${dataset.length}] ${sample.sample_id} — loaded from checkpoint (${cached.length} questions)`);
        allQAResults.push(cached);
        continue;
      }
    }

    // Run QA for this conversation
    const questions = getQuestionsForConversation(sample);
    const totalQuestions = options.maxQuestionsPerConversation
      ? Math.min(questions.length, options.maxQuestionsPerConversation)
      : questions.length;

    const convResults: QAResult[] = [];
    const projectName = generateProjectName(sample.sample_id);

    for (let qIdx = 0; qIdx < totalQuestions; qIdx++) {
      const qa = questions[qIdx];
      const categoryName = LOCOMO_CATEGORY_MAP[qa.category] ?? `unknown-${qa.category}`;
      const groundTruth = String(qa.answer);

      // Search
      const searchResponse = await searchForContext(
        qa.question,
        projectName,
        options.searchLimit,
        client,
      );

      const formattedContext = formatSearchResultsAsContext(searchResponse.observations);
      const contextWindow = buildContextWindow(formattedContext);

      // Answer
      const answerResult = await answerQuestion(
        qa.question,
        contextWindow.context,
        categoryName,
      );

      // F1
      const f1Score = computeTokenF1(answerResult.predicted_answer, groundTruth);

      const result: QAResult = {
        question: qa.question,
        predicted_answer: answerResult.predicted_answer,
        ground_truth_answer: groundTruth,
        category: categoryName,
        f1_score: f1Score,
        search_results_used: searchResponse.observations.length,
        search_latency_ms: searchResponse.search_latency_ms,
        answer_latency_ms: answerResult.answer_latency_ms,
        answer_input_tokens: answerResult.input_tokens,
        answer_output_tokens: answerResult.output_tokens,
      };

      convResults.push(result);

      // Progress callback
      const runningF1 = convResults.reduce((s, r) => s + r.f1_score, 0) / convResults.length;
      callbacks?.onQAProgress?.({
        conversationIndex: convIdx + 1,
        totalConversations: dataset.length,
        sampleId: sample.sample_id,
        questionIndex: qIdx + 1,
        totalQuestions,
        runningF1,
        searchLatencyMs: searchResponse.search_latency_ms,
        elapsedMs: Math.round(performance.now() - evalStartMs),
      });

      // Rate limit delay
      if (qIdx < totalQuestions - 1 && options.delayBetweenQACallsMs > 0) {
        await sleep(options.delayBetweenQACallsMs);
      }
    }

    // Save QA checkpoint immediately
    saveCheckpoint(checkpointFile, convResults);
    allQAResults.push(convResults);
  }

  // ---- Judge Pass ----
  if (!options.skipJudgePass) {
    for (let convIdx = 0; convIdx < dataset.length; convIdx++) {
      const sample = dataset[convIdx];
      const checkpointFile = judgeCheckpointPath(sample.sample_id);

      // Check for existing judge checkpoint
      if (options.resumeFromCheckpoints) {
        const cached = loadCheckpoint<QAResult[]>(checkpointFile);
        if (cached) {
          console.log(`[JUDGE ${convIdx + 1}/${dataset.length}] ${sample.sample_id} — loaded from checkpoint (${cached.length} questions)`);
          allQAResults[convIdx] = cached;
          continue;
        }
      }

      // Run judge scoring
      const qaResults = allQAResults[convIdx];
      const updated: QAResult[] = [...qaResults];

      for (let qIdx = 0; qIdx < updated.length; qIdx++) {
        if (updated[qIdx].judge_scores) continue;

        try {
          const judgeAggregation = await judgeAnswerMultipleRuns(
            updated[qIdx].question,
            updated[qIdx].ground_truth_answer,
            updated[qIdx].predicted_answer,
            updated[qIdx].category,
            options.judgeRunsPerQuestion,
          );
          updated[qIdx] = { ...updated[qIdx], judge_scores: judgeAggregation };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[judge] Failed for "${updated[qIdx].question.slice(0, 60)}...": ${msg.slice(0, 100)}`,
          );
        }

        // Progress callback
        const scoredSoFar = updated.filter((r) => r.judge_scores && r.judge_scores.mean_score >= 0);
        const runningJ = scoredSoFar.length > 0
          ? scoredSoFar.reduce((s, r) => s + r.judge_scores!.mean_score, 0) / scoredSoFar.length
          : 0;
        const runningStd = scoredSoFar.length > 0
          ? scoredSoFar.reduce((s, r) => s + r.judge_scores!.std_dev, 0) / scoredSoFar.length
          : 0;

        callbacks?.onJudgeProgress?.({
          conversationIndex: convIdx + 1,
          totalConversations: dataset.length,
          sampleId: sample.sample_id,
          questionIndex: qIdx + 1,
          totalQuestions: updated.length,
          runningJScore: runningJ,
          runningJStdDev: runningStd,
          elapsedMs: Math.round(performance.now() - evalStartMs),
        });

        // Rate limit delay
        if (qIdx < updated.length - 1 && options.delayBetweenJudgeCallsMs > 0) {
          await sleep(options.delayBetweenJudgeCallsMs);
        }
      }

      // Save judge checkpoint
      saveCheckpoint(checkpointFile, updated);
      allQAResults[convIdx] = updated;
    }
  }

  // ---- Aggregation ----
  const allResults = allQAResults.flat();
  return buildEvalReport(allResults, options);
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function buildEvalReport(results: QAResult[], options: EvalRunnerOptions): EvalReport {
  const perCategoryF1 = aggregateF1ByCategory(results);
  const overallF1 = computeOverallF1(results);
  const perCategoryJudge = aggregateJudgeByCategory(results);
  const overallJudge = computeOverallJudge(results);
  const latencyStats = computeLatencyStats(results);

  const totalInputTokens = results.reduce((s, r) => s + r.answer_input_tokens, 0);
  const totalOutputTokens = results.reduce((s, r) => s + r.answer_output_tokens, 0);
  const meanTokensPerQuestion =
    results.length > 0
      ? Math.round((totalInputTokens + totalOutputTokens) / results.length)
      : 0;

  const scoringMethods = ["f1"];
  if (!options.skipJudgePass) scoringMethods.push("llm-as-a-judge");

  return {
    results,
    per_category_f1_scores: perCategoryF1,
    overall_f1: overallF1,
    per_category_judge_scores: perCategoryJudge,
    overall_judge_score: {
      mean_score: overallJudge.mean_j,
      std_dev: overallJudge.pooled_std_dev,
      run_count: results.filter((r) => r.judge_scores?.run_count).reduce(
        (s, r) => s + (r.judge_scores?.run_count ?? 0),
        0,
      ),
      individual_scores: [],
    },
    latency_stats: latencyStats,
    token_stats: {
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      mean_tokens_per_question: meanTokensPerQuestion,
    },
    metadata: {
      model: "claude-opus-4-6",
      judge_model: "claude-sonnet-4-6",
      timestamp: new Date().toISOString(),
      total_questions: results.length,
      scoring_methods: scoringMethods,
    },
  };
}
