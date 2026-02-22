/**
 * Dataset loader for the LoCoMo evaluation harness.
 *
 * Reads locomo10.json, extracts sessions from dynamic keys,
 * enriches them with observations/summaries/events, and provides
 * filtered QA access with category-based exclusion.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type {
  LoCoMoSample,
  LoCoMoSession,
  LoCoMoTurn,
  LoCoMoQA,
  LoCoMoCategoryNumber,
  LoCoMoSessionObservation,
  LoCoMoSessionEvents,
} from "./types.js";
import { LOCOMO_CATEGORY_MAP } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = resolve(
  MODULE_DIR,
  "../data/locomo-repo/data/locomo10.json"
);

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

let cachedDataset: LoCoMoSample[] | null = null;

/** Load and parse the full locomo10.json dataset. Caches after first read. */
export function loadDataset(): LoCoMoSample[] {
  if (cachedDataset) return cachedDataset;

  const raw = readFileSync(DATASET_PATH, "utf-8");
  const parsed: LoCoMoSample[] = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Dataset at ${DATASET_PATH} is empty or not an array`);
  }

  cachedDataset = parsed;
  return parsed;
}

/** Return a single conversation by sample_id. Throws if not found. */
export function getConversation(sampleId: string): LoCoMoSample {
  const dataset = loadDataset();
  const sample = dataset.find((s) => s.sample_id === sampleId);
  if (!sample) {
    throw new Error(
      `Sample "${sampleId}" not found. Available: ${dataset.map((s) => s.sample_id).join(", ")}`
    );
  }
  return sample;
}

// ---------------------------------------------------------------------------
// Session extraction
// ---------------------------------------------------------------------------

/**
 * Extract sessions from a sample's conversation object and enrich with
 * observation, summary, and events data from the sample's top-level keys.
 *
 * Handles the dynamic key pattern:
 *   conversation.session_N       → turns array
 *   conversation.session_N_date_time → date string
 *   observation.session_N_observation → per-speaker observations
 *   session_summary.session_N_summary → summary string
 *   event_summary.events_session_N → per-speaker events
 */
export function getSessionsForConversation(
  sample: LoCoMoSample
): LoCoMoSession[] {
  const conversation = sample.conversation;

  // Find all session array keys (session_1, session_2, ...)
  const sessionKeys = Object.keys(conversation)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => {
      const numA = parseInt(a.replace("session_", ""), 10);
      const numB = parseInt(b.replace("session_", ""), 10);
      return numA - numB;
    });

  return sessionKeys.map((key) => {
    const sessionId = parseInt(key.replace("session_", ""), 10);
    const turns = conversation[key] as LoCoMoTurn[];
    const date = (conversation[`${key}_date_time`] as string) ?? "";

    // Resolve enrichment from top-level sample keys
    const observationKey = `session_${sessionId}_observation`;
    const summaryKey = `session_${sessionId}_summary`;
    const eventsKey = `events_session_${sessionId}`;

    const session: LoCoMoSession = {
      session_id: sessionId,
      date,
      turns,
    };

    if (sample.observation?.[observationKey]) {
      session.observation = sample.observation[
        observationKey
      ] as LoCoMoSessionObservation;
    }

    if (sample.session_summary?.[summaryKey]) {
      session.summary = sample.session_summary[summaryKey] as string;
    }

    if (sample.event_summary?.[eventsKey]) {
      session.events = sample.event_summary[
        eventsKey
      ] as LoCoMoSessionEvents;
    }

    return session;
  });
}

// ---------------------------------------------------------------------------
// QA access
// ---------------------------------------------------------------------------

const ADVERSARIAL_CATEGORY: LoCoMoCategoryNumber = 5;

interface QAFilterOptions {
  excludeCategories?: LoCoMoCategoryNumber[];
}

/**
 * Return QA questions for a sample, excluding adversarial by default
 * (for J-score comparison with Mem0/Zep/OpenAI baselines).
 */
export function getQuestionsForConversation(
  sample: LoCoMoSample,
  options?: QAFilterOptions
): LoCoMoQA[] {
  const excludeCategories = options?.excludeCategories ?? [
    ADVERSARIAL_CATEGORY,
  ];
  return sample.qa.filter((q) => !excludeCategories.includes(q.category));
}

/** Return ALL QA questions including adversarial (for F1-only analysis). */
export function getAllQuestionsForConversation(
  sample: LoCoMoSample
): LoCoMoQA[] {
  return sample.qa;
}

// ---------------------------------------------------------------------------
// Dataset statistics
// ---------------------------------------------------------------------------

interface CategoryStats {
  [categoryName: string]: number;
}

interface DatasetStats {
  conversation_count: number;
  total_sessions: number;
  total_qa_questions: number;
  qa_by_category: CategoryStats;
  qa_excluding_adversarial: number;
}

export function getDatasetStats(): DatasetStats {
  const dataset = loadDataset();

  let totalSessions = 0;
  let totalQA = 0;
  let adversarialCount = 0;
  const categoryCountsByName: CategoryStats = {};

  for (const sample of dataset) {
    // Count sessions by finding session_N keys in conversation
    const sessionKeys = Object.keys(sample.conversation).filter((k) =>
      /^session_\d+$/.test(k)
    );
    totalSessions += sessionKeys.length;

    for (const qa of sample.qa) {
      totalQA++;
      const categoryName =
        LOCOMO_CATEGORY_MAP[qa.category] ?? `unknown-${qa.category}`;
      categoryCountsByName[categoryName] =
        (categoryCountsByName[categoryName] ?? 0) + 1;

      if (qa.category === ADVERSARIAL_CATEGORY) {
        adversarialCount++;
      }
    }
  }

  return {
    conversation_count: dataset.length,
    total_sessions: totalSessions,
    total_qa_questions: totalQA,
    qa_by_category: categoryCountsByName,
    qa_excluding_adversarial: totalQA - adversarialCount,
  };
}
