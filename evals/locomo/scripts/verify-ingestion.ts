/**
 * Verify ingested LoCoMo data by searching claude-mem and displaying results.
 *
 * Usage: bun evals/locomo/scripts/verify-ingestion.ts
 *
 * Prerequisites: Worker must be running at localhost:37777 with ingested data.
 */

import { loadDataset, getQuestionsForConversation } from "../src/dataset-loader.js";
import { WorkerClient, type SearchObservationResult } from "../src/ingestion/worker-client.js";
import { generateProjectName } from "../src/ingestion/adapter.js";
import { LOCOMO_CATEGORY_MAP, type LoCoMoCategoryNumber } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKER_BASE_URL = "http://localhost:37777";
const HEALTH_ENDPOINT = `${WORKER_BASE_URL}/api/health`;

// Categories to pick for verification (in priority order)
const DESIRED_CATEGORIES: LoCoMoCategoryNumber[] = [1, 3, 2]; // single-hop, multi-hop, temporal

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkWorkerHealth(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT);
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string | null | undefined, maxLength: number): string {
  if (!text) return "(empty)";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

/**
 * Pick up to 3 QA questions from different categories.
 * Selects one from each desired category (single-hop, multi-hop, temporal).
 * Skips adversarial.
 */
function pickVerificationQuestions(
  sample: ReturnType<typeof loadDataset>[0]
) {
  const questions = getQuestionsForConversation(sample); // excludes adversarial by default
  const picked: typeof questions = [];
  const usedCategories = new Set<LoCoMoCategoryNumber>();

  for (const desiredCategory of DESIRED_CATEGORIES) {
    if (picked.length >= 3) break;
    const match = questions.find(
      (q) => q.category === desiredCategory && !usedCategories.has(q.category)
    );
    if (match) {
      picked.push(match);
      usedCategories.add(desiredCategory);
    }
  }

  // If we still need more, fill from remaining non-adversarial questions
  for (const q of questions) {
    if (picked.length >= 3) break;
    if (!usedCategories.has(q.category)) {
      picked.push(q);
      usedCategories.add(q.category);
    }
  }

  return picked;
}

function formatSearchResult(result: SearchObservationResult, index: number): string {
  const title = result.title ?? "(untitled)";
  const narrative = truncate(result.narrative, 80);
  return `      ${index}. ${title} — ${narrative}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Check worker is running
  const workerHealthy = await checkWorkerHealth();
  if (!workerHealthy) {
    console.error(
      "Worker is not running at localhost:37777.\n" +
        "Start it with: bun plugin/scripts/worker-service.cjs start"
    );
    process.exit(1);
  }

  // 2. Load first conversation
  const dataset = loadDataset();
  const sample = dataset[0];
  const projectName = generateProjectName(sample.sample_id);

  console.log(`Verifying ingestion for conversation: ${sample.sample_id}`);
  console.log(`Project: ${projectName}\n`);

  const client = new WorkerClient(WORKER_BASE_URL);

  // 3. Search for all observations under this project
  console.log("=== Ingested Observations ===\n");

  const allObservations = await client.search("*", projectName, 100);
  const observations = allObservations.observations;

  console.log(`Total observations found: ${observations.length}\n`);

  for (const obs of observations) {
    const title = obs.title ?? "(untitled)";
    const narrative = truncate(obs.narrative, 100);
    console.log(`  - ${title}`);
    console.log(`    ${narrative}\n`);
  }

  // 4. Pick 3 QA questions for verification
  const verificationQuestions = pickVerificationQuestions(sample);

  console.log("=== QA Search Verification ===\n");

  for (const qa of verificationQuestions) {
    const categoryName = LOCOMO_CATEGORY_MAP[qa.category] ?? `unknown-${qa.category}`;

    // Search with the question text scoped to the project
    const searchResults = await client.search(qa.question, projectName, 3);

    console.log(`Q: ${qa.question}`);
    console.log(`Category: ${categoryName}`);
    console.log(`Ground Truth: ${qa.answer}`);
    console.log(`Top Search Results:`);

    if (searchResults.observations.length === 0) {
      console.log("      (no results found)");
    } else {
      for (let i = 0; i < searchResults.observations.length; i++) {
        console.log(formatSearchResult(searchResults.observations[i], i + 1));
      }
    }

    console.log(`Search latency: ${searchResults.search_latency_ms}ms`);
    console.log();
  }

  console.log("=== Verification Complete ===");
}

main().catch((err) => {
  console.error("Verification failed:", err.message ?? err);
  process.exit(1);
});
