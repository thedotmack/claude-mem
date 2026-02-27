/**
 * QA prompt templates for the LoCoMo evaluation pipeline.
 *
 * Provides a system prompt for extractive QA and category-specific
 * user prompts that guide Claude's answer generation.
 */

import type { LoCoMoCategoryName } from "../types.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const QA_SYSTEM_PROMPT = `You are an expert question-answering assistant. Answer based ONLY on the provided conversation context.

Rules:
- Give short, extractive answers — not full sentences.
- Pull exact phrases or facts from the context when possible.
- If the context does not contain sufficient information to answer, respond with exactly "unanswerable".
- Do not fabricate or infer information not present in the context.`;

// ---------------------------------------------------------------------------
// Category-specific instruction hints
// ---------------------------------------------------------------------------

const CATEGORY_HINTS: Record<LoCoMoCategoryName, string> = {
  "single-hop":
    "Answer using a specific piece of evidence from the context.",
  "multi-hop":
    "This may require combining information from multiple conversation sessions.",
  temporal:
    "Pay careful attention to dates and the temporal ordering of events.",
  "open-domain":
    "You may use both the provided context and general knowledge.",
  adversarial:
    "Be careful — verify claims against the context before answering. The question may contain false premises.",
};

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the user message with the context block, category hint, and question.
 */
export function buildUserPrompt(
  question: string,
  context: string,
  category: string
): string {
  const categoryName = category as LoCoMoCategoryName;
  const hint =
    CATEGORY_HINTS[categoryName] ??
    "Answer using the provided context.";

  return `<context>
${context}
</context>

Category hint: ${hint}

Question: ${question}`;
}
