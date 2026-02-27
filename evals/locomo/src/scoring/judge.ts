/**
 * LLM-as-a-Judge scoring module for LoCoMo QA evaluation.
 *
 * Uses Claude Sonnet 4.6 as an impartial evaluator to score predicted answers
 * against ground truth on a 0-100 scale across four dimensions:
 *   - Factual accuracy
 *   - Completeness
 *   - Relevance
 *   - Contextual appropriateness
 *
 * Methodology follows Mem0 paper (arXiv 2504.19413, ECAI accepted):
 *   - 10 independent runs per question for statistical significance
 *   - Temperature 0.5 for variance across runs
 *   - Aggregated as mean ± stddev
 */

import Anthropic from "@anthropic-ai/sdk";
import type { JudgeResult, JudgeAggregation } from "../types.js";

// ---------------------------------------------------------------------------
// Singleton client (reuses connection across calls)
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

const JUDGE_MODEL = "claude-sonnet-4-6";

/**
 * Resolve the model name. When using OpenRouter (detected via ANTHROPIC_BASE_URL),
 * prefix with `anthropic/` if not already prefixed.
 */
function resolveModelName(model: string): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "";
  if (baseUrl.includes("openrouter.ai") && !model.includes("/")) {
    return `anthropic/${model}`;
  }
  return model;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are an impartial evaluator scoring a predicted answer against a ground truth answer.

Evaluate the predicted answer on four dimensions:
1. **Factual accuracy** — Is the predicted answer factually correct based on the ground truth?
2. **Completeness** — Does the prediction capture the key information from the ground truth?
3. **Relevance** — Is the answer relevant to the question asked?
4. **Contextual appropriateness** — Is the answer well-grounded in the conversation context?

Score from 0 to 100 where:
- 0 = completely wrong or irrelevant
- 50 = partially correct but missing key information
- 100 = fully correct and complete

Respond ONLY with a JSON object in this exact format:
{"score": <0-100>, "explanation": "<1-2 sentence rationale>"}`;

/**
 * Build the user prompt for a single judge evaluation.
 */
export function buildJudgePrompt(
  question: string,
  groundTruth: string,
  predictedAnswer: string,
  category: string
): string {
  return `Question: ${question}
Category: ${category}
Ground Truth Answer: ${groundTruth}
Predicted Answer: ${predictedAnswer}

Score the predicted answer against the ground truth. Respond with JSON only.`;
}

// ---------------------------------------------------------------------------
// Single judge call
// ---------------------------------------------------------------------------

/**
 * Run a single judge evaluation on a predicted answer.
 *
 * @param question - The QA question
 * @param groundTruth - The ground truth answer
 * @param predictedAnswer - The model's predicted answer
 * @param category - QA category (e.g., "single-hop", "temporal")
 * @param client - Optional Anthropic client override (for testing)
 */
export async function judgeAnswer(
  question: string,
  groundTruth: string,
  predictedAnswer: string,
  category: string,
  client?: Anthropic
): Promise<JudgeResult> {
  const api = client ?? getClient();
  const userPrompt = buildJudgePrompt(question, groundTruth, predictedAnswer, category);

  const response = await api.messages.create({
    model: resolveModelName(JUDGE_MODEL),
    max_tokens: 256,
    temperature: 0.5,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  // Attempt JSON parse
  try {
    const parsed = JSON.parse(responseText);
    if (typeof parsed.score === "number" && parsed.score >= 0 && parsed.score <= 100) {
      return {
        score: parsed.score,
        explanation: String(parsed.explanation ?? ""),
      };
    }
  } catch {
    // JSON parse failed — fall through to text extraction
  }

  // Fallback: try to extract a numeric score from the text
  const scoreMatch = responseText.match(/\b(\d{1,3})\b/);
  if (scoreMatch) {
    const extractedScore = parseInt(scoreMatch[1], 10);
    if (extractedScore >= 0 && extractedScore <= 100) {
      return {
        score: extractedScore,
        explanation: `Score extracted from malformed response: ${responseText.slice(0, 100)}`,
      };
    }
  }

  // Complete failure
  return {
    score: -1,
    explanation: `Failed to parse judge response: ${responseText.slice(0, 200)}`,
  };
}

// ---------------------------------------------------------------------------
// Multi-run aggregation
// ---------------------------------------------------------------------------

const DEFAULT_NUM_RUNS = 10;
const BATCH_SIZE = 3;

/**
 * Run the judge N times and aggregate results for statistical significance.
 *
 * Executes in batches of 3 to balance speed vs rate limits.
 * Filters out parse failures (score -1) before aggregation.
 * Logs a warning if fewer than 5 runs succeed.
 *
 * @param question - The QA question
 * @param groundTruth - The ground truth answer
 * @param predictedAnswer - The model's predicted answer
 * @param category - QA category
 * @param numRuns - Number of judge runs (default: 10)
 * @param client - Optional Anthropic client override (for testing)
 */
export async function judgeAnswerMultipleRuns(
  question: string,
  groundTruth: string,
  predictedAnswer: string,
  category: string,
  numRuns: number = DEFAULT_NUM_RUNS,
  client?: Anthropic
): Promise<JudgeAggregation> {
  const allResults: JudgeResult[] = [];

  // Execute in batches
  for (let i = 0; i < numRuns; i += BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE, numRuns - i);
    const batch = Array.from({ length: batchSize }, () =>
      judgeAnswer(question, groundTruth, predictedAnswer, category, client)
    );
    const batchResults = await Promise.all(batch);
    allResults.push(...batchResults);
  }

  // Filter out parse failures
  const successfulScores = allResults
    .filter((r) => r.score >= 0)
    .map((r) => r.score);

  if (successfulScores.length < 5) {
    console.warn(
      `[judge] Only ${successfulScores.length}/${numRuns} runs succeeded for question: "${question.slice(0, 60)}..."`
    );
  }

  if (successfulScores.length === 0) {
    return {
      mean_score: -1,
      std_dev: 0,
      run_count: 0,
      individual_scores: [],
    };
  }

  const mean = successfulScores.reduce((sum, s) => sum + s, 0) / successfulScores.length;

  const variance =
    successfulScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / successfulScores.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean_score: Math.round(mean * 100) / 100,
    std_dev: Math.round(stdDev * 100) / 100,
    run_count: successfulScores.length,
    individual_scores: successfulScores,
  };
}
