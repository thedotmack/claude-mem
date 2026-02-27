/**
 * QA answer generator for the LoCoMo evaluation pipeline.
 *
 * Calls Anthropic's Claude API to produce short, extractive answers
 * from search-retrieved context. Instruments latency and token usage.
 */

import Anthropic from "@anthropic-ai/sdk";
import { QA_SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnswerResult {
  predicted_answer: string;
  input_tokens: number;
  output_tokens: number;
  answer_latency_ms: number;
}

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
// Answer generation
// ---------------------------------------------------------------------------

/**
 * Generate an extractive answer for a LoCoMo QA question using Claude.
 *
 * @param question - The QA question to answer
 * @param context  - Formatted context string from search results
 * @param category - QA category name (e.g. "single-hop", "temporal")
 * @param client   - Optional Anthropic client override (for testing)
 */
export async function answerQuestion(
  question: string,
  context: string,
  category: string,
  client?: Anthropic
): Promise<AnswerResult> {
  const api = client ?? getClient();
  const userPrompt = buildUserPrompt(question, context, category);

  const startMs = performance.now();

  const response = await api.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 256,
    temperature: 0,
    system: QA_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const answerLatencyMs = Math.round(performance.now() - startMs);

  // Extract text from content blocks
  const predictedAnswer = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return {
    predicted_answer: predictedAnswer || "unanswerable",
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    answer_latency_ms: answerLatencyMs,
  };
}
