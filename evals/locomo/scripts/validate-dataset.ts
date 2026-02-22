/**
 * Validate the LoCoMo dataset by loading it and printing stats.
 *
 * Usage: bun evals/locomo/scripts/validate-dataset.ts
 */

import {
  loadDataset,
  getDatasetStats,
  getSessionsForConversation,
  getQuestionsForConversation,
  getAllQuestionsForConversation,
} from "../src/dataset-loader.js";
import { LOCOMO_CATEGORY_MAP } from "../src/types.js";

// ---------------------------------------------------------------------------
// Load and validate
// ---------------------------------------------------------------------------

console.log("Loading LoCoMo dataset...\n");
const dataset = loadDataset();
const stats = getDatasetStats();

// ---------------------------------------------------------------------------
// Dataset overview
// ---------------------------------------------------------------------------

console.log("=== LoCoMo Dataset Overview ===\n");
console.log(`  Conversations:       ${stats.conversation_count}`);
console.log(`  Total sessions:      ${stats.total_sessions}`);
console.log(`  Total QA questions:  ${stats.total_qa_questions}`);
console.log(
  `  QA excl. adversarial: ${stats.qa_excluding_adversarial}  (used for J-score comparison)\n`
);

// ---------------------------------------------------------------------------
// QA by category
// ---------------------------------------------------------------------------

console.log("=== QA Questions by Category ===\n");
console.log("  Category          Count   Pct");
console.log("  ────────────────  ──────  ─────");

const sortedCategories = Object.entries(stats.qa_by_category).sort(
  ([, a], [, b]) => b - a
);

for (const [category, count] of sortedCategories) {
  const pct = ((count / stats.total_qa_questions) * 100).toFixed(1);
  const label = category.padEnd(16);
  const countStr = String(count).padStart(6);
  const isAdversarial = category === "adversarial";
  const note = isAdversarial ? "  ← excluded from J-score" : "";
  console.log(`  ${label}  ${countStr}  ${pct.padStart(5)}%${note}`);
}

console.log();

// ---------------------------------------------------------------------------
// Per-conversation breakdown
// ---------------------------------------------------------------------------

console.log("=== Per-Conversation Breakdown ===\n");
console.log("  Sample ID    Sessions  QA Total  QA (excl. adv)");
console.log("  ───────────  ────────  ────────  ──────────────");

for (const sample of dataset) {
  const sessions = getSessionsForConversation(sample);
  const allQA = getAllQuestionsForConversation(sample);
  const filteredQA = getQuestionsForConversation(sample);

  const id = sample.sample_id.padEnd(11);
  const sessCount = String(sessions.length).padStart(8);
  const qaCount = String(allQA.length).padStart(8);
  const filteredCount = String(filteredQA.length).padStart(14);

  console.log(`  ${id}  ${sessCount}  ${qaCount}  ${filteredCount}`);
}

console.log();

// ---------------------------------------------------------------------------
// Session enrichment spot-check (first conversation)
// ---------------------------------------------------------------------------

const firstSample = dataset[0];
const sessions = getSessionsForConversation(firstSample);
const withObs = sessions.filter((s) => s.observation);
const withSummary = sessions.filter((s) => s.summary);
const withEvents = sessions.filter((s) => s.events);

console.log(`=== Enrichment Spot-Check (${firstSample.sample_id}) ===\n`);
console.log(`  Sessions extracted:  ${sessions.length}`);
console.log(`  With observations:   ${withObs.length}`);
console.log(`  With summaries:      ${withSummary.length}`);
console.log(`  With events:         ${withEvents.length}`);
console.log(`  First session date:  "${sessions[0]?.date}"`);
console.log(`  First session turns: ${sessions[0]?.turns.length}`);

console.log("\n✓ Dataset validation complete.");
